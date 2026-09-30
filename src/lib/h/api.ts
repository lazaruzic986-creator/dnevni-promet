import { createHash, randomBytes } from "node:crypto";
import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { getSql, withTransaction } from "@/lib/db";
import { businessDate } from "./day.ts";
import { seedDemo, wipeDemo } from "./demo.ts";
import {
  type Actor,
  type InvoiceLineIn,
  type Sql,
  loadActor,
  payInvoice,
  postInvoice,
  postOpening,
  saveAlias,
  saveArticle,
  savePack,
  saveSupplier,
  setupOrg,
  upsertInvoice,
  voidInvoice,
  audit,
} from "./engine.ts";
import {
  addCashMove,
  closeShift,
  correctShift,
  expectedCashOf,
  openShift,
  postCount,
  postProduction,
  postRefund,
  postSale,
  postWaste,
  realizeOrder,
  saveExpense,
  saveOrder,
  saveProduct,
  saveRecipe,
  setCountQty,
  snapshot,
  startCount,
  takeAdvance,
  voidSale,
} from "./engine-ops.ts";
import { mStr, m } from "./money.ts";
import { assertCan, defaultPerms, normalizePerms, type PermKey, type Perms, type Role } from "./perms.ts";
import { runProof } from "./proof.ts";

type Body = Record<string, unknown>;

/** Jedan objekat, bez prijave. Važi samo kad nema sesije. Ko je prijavljen, ostaje taj nalog. */
const OPEN_USER_ID = "objekat";

const openMiddleware = createMiddleware({ type: "function" })
  .client(async ({ next }) => {
    const { getBearerToken } = await import("@/lib/auth/client");
    return next({ sendContext: { bearerToken: getBearerToken() ?? undefined } });
  })
  .server(async ({ next, context }) => {
    const { assertSameSiteRequest } = await import("@/lib/auth/isolation.server");
    const { requireUserId, UnauthorizedError } = await import("@/lib/auth/verify.server");
    assertSameSiteRequest();
    try {
      const userId = await requireUserId(context.bearerToken);
      return next({ context: { userId } });
    } catch (err) {
      if (err instanceof UnauthorizedError) return next({ context: { userId: OPEN_USER_ID } });
      throw err;
    }
  });

function str(body: Body, key: string, fallback = ""): string {
  const v = body[key];
  if (v == null) return fallback;
  return String(v).trim();
}
function opt(body: Body, key: string): string | null {
  const v = str(body, key);
  return v ? v : null;
}
function flag(body: Body, key: string): boolean {
  return body[key] === true || body[key] === "true";
}

async function profile(sql: Sql, userId: string): Promise<{ email: string | null; name: string | null }> {
  try {
    const rows = await sql.query<{ email: string | null; name: string | null }>(
      `select email, name from "user" where id = $1`,
      [userId],
    );
    return rows[0] ?? { email: null, name: null };
  } catch {
    return { email: null, name: null };
  }
}

function allow(actor: Actor, key: PermKey, write: boolean) {
  assertCan(actor.role, actor.permissions, key, write);
}

const ROLL = Symbol.for("dpu.proof.rollback");

async function actorOrThrow(sql: Sql, userId: string): Promise<Actor> {
  const actor = await loadActor(sql, userId);
  if (!actor) throw new Error("Nalog nije povezan sa objektom.");
  return actor;
}

function filled(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}

function invoiceLines(body: Body): InvoiceLineIn[] {
  if (!Array.isArray(body.lines)) return [];
  return body.lines.map((row) => {
    const r = (row ?? {}) as Body;
    const rawName = filled(r.rawName);
    const qty = filled(r.qty);
    const unitName = filled(r.unitName);
    const label = rawName || "stavka";
    if (!qty) throw new Error(`„${label}“ nema količinu. Nula nije upisana.`);
    if (!unitName) throw new Error(`„${label}“ nema jedinicu. Komad nije pretpostavljen.`);
    if (!rawName && !r.articleId) throw new Error("Stavka računa nema naziv. Nije nazvana nagađanjem.");
    return {
      articleId: r.articleId ? String(r.articleId) : null,
      rawName,
      qty,
      unitName,
      unitPrice: r.unitPrice == null || r.unitPrice === "" ? null : String(r.unitPrice),
      discount: filled(r.discount) || "0",
      lineTotal: r.lineTotal == null || r.lineTotal === "" ? null : String(r.lineTotal),
      taxRate: r.taxRate ? String(r.taxRate) : null,
      needsReview: Boolean(r.needsReview),
      expiry: r.expiry ? String(r.expiry) : null,
    };
  });
}

async function runAct(sql: Sql, userId: string, op: string, body: Body): Promise<unknown> {
  if (op === "setup") {
    const who = await profile(sql, userId);
    if (body.endHour == null || String(body.endHour).trim() === "" || Number.isNaN(Number(body.endHour))) {
      throw new Error("Unesite do kog časa traje poslovni dan.");
    }
    const initialCash = str(body, "initialCash");
    if (!initialCash) throw new Error("Početni novac u kasi nije unet. Ako je fioka prazna, upišite 0.");
    return setupOrg(sql, { userId, email: who.email, name: who.name ?? str(body, "yourName") }, {
      name: str(body, "name"),
      legalName: opt(body, "legalName"),
      pib: opt(body, "pib"),
      mb: opt(body, "mb"),
      address: opt(body, "address"),
      city: opt(body, "city"),
      phone: opt(body, "phone"),
      endHour: Number(body.endHour),
      taxMode: str(body, "taxMode", "ukljucen"),
      initialCash,
      openingDate: opt(body, "openingDate"),
    });
  }
  const actor = await actorOrThrow(sql, userId);
  switch (op) {
    case "saveSettings": {
      allow(actor, "podesavanja", true);
      if (body.endHour == null || String(body.endHour).trim() === "" || Number.isNaN(Number(body.endHour))) {
        throw new Error("Unesite do kog časa traje poslovni dan.");
      }
      await sql.query(
        `update orgs set name=$1, legal_name=$2, pib=$3, address=$4, city=$5, phone=$6,
         business_day_end_hour=$7, tax_mode=$8, auto_post_invoices=$9, locked_through=$10 where id=$11`,
        [
          str(body, "name"),
          opt(body, "legalName"),
          opt(body, "pib"),
          opt(body, "address"),
          opt(body, "city"),
          opt(body, "phone"),
          Number(body.endHour),
          str(body, "taxMode", "ukljucen"),
          flag(body, "autoPost"),
          opt(body, "lockedThrough"),
          actor.orgId,
        ],
      );
      await audit(sql, actor.orgId, actor.userId, "podesavanje", "org", actor.orgId, opt(body, "reason"), null, body);
      return { ok: true };
    }
    case "saveArticle": {
      allow(actor, "artikli", true);
      const kind = str(body, "kind");
      const baseUnit = str(body, "baseUnit");
      if (!kind) throw new Error("Vrsta artikla nije uneta.");
      if (!baseUnit) throw new Error("Osnovna jedinica nije uneta. Komad nije pretpostavljen.");
      return { id: await saveArticle(sql, actor, {
        id: opt(body, "id"),
        name: str(body, "name"),
        code: opt(body, "code"),
        categoryId: opt(body, "categoryId"),
        kind,
        tracksStock: body.tracksStock !== false && kind !== "trosak",
        baseUnit,
        minQty: str(body, "minQty", "0"),
        barcode: opt(body, "barcode"),
        nextExpiry: opt(body, "nextExpiry"),
      }) };
    }
    case "savePack":
      allow(actor, "artikli", true);
      await savePack(sql, actor, { articleId: str(body, "articleId"), name: str(body, "name"), qtyInBase: str(body, "qtyInBase") });
      return { ok: true };
    case "saveSupplier":
      allow(actor, "racuni", true);
      return { id: await saveSupplier(sql, actor, { id: opt(body, "id"), name: str(body, "name"), pib: opt(body, "pib"), note: opt(body, "note") }) };
    case "saveAlias":
      allow(actor, "racuni", true);
      await saveAlias(sql, actor, { supplierId: str(body, "supplierId"), supplierName: str(body, "supplierName"), articleId: str(body, "articleId") });
      return { ok: true };
    case "postOpening":
      allow(actor, "artikli", true);
      return postOpening(sql, actor, {
        articleId: str(body, "articleId"),
        qty: str(body, "qty"),
        unit: str(body, "unit"),
        unitCost: str(body, "unitCost"),
        date: str(body, "date"),
        note: opt(body, "note"),
        idempotencyKey: str(body, "idempotencyKey"),
      });
    case "upsertInvoice": {
      allow(actor, "racuni", true);
      const kind = str(body, "kind");
      if (!["nabavka", "povracaj", "trosak", "arhiva"].includes(kind)) {
        throw new Error("Vrsta dokumenta nije nabavka, povraćaj, trošak ili arhiva. Nabavka nije pretpostavljena.");
      }
      return upsertInvoice(sql, actor, {
        id: opt(body, "id"),
        supplierId: opt(body, "supplierId"),
        docNumber: opt(body, "docNumber"),
        docDate: opt(body, "docDate"),
        receivedDate: opt(body, "receivedDate"),
        dueDate: opt(body, "dueDate"),
        kind,
        total: opt(body, "total"),
        note: opt(body, "note"),
        idempotencyKey: str(body, "idempotencyKey"),
        lines: invoiceLines(body),
        files: Array.isArray(body.files)
          ? (body.files as Body[]).slice(0, 4).map((f) => ({
              name: String(f.name ?? "strana"),
              mime: String(f.mime ?? "image/jpeg"),
              dataUrl: String(f.dataUrl ?? ""),
            }))
          : [],
      });
    }
    case "postInvoice":
      allow(actor, "racuni", true);
      return postInvoice(sql, actor, {
        invoiceId: str(body, "invoiceId"),
        acceptMismatch: flag(body, "acceptMismatch"),
        allowDuplicate: flag(body, "allowDuplicate"),
        correctionReason: opt(body, "reason"),
      });
    case "voidInvoice":
      allow(actor, "racuni", true);
      await voidInvoice(sql, actor, str(body, "invoiceId"), str(body, "reason"));
      return { ok: true };
    case "payInvoice": {
      allow(actor, "racuni", true);
      if (!str(body, "method")) throw new Error("Način plaćanja nije naveden. Prenos nije pretpostavljen.");
      return payInvoice(sql, actor, {
        invoiceId: str(body, "invoiceId"),
        amount: str(body, "amount"),
        method: str(body, "method"),
        fromCash: flag(body, "fromCash"),
        paidAt: opt(body, "paidAt"),
        note: opt(body, "note"),
        idempotencyKey: str(body, "idempotencyKey"),
      });
    }
    case "saveProduct": {
      allow(actor, "recepture", true);
      const sellPrice = str(body, "sellPrice");
      const saleUnit = str(body, "saleUnit");
      const consumeMode = str(body, "consumeMode");
      if (!sellPrice) throw new Error("Prodajna cena nije uneta. Nula nije upisana.");
      if (!saleUnit) throw new Error("Jedinica prodaje nije uneta. Komad nije pretpostavljen.");
      if (consumeMode !== "recept" && consumeMode !== "zaliha") throw new Error("Način utroška je recept ili zaliha. Nije pretpostavljen.");
      return { id: await saveProduct(sql, actor, {
        id: opt(body, "id"),
        name: str(body, "name"),
        code: opt(body, "code"),
        groupName: opt(body, "groupName"),
        sizeLabel: opt(body, "sizeLabel"),
        sellPrice,
        saleUnit,
        consumeMode,
        outputArticleId: opt(body, "outputArticleId"),
        posCode: opt(body, "posCode"),
      }) };
    }
    case "saveRecipe":
      allow(actor, "recepture", true);
      return { id: await saveRecipe(sql, actor, {
        productId: str(body, "productId"),
        validFrom: opt(body, "validFrom"),
        note: opt(body, "note"),
        lines: Array.isArray(body.lines)
          ? (body.lines as Body[]).map((l) => {
              const unit = filled(l.unit);
              const role = filled(l.role);
              const qty = filled(l.qty);
              if (!qty) throw new Error("Stavka recepture nema količinu.");
              if (!unit) throw new Error("Stavka recepture nema jedinicu. Gram nije pretpostavljen.");
              if (!role) throw new Error("Stavka recepture nema ulogu. Sastojak nije pretpostavljen.");
              return {
                articleId: String(l.articleId),
                qty,
                unit,
                role,
                addonCode: l.addonCode ? String(l.addonCode) : null,
                yieldRatio: l.yieldRatio ? String(l.yieldRatio) : null,
              };
            })
          : [],
      }) };
    case "postProduction":
      allow(actor, "proizvodnja", true);
      return postProduction(sql, actor, {
        outputArticleId: str(body, "outputArticleId"),
        plannedQty: str(body, "plannedQty"),
        actualQty: str(body, "actualQty"),
        occurredAt: opt(body, "occurredAt"),
        note: opt(body, "note"),
        idempotencyKey: str(body, "idempotencyKey"),
        lines: Array.isArray(body.lines)
          ? (body.lines as Body[]).map((l) => {
              const unit = filled(l.unit);
              const qty = filled(l.qty);
              if (!qty || !unit) throw new Error("Sastojak proizvodnje traži količinu i jedinicu. Gram nije pretpostavljen.");
              return { articleId: String(l.articleId), qty, unit };
            })
          : [],
      });
    case "postSale": {
      allow(actor, "prodaja", true);
      const summary = flag(body, "isSummary");
      const linesIn = Array.isArray(body.lines) ? body.lines : [];
      if (!summary && !linesIn.length) throw new Error("Prodaja nema stavki. Promet nije upisan kao nula.");
      const stated = ["tenderCash", "tenderCard", "tenderOther", "tenderUnpaid"].filter((key) => filled(body[key]));
      if (!stated.length) throw new Error("Nema načina naplate. Keš nije pretpostavljen. Upišite 0 ako tog načina nema.");
      const tender = (key: string) => filled(body[key]) || "0";
      const channel = str(body, "channel");
      if (channel && !["lokal", "preuzimanje", "dostava"].includes(channel)) {
        throw new Error("Kanal je lokal, preuzimanje ili dostava. Nije pretpostavljen.");
      }
      return postSale(sql, actor, {
        externalKey: str(body, "idempotencyKey"),
        channel,
        tenderCash: tender("tenderCash"),
        tenderCard: tender("tenderCard"),
        tenderOther: tender("tenderOther"),
        tenderUnpaid: tender("tenderUnpaid"),
        discount: str(body, "discount", "0"),
        occurredAt: opt(body, "occurredAt"),
        source: str(body, "source", "rucno"),
        reason: opt(body, "reason"),
        isSummary: summary,
        summaryNet: opt(body, "summaryNet"),
        note: opt(body, "note"),
        correctionReason: opt(body, "correctionReason"),
        lines: linesIn.map((l) => {
          const name = filled(l.name);
          const qty = filled(l.qty);
          const lineNet = filled(l.lineNet);
          if (!qty) throw new Error(`„${name || "stavka"}“ nema količinu. Jedan komad nije pretpostavljen.`);
          if (!lineNet) throw new Error(`„${name || "stavka"}“ nema iznos. Nula nije upisana.`);
          if (!name && !l.productId) throw new Error("Stavka prodaje nema proizvod. Naziv nije izmišljen.");
          return {
            productId: l.productId ? String(l.productId) : null,
            name: name || "bez naziva",
            qty,
            unitPrice: l.unitPrice == null || l.unitPrice === "" ? null : String(l.unitPrice),
            lineNet,
            addons: Array.isArray(l.addons) ? l.addons.map(String) : [],
            omitted: Array.isArray(l.omitted) ? l.omitted.map(String) : [],
          };
        }),
      });
    }
    case "postRefund": {
      allow(actor, "prodaja", true);
      const method = str(body, "method");
      if (method !== "kes" && method !== "kartica" && method !== "prenos") {
        throw new Error("Način povraćaja je kes, kartica ili prenos. Nije pretpostavljen.");
      }
      return postRefund(sql, actor, {
        saleId: str(body, "saleId"),
        amount: str(body, "amount"),
        method,
        restoresStock: flag(body, "restoresStock"),
        reason: str(body, "reason"),
        idempotencyKey: str(body, "idempotencyKey"),
        occurredAt: opt(body, "occurredAt"),
      });
    }
    case "voidSale":
      allow(actor, "prodaja", true);
      await voidSale(sql, actor, str(body, "saleId"), str(body, "reason"));
      return { ok: true };
    case "postWaste": {
      allow(actor, "rashod", true);
      const unit = str(body, "unit");
      if (!unit) throw new Error("Rashod nema jedinicu. Gram nije pretpostavljen.");
      return postWaste(sql, actor, {
        articleId: opt(body, "articleId"),
        productId: opt(body, "productId"),
        qty: str(body, "qty"),
        unit,
        reason: str(body, "reason"),
        note: opt(body, "note"),
        photoUrl: opt(body, "photoUrl"),
        allowOver: flag(body, "allowOver"),
        occurredAt: opt(body, "occurredAt"),
        idempotencyKey: str(body, "idempotencyKey"),
      });
    }
    case "startCount":
      allow(actor, "popis", true);
      return { id: await startCount(sql, actor, { scope: body.scope === "deo" ? "deo" : "sve", articleIds: Array.isArray(body.articleIds) ? body.articleIds.map(String) : [], note: opt(body, "note") }) };
    case "setCountQty":
      allow(actor, "popis", true);
      await setCountQty(sql, actor, str(body, "countId"), str(body, "articleId"), str(body, "counted"));
      return { ok: true };
    case "postCount":
      allow(actor, "popis", true);
      return postCount(sql, actor, str(body, "countId"));
    case "openShift": {
      allow(actor, "smene", true);
      const openingCash = str(body, "openingCash");
      if (!openingCash) throw new Error("Početni novac nije unet. Ako je fioka prazna, upišite 0.");
      return { id: await openShift(sql, actor, { openingCash, occurredAt: opt(body, "occurredAt") }) };
    }
    case "addCash": {
      allow(actor, "smene", true);
      const kind = str(body, "kind");
      if (kind !== "ulaz" && kind !== "isplata" && kind !== "polog") {
        throw new Error("Vrsta kretanja kase nije navedena. Polog nije pretpostavljen.");
      }
      await addCashMove(sql, actor, {
        kind,
        amount: str(body, "amount"),
        note: opt(body, "note"),
        idempotencyKey: str(body, "idempotencyKey"),
      });
      return { ok: true };
    }
    case "closeShift":
      allow(actor, "smene", true);
      return closeShift(sql, actor, { counted: str(body, "counted"), note: opt(body, "note") });
    case "correctShift":
      allow(actor, "smene", true);
      await correctShift(sql, actor, { shiftId: str(body, "shiftId"), counted: str(body, "counted"), reason: str(body, "reason") });
      return { ok: true };
    case "saveExpense":
      allow(actor, "troskovi", true);
      return { id: await saveExpense(sql, actor, {
        title: str(body, "title"),
        amount: str(body, "amount"),
        category: opt(body, "category"),
        fromCash: flag(body, "fromCash"),
        note: opt(body, "note"),
        occurredAt: opt(body, "occurredAt"),
        idempotencyKey: str(body, "idempotencyKey"),
      }) };
    case "saveOrder":
      allow(actor, "porudzbine", true);
      return { id: await saveOrder(sql, actor, {
        id: opt(body, "id"),
        customerName: str(body, "customerName"),
        company: opt(body, "company"),
        phone: opt(body, "phone"),
        dueAt: opt(body, "dueAt"),
        place: opt(body, "place"),
        note: opt(body, "note"),
        status: str(body, "status", "najavljeno"),
        recurNote: opt(body, "recurNote"),
        lines: Array.isArray(body.lines)
          ? (body.lines as Body[]).map((l) => {
              const name = filled(l.name);
              const qty = filled(l.qty);
              const unitPrice = filled(l.unitPrice);
              if (!qty) throw new Error(`„${name || "stavka"}“ nema količinu. Jedan komad nije pretpostavljen.`);
              if (!unitPrice) throw new Error(`„${name || "stavka"}“ nema cenu. Nula nije upisana.`);
              if (!name && !l.productId) throw new Error("Stavka porudžbine nema artikal. Naziv nije izmišljen.");
              return {
                productId: l.productId ? String(l.productId) : null,
                name: name || "bez naziva",
                qty,
                unitPrice,
              };
            })
          : [],
      }) };
    case "takeAdvance":
      allow(actor, "porudzbine", true);
      await takeAdvance(sql, actor, { orderId: str(body, "orderId"), amount: str(body, "amount"), idempotencyKey: str(body, "idempotencyKey") });
      return { ok: true };
    case "realizeOrder": {
      allow(actor, "porudzbine", true);
      const stated = ["tenderCash", "tenderCard", "tenderOther", "tenderUnpaid"].filter((key) => filled(body[key]));
      if (!stated.length) throw new Error("Realizacija nema način naplate. Neplaćeno nije pretpostavljeno. Upišite 0 ako tog načina nema.");
      const tender = (key: string) => filled(body[key]) || "0";
      return realizeOrder(sql, actor, {
        orderId: str(body, "orderId"),
        tenderCash: tender("tenderCash"),
        tenderCard: tender("tenderCard"),
        tenderOther: tender("tenderOther"),
        tenderUnpaid: tender("tenderUnpaid"),
      });
    }
    case "invite": {
      allow(actor, "korisnici", true);
      const email = str(body, "email").toLowerCase();
      const role = str(body, "role", "admin") as Role;
      if (!["admin", "knjigovodja", "super_admin"].includes(role)) throw new Error("Nepoznata uloga");
      const perms = defaultPerms(role);
      await sql.query(
        `insert into invites (id, org_id, email, role, permissions) values ($1,$2,$3,$4,$5::jsonb)
         on conflict (org_id, email) do update set role = excluded.role, permissions = excluded.permissions`,
        [crypto.randomUUID(), actor.orgId, email, role, JSON.stringify(perms)],
      );
      return { ok: true };
    }
    case "setMember": {
      allow(actor, "korisnici", true);
      const role = str(body, "role") as Role;
      const perms = normalizePerms(role, body.permissions);
      if (role !== "super_admin") {
        const admins = await sql.query<{ n: number }>(
          `select count(*)::int as n from members where org_id=$1 and role='super_admin' and active=true and user_id<>$2`,
          [actor.orgId, str(body, "userId")],
        );
        const self = await sql.query<{ role: string }>(`select role from members where org_id=$1 and user_id=$2`, [actor.orgId, str(body, "userId")]);
        if (self[0]?.role === "super_admin" && Number(admins[0]?.n ?? 0) === 0) {
          throw new Error("Mora ostati bar jedan vlasnik.");
        }
      }
      await sql.query(`update members set role=$1, permissions=$2::jsonb, active=$3 where org_id=$4 and user_id=$5`, [
        role,
        JSON.stringify(perms),
        body.active !== false,
        actor.orgId,
        str(body, "userId"),
      ]);
      return { ok: true };
    }
    case "approve": {
      allow(actor, "korisnici", true);
      const role = str(body, "role", "admin") as Role;
      const req = await sql.query<{ user_id: string; email: string | null; name: string | null }>(
        `select user_id, email, name from access_requests where user_id=$1`,
        [str(body, "userId")],
      );
      if (!req[0]) throw new Error("Nema zahteva");
      await sql.query(
        `insert into members (id, org_id, user_id, email, display_name, role, permissions) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [crypto.randomUUID(), actor.orgId, req[0].user_id, req[0].email, req[0].name, role, JSON.stringify(defaultPerms(role))],
      );
      await sql.query(`delete from access_requests where user_id=$1`, [req[0].user_id]);
      return { ok: true };
    }
    case "seedDemo":
      allow(actor, "podesavanja", true);
      return seedDemo(sql, actor);
    case "wipeDemo":
      allow(actor, "podesavanja", true);
      await wipeDemo(sql, actor.orgId);
      return { ok: true };
    case "createToken": {
      allow(actor, "podesavanja", true);
      const raw = `dpu_${randomBytes(24).toString("hex")}`;
      const scopes = {
        promet: flag(body, "promet"),
        zalihe: flag(body, "zalihe"),
        dokumenti: flag(body, "dokumenti"),
        upozorenja: flag(body, "upozorenja"),
        upis: flag(body, "upis"),
      };
      await sql.query(
        `insert into api_tokens (id, org_id, name, token_hash, scopes, created_by) values ($1,$2,$3,$4,$5::jsonb,$6)`,
        [crypto.randomUUID(), actor.orgId, str(body, "name", "Pristup"), createHash("sha256").update(raw).digest("hex"), JSON.stringify(scopes), actor.userId],
      );
      return { token: raw, scopes };
    }
    case "revokeToken":
      allow(actor, "podesavanja", true);
      await sql.query(`update api_tokens set revoked_at=now() where id=$1 and org_id=$2`, [str(body, "id"), actor.orgId]);
      return { ok: true };
    case "proof": {
      if (actor.role !== "super_admin") throw new Error("Proveru obračuna pokreće vlasnik.");
      const checks = await runProof(sql);
      const err = new Error("rollback");
      (err as Error & { [ROLL]?: unknown })[ROLL] = checks;
      throw err;
    }
    default:
      throw new Error("Nepoznata radnja");
  }
}

export const act = createServerFn({ method: "POST" })
  .middleware([openMiddleware])
  .validator((data: { op: string; body?: Body }) => data)
  .handler(async ({ context, data }): Promise<any> => {
    try {
      return await withTransaction(async (sql) => runAct(sql, context.userId, data.op, data.body ?? {}));
    } catch (err) {
      const rolled = err as Error & { [ROLL]?: unknown };
      if (rolled && rolled[ROLL]) return rolled[ROLL];
      throw new Error(err instanceof Error ? err.message : "Greška pri čuvanju");
    }
  });

async function warnings(sql: Sql, orgId: string) {
  const low = await sql.query<{ name: string; on_hand: string; min_qty: string; base_unit: string }>(
    `select name, on_hand::text, min_qty::text, base_unit from articles
     where org_id=$1 and active and tracks_stock and is_demo=false and (on_hand < min_qty or on_hand < 0)
     order by on_hand limit 20`,
    [orgId],
  );
  const expiry = await sql.query<{ name: string; next_expiry: string }>(
    `select name, next_expiry::text from articles where org_id=$1 and next_expiry is not null and next_expiry <= current_date + 3 and is_demo=false`,
    [orgId],
  );
  const prices = await sql.query<{ name: string; prev_price: string; last_price: string }>(
    `select name, prev_price::text, last_price::text from articles
     where org_id=$1 and prev_price is not null and last_price > prev_price * 1.15 and is_demo=false limit 10`,
    [orgId],
  );
  const noRecipe = await sql.query<{ name: string }>(
    `select p.name from products p
     where p.org_id=$1 and p.active and p.is_demo=false and p.consume_mode='recept'
       and not exists (select 1 from recipe_versions v where v.product_id=p.id)`,
    [orgId],
  );
  const noCost = await sql.query<{ name: string; on_hand: string }>(
    `select name, on_hand::text from articles where org_id=$1 and tracks_stock and is_demo=false and on_hand > 0 and avg_cost is null limit 10`,
    [orgId],
  );
  const drafts = await sql.query<{ doc_number: string | null; status: string; doc_date: string | null }>(
    `select doc_number, status, doc_date::text from invoices where org_id=$1 and status in ('nacrt','provera') and is_demo=false order by created_at desc limit 10`,
    [orgId],
  );
  const dups = await sql.query<{ doc_number: string; n: number }>(
    `select doc_number, count(*)::int as n from invoices
     where org_id=$1 and doc_number is not null and status in ('nacrt','provera','proknjizen') and is_demo=false
     group by supplier_id, doc_number having count(*) > 1 limit 10`,
    [orgId],
  );
  const cash = await sql.query<{ business_date: string; variance: string; variance_note: string | null }>(
    `select business_date::text, variance::text, variance_note from shifts
     where org_id=$1 and status='zatvorena' and variance is not null and variance <> 0 order by closed_at desc limit 5`,
    [orgId],
  );
  const waste = await sql.query<{ reason: string; value: string | null; qty: string }>(
    `select reason, value::text, qty::text from wastes where org_id=$1 and is_demo=false and business_date = current_date and (over_stock or coalesce(value,0) > 2000) limit 10`,
    [orgId],
  );
  const incomplete = await sql.query<{ n: number }>(
    `select count(*)::int as n from sales where org_id=$1 and status='proknjizen' and reconcile_only=false and cost_complete=false and is_demo=false and business_date > current_date - 7`,
    [orgId],
  );
  const edits = await sql.query<{ n: number }>(
    `select count(*)::int as n from audit_log where org_id=$1 and action like 'korekcija%' and at > now() - interval '7 days'`,
    [orgId],
  );
  const items: { title: string; detail: string; tone: string }[] = [];
  for (const row of low) items.push({ tone: "bad", title: row.on_hand.startsWith("-") ? "Negativna zaliha" : "Zaliha ispod minimuma", detail: `${row.name}: stanje ${row.on_hand} ${row.base_unit}, minimum ${row.min_qty}.` });
  for (const row of expiry) items.push({ tone: "warn", title: "Rok trajanja", detail: `${row.name} ističe ${row.next_expiry}.` });
  for (const row of prices) items.push({ tone: "warn", title: "Rast nabavne cene", detail: `${row.name}: sa ${row.prev_price} na ${row.last_price} po osnovnoj jedinici (preko 15%).` });
  for (const row of noRecipe) items.push({ tone: "warn", title: "Prodaja bez recepture", detail: `${row.name} nema sačuvan normativ. Utrošak je nepoznat, ne nula.` });
  for (const row of noCost) items.push({ tone: "warn", title: "Nema nabavne cene", detail: `${row.name}: na stanju ${row.on_hand}, prosečna cena nije poznata.` });
  for (const row of drafts) items.push({ tone: "warn", title: "Račun čeka obradu", detail: `${row.doc_number ?? "bez broja"} (${row.status}) datum ${row.doc_date ?? "nije unet"}.` });
  for (const row of dups) items.push({ tone: "bad", title: "Mogući dupli dokument", detail: `Broj ${row.doc_number} pojavljuje se ${row.n} puta.` });
  for (const row of cash) items.push({ tone: "warn", title: "Razlika u kasi", detail: `${row.business_date}: razlika ${row.variance} RSD. ${row.variance_note ?? "Nema napomene."}` });
  for (const row of waste) items.push({ tone: "warn", title: "Rashod za proveru", detail: `${row.reason}: količina ${row.qty}, vrednost ${row.value ?? "nepoznata"}.` });
  if (Number(incomplete[0]?.n ?? 0) > 0) items.push({ tone: "warn", title: "Nepotpun obračun prodaje", detail: `${incomplete[0]?.n} prodaja u 7 dana nema pun trošak recepture ili cenu.` });
  if (Number(edits[0]?.n ?? 0) >= 3) items.push({ tone: "warn", title: "Česte korekcije", detail: `${edits[0]?.n} korekcija zaključanog perioda ili smene u 7 dana. Ovo je stavka za proveru, ne zaključak.` });
  return items;
}

export const read = createServerFn({ method: "POST" })
  .middleware([openMiddleware])
  .validator((data: { op: string; body?: Body }) => data)
  .handler(async ({ context, data }): Promise<any> => {
    const sql = await getSql();
    const who = await profile(sql, context.userId);
    const body = data.body ?? {};
    if (data.op === "bootstrap") {
      let actor = await loadActor(sql, context.userId);
      if (!actor && who.email) {
        const invite = await sql.query<{ role: string; permissions: Perms; org_id: string }>(
          `select role, permissions, org_id from invites where lower(email)=lower($1) limit 1`,
          [who.email],
        );
        if (invite[0]) {
          await sql.query(
            `insert into members (id, org_id, user_id, email, display_name, role, permissions) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
            [crypto.randomUUID(), invite[0].org_id, context.userId, who.email, who.name, invite[0].role, JSON.stringify(invite[0].permissions)],
          );
          await sql.query(`delete from invites where lower(email)=lower($1)`, [who.email]);
          actor = await loadActor(sql, context.userId);
        }
      }
      const orgs = await sql.query<{ id: string }>(`select id from orgs limit 1`);
      if (!actor && orgs[0] && (process.env.VITE_AUTH_ENABLED === "false" || context.userId === OPEN_USER_ID)) {
        await sql.query(
          `insert into members (id, org_id, user_id, email, display_name, role, permissions)
           values ($1,$2,$3,$4,$5,'super_admin',$6::jsonb)
           on conflict (user_id) do nothing`,
          [
            crypto.randomUUID(),
            orgs[0].id,
            context.userId,
            "objekat@lokalno",
            "Objekat",
            JSON.stringify(defaultPerms("super_admin")),
          ],
        );
        actor = await loadActor(sql, context.userId);
      }
      if (!actor && !orgs[0]) {
        return { mode: "setup" as const, email: who.email, name: who.name, ai: Boolean(process.env.XAI_API_KEY) };
      }
      if (!actor) {
        await sql.query(
          `insert into access_requests (user_id, email, name) values ($1,$2,$3)
           on conflict (user_id) do update set email=excluded.email, name=excluded.name`,
          [context.userId, who.email, who.name],
        );
        return { mode: "wait" as const, email: who.email, name: who.name, ai: Boolean(process.env.XAI_API_KEY) };
      }
      const org = await sql.query(
        `select id, name, legal_name, pib, mb, address, city, phone, currency, timezone, business_day_end_hour,
                tax_mode, valuation_method, auto_post_invoices, opening_stock_date::text, locked_through::text, initial_cash::text
         from orgs where id=$1`,
        [actor.orgId],
      );
      const shift = await sql.query(
        `select id, business_date::text, opening_cash::text, opened_at::text from shifts where org_id=$1 and status='otvorena'`,
        [actor.orgId],
      );
      const orgRow = org[0] as { business_day_end_hour: number; timezone: string };
      return {
        mode: "app" as const,
        email: who.email,
        name: who.name,
        role: actor.role,
        perms: actor.permissions,
        org: org[0],
        shift: shift[0] ?? null,
        businessDate: businessDate(new Date(), orgRow.business_day_end_hour, orgRow.timezone),
        ai: Boolean(process.env.XAI_API_KEY),
        hasDemo: (await sql.query(`select 1 from articles where org_id=$1 and is_demo limit 1`, [actor.orgId])).length > 0,
      };
    }
    const actor = await actorOrThrow(sql, context.userId);
    const demo = flag(body, "demo");
    if (data.op === "home") {
      allow(actor, "izvestaji", false);
      const org = await sql.query<{ business_day_end_hour: number; timezone: string }>(
        `select business_day_end_hour, timezone from orgs where id=$1`,
        [actor.orgId],
      );
      const day = str(body, "day") || businessDate(new Date(), org[0].business_day_end_hour, org[0].timezone);
      const snap = await snapshot(sql, actor.orgId, day, day, demo);
      const low = await sql.query(
        `select id, name, on_hand::text, min_qty::text, base_unit from articles
         where org_id=$1 and tracks_stock and active and ($2::boolean or is_demo=false) and on_hand <= min_qty
         order by on_hand limit 6`,
        [actor.orgId, demo],
      );
      const pending = await sql.query<{ n: number }>(
        `select count(*)::int as n from invoices where org_id=$1 and status in ('nacrt','provera') and ($2::boolean or is_demo=false)`,
        [actor.orgId, demo],
      );
      return { day, snap, low, pending: Number(pending[0]?.n ?? 0), warnings: (await warnings(sql, actor.orgId)).slice(0, 6) };
    }
    if (data.op === "articles") {
      allow(actor, "artikli", false);
      const articles = await sql.query(
        `select a.id, a.code, a.name, a.kind, a.tracks_stock, a.base_unit, a.min_qty::text, a.on_hand::text, a.avg_cost::text, a.last_price::text,
                a.barcode, a.next_expiry::text, a.is_demo, a.active, c.name as category
         from articles a left join categories c on c.id = a.category_id
         where a.org_id=$1 and ($2::boolean or a.is_demo=false)
         order by a.name`,
        [actor.orgId, demo],
      );
      const packs = await sql.query(
        `select p.id, p.article_id, p.name, p.qty_in_base::text from article_packs p
         join articles a on a.id=p.article_id where a.org_id=$1`,
        [actor.orgId],
      );
      const categories = await sql.query(`select id, name, kind from categories where org_id=$1 order by name`, [actor.orgId]);
      return { articles, packs, categories };
    }
    if (data.op === "suppliers") {
      allow(actor, "racuni", false);
      return { suppliers: await sql.query(`select id, name, pib from suppliers where org_id=$1 and active order by name`, [actor.orgId]) };
    }
    if (data.op === "invoices") {
      allow(actor, "racuni", false);
      const rows = await sql.query(
        `select i.id, i.doc_number, i.doc_date::text, i.kind, i.status, i.total::text, i.mismatch, i.unclear, i.is_demo, s.name as supplier,
                coalesce((select sum(amount) from payments p where p.invoice_id=i.id),0)::text as paid
         from invoices i left join suppliers s on s.id=i.supplier_id
         where i.org_id=$1 and ($2::boolean or i.is_demo=false)
         order by i.created_at desc limit 80`,
        [actor.orgId, demo],
      );
      return { invoices: rows };
    }
    if (data.op === "invoice") {
      allow(actor, "racuni", false);
      const header = await sql.query(`select * from invoices where id=$1 and org_id=$2`, [str(body, "id"), actor.orgId]);
      const lines = await sql.query(
        `select id, article_id, raw_name, qty::text, unit_name, qty_base::text, unit_price::text, line_total::text, needs_review from invoice_lines where invoice_id=$1`,
        [str(body, "id")],
      );
      const files = await sql.query(`select id, name, mime, data_url from invoice_files where invoice_id=$1`, [str(body, "id")]);
      return { header: header[0] ?? null, lines, files };
    }
    if (data.op === "products") {
      allow(actor, "recepture", false);
      const products = await sql.query(
        `select id, name, code, group_name, size_label, sell_price::text, sale_unit, consume_mode, output_article_id, pos_code, is_demo, active
         from products where org_id=$1 and ($2::boolean or is_demo=false) order by name`,
        [actor.orgId, demo],
      );
      const versions = await sql.query(
        `select v.id, v.product_id, v.valid_from::text, v.note from recipe_versions v
         join products p on p.id=v.product_id where p.org_id=$1 order by v.valid_from desc`,
        [actor.orgId],
      );
      const lines = await sql.query(
        `select l.version_id, l.article_id, a.name as article, l.qty::text, l.role, l.addon_code, l.yield_ratio::text, a.base_unit
         from recipe_lines l join articles a on a.id=l.article_id
         join recipe_versions v on v.id=l.version_id join products p on p.id=v.product_id where p.org_id=$1`,
        [actor.orgId],
      );
      return { products, versions, lines };
    }
    if (data.op === "sales") {
      allow(actor, "prodaja", false);
      return {
        sales: await sql.query(
          `select id, occurred_at::text, business_date::text, channel, net::text, tender_cash::text, tender_card::text, tender_other::text,
                  status, source, is_summary, reconcile_only, is_refund, restores_stock, cost_value::text, cost_complete, basic_normative, reason, is_demo
           from sales where org_id=$1 and ($2::boolean or is_demo=false) order by occurred_at desc limit 80`,
          [actor.orgId, demo],
        ),
      };
    }
    if (data.op === "shift") {
      allow(actor, "smene", false);
      const open = await sql.query(
        `select id, business_date::text, opening_cash::text, opened_at::text, status from shifts where org_id=$1 and status='otvorena'`,
        [actor.orgId],
      );
      let expected: string | null = null;
      if (open[0]) {
        const id = (open[0] as { id: string }).id;
        expected = mStr(await expectedCashOf(sql, id));
      }
      const history = await sql.query(
        `select id, business_date::text, status, opening_cash::text, expected_cash::text, counted_cash::text, variance::text, variance_note, corrected, correction_reason, closed_at::text
         from shifts where org_id=$1 order by opened_at desc limit 20`,
        [actor.orgId],
      );
      const events = open[0]
        ? await sql.query(
            `select kind, amount::text, note, occurred_at::text from cash_events where shift_id=$1 order by occurred_at`,
            [(open[0] as { id: string }).id],
          )
        : [];
      return { open: open[0] ?? null, expected, history, events };
    }
    if (data.op === "wastes") {
      allow(actor, "rashod", false);
      return {
        wastes: await sql.query(
          `select w.id, w.qty::text, w.unit_name, w.reason, w.note, w.value::text, w.cost_complete, w.over_stock, w.business_date::text, w.occurred_at::text,
                  a.name as article, p.name as product
           from wastes w left join articles a on a.id=w.article_id left join products p on p.id=w.product_id
           where w.org_id=$1 and ($2::boolean or w.is_demo=false) order by w.occurred_at desc limit 50`,
          [actor.orgId, demo],
        ),
      };
    }
    if (data.op === "counts") {
      allow(actor, "popis", false);
      return {
        counts: await sql.query(
          `select id, status, scope, business_date::text, started_at::text, note from counts where org_id=$1 order by started_at desc limit 20`,
          [actor.orgId],
        ),
      };
    }
    if (data.op === "count") {
      allow(actor, "popis", false);
      const lines = await sql.query(
        `select l.article_id, a.name, a.base_unit, l.expected_qty::text, l.counted_qty::text, l.diff_qty::text, l.value::text
         from count_lines l join articles a on a.id=l.article_id where l.count_id=$1 order by a.name`,
        [str(body, "id")],
      );
      return { lines };
    }
    if (data.op === "orders") {
      allow(actor, "porudzbine", false);
      const orders = await sql.query(
        `select id, customer_name, company, phone, due_at::text, place, note, status, advance::text, advance_applied::text, recur_note, sale_id
         from orders where org_id=$1 order by created_at desc limit 40`,
        [actor.orgId],
      );
      const lines = await sql.query(
        `select l.order_id, l.product_id, l.name, l.qty::text, l.unit_price::text from order_lines l
         join orders o on o.id=l.order_id where o.org_id=$1`,
        [actor.orgId],
      );
      return { orders, lines };
    }
    if (data.op === "expenses") {
      allow(actor, "troskovi", false);
      const expenses = await sql.query(
        `select id, title, amount::text, category, business_date::text, note, source, voided from expenses
         where org_id=$1 and ($2::boolean or is_demo=false) order by occurred_at desc limit 50`,
        [actor.orgId, demo],
      );
      const payables = await sql.query(
        `select i.id, i.doc_number, s.name as supplier, i.total::text, i.due_date::text, i.status,
                coalesce((select sum(amount) from payments p where p.invoice_id=i.id),0)::text as paid
         from invoices i left join suppliers s on s.id=i.supplier_id
         where i.org_id=$1 and i.status='proknjizen' and i.kind in ('nabavka','trosak') and i.is_demo=false
         order by i.due_date nulls last limit 40`,
        [actor.orgId],
      );
      return { expenses, payables };
    }
    if (data.op === "report" || data.op === "export") {
      allow(actor, "izvestaji", false);
      const from = str(body, "from");
      const to = str(body, "to");
      const snap = await snapshot(sql, actor.orgId, from, to, demo);
      const byProduct = await sql.query(
        `select l.name, sum(l.qty)::text as qty, sum(l.line_net)::text as net, bool_and(l.cost_complete) as complete, sum(l.cost_value)::text as cost
         from sale_lines l join sales s on s.id=l.sale_id
         where s.org_id=$1 and s.status='proknjizen' and s.reconcile_only=false and s.business_date between $2 and $3 and ($4::boolean or s.is_demo=false)
         group by l.name order by sum(l.line_net) desc`,
        [actor.orgId, from, to, demo],
      );
      const byPay = await sql.query(
        `select coalesce(sum(tender_cash),0)::text as kes, coalesce(sum(tender_card),0)::text as kartica,
                coalesce(sum(tender_other),0)::text as ostalo, coalesce(sum(tender_unpaid),0)::text as neplaceno,
                coalesce(sum(case when is_refund then net else 0 end),0)::text as povracaj
         from sales where org_id=$1 and status='proknjizen' and reconcile_only=false and business_date between $2 and $3 and ($4::boolean or is_demo=false)`,
        [actor.orgId, from, to, demo],
      );
      const stock = await sql.query(
        `select name, base_unit, on_hand::text, avg_cost::text,
                case when avg_cost is null then null else (on_hand * avg_cost)::text end as value
         from articles where org_id=$1 and tracks_stock and active and ($2::boolean or is_demo=false) order by name`,
        [actor.orgId, demo],
      );
      if (data.op === "export") {
        const XLSX = await import("xlsx");
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([snap]), "Rezime");
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(byProduct), "Po proizvodu");
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(stock), "Zalihe");
        const base64 = XLSX.write(wb, { type: "base64", bookType: "xlsx" }) as string;
        return { base64, filename: `promet-${from}-${to}.xlsx` };
      }
      return { snap, byProduct, byPay: byPay[0], stock };
    }
    if (data.op === "control") {
      allow(actor, "kontrola", false);
      return { warnings: await warnings(sql, actor.orgId), audit: await sql.query(
        `select at::text, action, entity, entity_id, reason, user_id from audit_log where org_id=$1 order by at desc limit 40`,
        [actor.orgId],
      ) };
    }
    if (data.op === "accountant") {
      allow(actor, "knjigovodja", false);
      const from = str(body, "from");
      const to = str(body, "to");
      const invoices = await sql.query<{ n: number; drafts: number }>(
        `select count(*) filter (where status='proknjizen')::int as n, count(*) filter (where status in ('nacrt','provera'))::int as drafts
         from invoices where org_id=$1 and coalesce(doc_date, received_date, created_at::date) between $2 and $3 and is_demo=false`,
        [actor.orgId, from, to],
      );
      const sales = await sql.query<{ n: number; incomplete: number }>(
        `select count(*)::int as n, count(*) filter (where cost_complete=false)::int as incomplete
         from sales where org_id=$1 and business_date between $2 and $3 and status='proknjizen' and reconcile_only=false and is_demo=false`,
        [actor.orgId, from, to],
      );
      const openShifts = await sql.query<{ n: number }>(
        `select count(*)::int as n from shifts where org_id=$1 and status='otvorena'`,
        [actor.orgId],
      );
      const missing: string[] = [];
      if (Number(invoices[0]?.drafts ?? 0) > 0) missing.push(`${invoices[0]?.drafts} računa još nije proknjiženo.`);
      if (Number(sales[0]?.n ?? 0) === 0) missing.push("Nema proknjižene prodaje u periodu. Ako prometa nije bilo, zabeležite to u napomeni izveštaja.");
      if (Number(sales[0]?.incomplete ?? 0) > 0) missing.push(`${sales[0]?.incomplete} prodaja nema potpun trošak. Namirnice za njih nisu pouzdane.`);
      if (Number(openShifts[0]?.n ?? 0) > 0) missing.push("Jedna smena je još otvorena.");
      return { invoices: invoices[0], sales: sales[0], missing, note: "Ovo nije propisani poreski obrazac. Sadržaj treba da potvrdi knjigovođa." };
    }
    if (data.op === "people") {
      allow(actor, "korisnici", false);
      return {
        members: await sql.query(`select user_id, email, display_name, role, permissions, active from members where org_id=$1`, [actor.orgId]),
        invites: await sql.query(`select email, role from invites where org_id=$1`, [actor.orgId]),
        requests: await sql.query(`select user_id, email, name, created_at::text from access_requests order by created_at`),
        tokens: await sql.query(`select id, name, scopes, created_at::text, revoked_at::text from api_tokens where org_id=$1 order by created_at desc`, [actor.orgId]),
      };
    }
    if (data.op === "moves") {
      allow(actor, "artikli", false);
      return {
        moves: await sql.query(
          `select m.occurred_at::text, m.business_date::text, m.kind, m.qty::text, m.value::text, m.note, a.name
           from stock_moves m join articles a on a.id=m.article_id
           where m.org_id=$1 and m.voided=false and ($2::boolean or m.is_demo=false)
           order by m.occurred_at desc limit 40`,
          [actor.orgId, demo],
        ),
      };
    }
    if (data.op === "tokens") {
      const actor = await actorOrThrow(sql, context.userId);
      allow(actor, "podesavanja", false);
      return {
        tokens: await sql.query(
          `select id, name, scopes, created_at::text, revoked_at::text from api_tokens where org_id=$1 order by created_at desc`,
          [actor.orgId],
        ),
      };
    }
    throw new Error("Nepoznat pregled");
  });

export const recognizeReceipt = createServerFn({ method: "POST" })
  .middleware([openMiddleware])
  .validator((data: { dataUrl: string }) => data)
  .handler(async ({ context, data }) => {
    const sql = await getSql();
    const actor = await actorOrThrow(sql, context.userId);
    allow(actor, "racuni", true);
    if (!data.dataUrl?.startsWith("data:image/")) return { ok: false as const, error: "Pošaljite fotografiju (JPG ili PNG). PDF ostaje u arhivi i unosi se ručno." };
    if (data.dataUrl.length > 1_500_000) return { ok: false as const, error: "Fotografija je prevelika. Smanjite je pa pokušajte ponovo." };
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      return { ok: false as const, error: "Prepoznavanje nije povezano: na serveru nema xAI ključa. Račun unesite ručno. Original možete sačuvati uz nacrt." };
    }
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "grok-4.5",
        temperature: 0,
        max_tokens: 1200,
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Izvuci samo ono što je odštampano na računu. Vrati samo JSON: {\"supplier\":string|null,\"docNumber\":string|null,\"docDate\":string|null,\"total\":string|null,\"lines\":[{\"name\":string,\"qty\":string|null,\"unit\":string|null,\"price\":string|null,\"lineTotal\":string|null,\"unclear\":boolean}]}. Ako broj, jedinica, datum ili iznos nisu čitki, stavi null i unclear true. Zabranjeno je pogađanje: ne upisuj 1, kom, kg, 0, današnji datum niti iznos koji nije na papiru." },
            { type: "image_url", image_url: { url: data.dataUrl } },
          ],
        }],
      }),
    });
    if (!res.ok) return { ok: false as const, error: `Prepoznavanje nije uspelo (${res.status}). Unesite ručno.` };
    const payload = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = payload.choices?.[0]?.message?.content ?? "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { ok: false as const, error: "Odgovor nije bio čitljiv. Unesite ručno." };
    try {
      const parsed = JSON.parse(match[0]) as {
        supplier?: string | null;
        docNumber?: string | null;
        docDate?: string | null;
        total?: string | null;
        lines?: { name?: string; qty?: string | null; unit?: string | null; price?: string | null; lineTotal?: string | null; unclear?: boolean }[];
      };
      return { ok: true as const, parsed, raw: text.slice(0, 500) };
    } catch {
      return { ok: false as const, error: "Nisam uspeo da složim stavke. Unesite ručno." };
    }
  });

void m;
