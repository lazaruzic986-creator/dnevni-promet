import { randomUUID } from "node:crypto";
import { explodeRecipe, type RecipeLine, type RecipeRole } from "./calc.ts";
import { businessDate } from "./day.ts";
import {
  MoneyError,
  applyInbound,
  c,
  cStr,
  m,
  mStr,
  q,
  qStr,
  toBaseQty,
  unitCostFromTotal,
  valuePara,
} from "./money.ts";
import { defaultPerms, normalizePerms, type Perms, type Role } from "./perms.ts";

export type Sql = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

export type Actor = {
  userId: string;
  memberId: string;
  role: string;
  permissions: Perms;
  orgId: string;
};

type OrgRow = {
  id: string;
  timezone: string;
  business_day_end_hour: number;
  locked_through: string | null;
  name: string;
};

const VALUED_IN = new Set(["pocetno", "nabavka", "proizvodnja_ulaz", "povrat_robe"]);

export function newId(): string {
  return randomUUID();
}

async function one<T>(sql: Sql, text: string, params: unknown[], msg = "Nema zapisa"): Promise<T> {
  const rows = await sql.query<T>(text, params);
  if (!rows[0]) throw new Error(msg);
  return rows[0];
}

export async function audit(
  sql: Sql,
  orgId: string,
  userId: string,
  action: string,
  entity: string,
  entityId: string | null,
  reason: string | null,
  before: unknown,
  after: unknown,
): Promise<void> {
  await sql.query(
    `insert into audit_log (id, org_id, user_id, action, entity, entity_id, reason, before, after)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
    [
      newId(),
      orgId,
      userId,
      action,
      entity,
      entityId,
      reason,
      JSON.stringify(before ?? null),
      JSON.stringify(after ?? null),
    ],
  );
}

async function orgOf(sql: Sql, orgId: string): Promise<OrgRow> {
  return one<OrgRow>(
    sql,
    `select id, timezone, business_day_end_hour, locked_through::text, name from orgs where id = $1`,
    [orgId],
    "Objekat ne postoji",
  );
}

export async function assertPeriod(
  sql: Sql,
  orgId: string,
  business: string,
  role: string,
  correctionReason: string | null,
): Promise<void> {
  const org = await orgOf(sql, orgId);
  if (org.locked_through && business <= org.locked_through) {
    if (role !== "super_admin" || !correctionReason?.trim()) {
      throw new Error("Period je zaključan. Naknadnu izmenu može samo vlasnik, uz upisan razlog. Ostaće u istoriji.");
    }
    await audit(sql, orgId, "", "korekcija_perioda", "period", business, correctionReason, null, { business });
  }
}

export async function stamp(sql: Sql, orgId: string, occurredAt?: string | null): Promise<{ at: string; day: string; org: OrgRow }> {
  const org = await orgOf(sql, orgId);
  const at = occurredAt ? new Date(occurredAt) : new Date();
  if (Number.isNaN(at.getTime())) throw new Error("Datum nije ispravan");
  return { at: at.toISOString(), day: businessDate(at, org.business_day_end_hour, org.timezone), org };
}

export async function openShiftRow(sql: Sql, orgId: string): Promise<{ id: string } | null> {
  const rows = await sql.query<{ id: string }>(
    `select id from shifts where org_id = $1 and status = 'otvorena' limit 1`,
    [orgId],
  );
  return rows[0] ?? null;
}

export async function loadActor(sql: Sql, userId: string): Promise<Actor | null> {
  const rows = await sql.query<{
    id: string;
    org_id: string;
    role: string;
    permissions: Perms;
    active: boolean;
  }>(
    `select id, org_id, role, permissions, active from members where user_id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row || !row.active) return null;
  return {
    userId,
    memberId: row.id,
    role: row.role,
    permissions: normalizePerms(row.role as Role, row.permissions),
    orgId: row.org_id,
  };
}

export async function setupOrg(
  sql: Sql,
  user: { userId: string; email: string | null; name: string | null },
  input: {
    name: string;
    legalName?: string | null;
    pib?: string | null;
    mb?: string | null;
    address?: string | null;
    city?: string | null;
    phone?: string | null;
    endHour?: number;
    taxMode?: string;
    initialCash?: string;
    openingDate?: string | null;
    force?: boolean;
  },
): Promise<{ orgId: string; memberId: string }> {
  if (!input.force) {
    const existing = await sql.query<{ id: string }>(`select id from orgs limit 1`);
    if (existing[0]) throw new Error("Objekat je već podešen.");
  }
  const orgId = newId();
  const memberId = newId();
  if (input.endHour == null || !Number.isFinite(input.endHour)) {
    throw new Error("Unesite do kog časa traje poslovni dan. Četiri ujutru nije upisano umesto toga.");
  }
  const end = input.endHour;
  if (end < 0 || end > 12) throw new Error("Kraj poslovnog dana mora biti između 0 i 12 časova.");
  if (input.initialCash == null || String(input.initialCash).trim() === "") {
    throw new Error("Početni novac u kasi nije unet. Ako je fioka prazna, upišite 0.");
  }
  await sql.query(
    `insert into orgs (id, name, legal_name, pib, mb, address, city, phone, business_day_end_hour, tax_mode, initial_cash, opening_stock_date, setup_complete)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)`,
    [
      orgId,
      input.name.trim(),
      input.legalName ?? null,
      input.pib ?? null,
      input.mb ?? null,
      input.address ?? null,
      input.city ?? null,
      input.phone ?? null,
      end,
      input.taxMode ?? "ukljucen",
      mStr(m(input.initialCash)),
      input.openingDate ?? null,
    ],
  );
  const cats: [string, string][] = [
    ["Sirovine", "sirovina"],
    ["Piće", "pice"],
    ["Ambalaža", "ambalaza"],
    ["Poluproizvodi", "poluproizvod"],
    ["Gotovi proizvodi", "gotov"],
    ["Higijena", "higijena"],
    ["Troškovi", "trosak"],
  ];
  for (const [name, kind] of cats) {
    await sql.query(`insert into categories (id, org_id, name, kind) values ($1,$2,$3,$4)`, [
      newId(),
      orgId,
      name,
      kind,
    ]);
  }
  await sql.query(
    `insert into members (id, org_id, user_id, email, display_name, role, permissions)
     values ($1,$2,$3,$4,$5,'super_admin',$6::jsonb)`,
    [memberId, orgId, user.userId, user.email, user.name, JSON.stringify(defaultPerms("super_admin"))],
  );
  await audit(sql, orgId, user.userId, "podesavanje", "org", orgId, null, null, { name: input.name });
  return { orgId, memberId };
}

type Art = {
  id: string;
  tracks_stock: boolean;
  on_hand: string;
  avg_cost: string | null;
  base_unit: string;
  is_demo: boolean;
  name: string;
  last_price: string | null;
};

async function lockArt(sql: Sql, orgId: string, articleId: string): Promise<Art> {
  return one<Art>(
    sql,
    `select id, tracks_stock, on_hand::text, avg_cost::text, base_unit, is_demo, name, last_price::text
     from articles where id = $1 and org_id = $2 for update`,
    [articleId, orgId],
    "Artikal ne postoji u ovom objektu",
  );
}

export async function applyMove(
  sql: Sql,
  args: {
    orgId: string;
    articleId: string;
    qtyDelta: bigint;
    inboundUnitCost: bigint | null;
    kind: string;
    refType: string;
    refId: string;
    businessDate: string;
    occurredAt: string;
    shiftId: string | null;
    userId: string;
    note: string | null;
    demo: boolean;
  },
): Promise<{ value: string | null; complete: boolean; onHand: string; over: boolean; unitCost: string | null }> {
  const art = await lockArt(sql, args.orgId, args.articleId);
  if (!art.tracks_stock) throw new Error(`${art.name} ne vodi zalihu (trošak, ne roba).`);
  let onHand = q(art.on_hand);
  let avg = art.avg_cost != null ? c(art.avg_cost) : null;
  const over = args.qtyDelta < 0n && -args.qtyDelta > onHand;
  let value: bigint | null = null;
  let complete = true;
  let storedCost: bigint | null = null;
  if (args.qtyDelta > 0n && VALUED_IN.has(args.kind)) {
    if (args.inboundUnitCost == null) {
      complete = false;
      onHand += args.qtyDelta;
    } else {
      const next = applyInbound(onHand, avg, args.qtyDelta, args.inboundUnitCost);
      onHand = next.onHand;
      avg = next.avg;
      storedCost = args.inboundUnitCost;
      value = valuePara(args.qtyDelta, args.inboundUnitCost);
    }
  } else if (args.qtyDelta !== 0n) {
    onHand += args.qtyDelta;
    if (avg == null) {
      value = null;
      complete = false;
    } else {
      value = valuePara(args.qtyDelta, avg);
      storedCost = avg;
    }
  }
  await sql.query(`update articles set on_hand = $1, avg_cost = $2 where id = $3`, [
    qStr(onHand),
    avg == null ? null : cStr(avg),
    args.articleId,
  ]);
  await sql.query(
    `insert into stock_moves (id, org_id, article_id, qty, unit_cost, value, kind, ref_type, ref_id, business_date, occurred_at, shift_id, user_id, note, is_demo, voided)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,false)`,
    [
      newId(),
      args.orgId,
      args.articleId,
      qStr(args.qtyDelta),
      storedCost == null ? null : cStr(storedCost),
      value == null ? null : mStr(value),
      args.kind,
      args.refType,
      args.refId,
      args.businessDate,
      args.occurredAt,
      args.shiftId,
      args.userId,
      args.note,
      args.demo,
    ],
  );
  return {
    value: value == null ? null : mStr(value),
    complete,
    onHand: qStr(onHand),
    over,
    unitCost: storedCost == null ? null : cStr(storedCost),
  };
}

async function recomputeArticle(sql: Sql, articleId: string): Promise<void> {
  const moves = await sql.query<{ qty: string; unit_cost: string | null; kind: string }>(
    `select qty::text, unit_cost::text, kind from stock_moves
     where article_id = $1 and voided = false order by occurred_at, id`,
    [articleId],
  );
  let onHand = 0n;
  let avg: bigint | null = null;
  for (const mv of moves) {
    const qty = q(mv.qty);
    if (qty > 0n && VALUED_IN.has(mv.kind) && mv.unit_cost) {
      const next = applyInbound(onHand, avg, qty, c(mv.unit_cost));
      onHand = next.onHand;
      avg = next.avg;
    } else {
      onHand += qty;
    }
  }
  const sum = await one<{ s: string }>(
    sql,
    `select coalesce(sum(qty),0)::text as s from stock_moves where article_id = $1`,
    [articleId],
  );
  await sql.query(`update articles set on_hand = $1, avg_cost = $2 where id = $3`, [
    sum.s,
    avg == null ? null : cStr(avg),
    articleId,
  ]);
}

export async function voidMoves(sql: Sql, refType: string, refId: string, userId: string): Promise<void> {
  const moves = await sql.query<{
    id: string;
    org_id: string;
    article_id: string;
    qty: string;
    kind: string;
    business_date: string | null;
    is_demo: boolean;
  }>(
    `select id, org_id, article_id, qty::text, kind, business_date::text, is_demo
     from stock_moves where ref_type = $1 and ref_id = $2 and voided = false`,
    [refType, refId],
  );
  const articles = new Set<string>();
  for (const mv of moves) {
    await sql.query(`update stock_moves set voided = true where id = $1`, [mv.id]);
    await sql.query(
      `insert into stock_moves (id, org_id, article_id, qty, unit_cost, value, kind, ref_type, ref_id, business_date, occurred_at, user_id, note, is_demo, voided)
       values ($1,$2,$3,$4,null,null,'storno',$5,$6,$7,now(),$8,$9,$10,true)`,
      [
        newId(),
        mv.org_id,
        mv.article_id,
        qStr(-q(mv.qty)),
        refType,
        refId,
        mv.business_date,
        userId,
        "Storno",
        mv.is_demo,
      ],
    );
    articles.add(mv.article_id);
  }
  for (const articleId of articles) await recomputeArticle(sql, articleId);
}

export async function qtyBaseOf(
  sql: Sql,
  articleId: string,
  qty: string,
  unitName: string,
): Promise<bigint> {
  const art = await one<{ base_unit: string }>(sql, `select base_unit from articles where id = $1`, [articleId]);
  const packs = await sql.query<{ name: string; qty_in_base: string }>(
    `select name, qty_in_base::text from article_packs where article_id = $1`,
    [articleId],
  );
  const pack = packs.find((p) => p.name.toLowerCase() === unitName.toLowerCase());
  try {
    return toBaseQty(art.base_unit, unitName, qty, pack ? pack.qty_in_base : null);
  } catch (err) {
    if (err instanceof MoneyError) throw new Error(err.message);
    throw err;
  }
}

export async function saveArticle(
  sql: Sql,
  actor: Actor,
  input: {
    id?: string | null;
    name: string;
    code?: string | null;
    categoryId?: string | null;
    kind: string;
    tracksStock: boolean;
    baseUnit: string;
    minQty?: string;
    barcode?: string | null;
    nextExpiry?: string | null;
    demo?: boolean;
  },
): Promise<string> {
  if (!["g", "ml", "kom"].includes(input.baseUnit)) throw new Error("Osnovna jedinica je g, ml ili kom.");
  const tracks = input.kind === "trosak" ? false : input.tracksStock;
  if (input.id) {
    const prev = await one(
      sql,
      `select name, base_unit, tracks_stock from articles where id = $1 and org_id = $2`,
      [input.id, actor.orgId],
    );
    await sql.query(
      `update articles set name=$1, code=$2, category_id=$3, kind=$4, tracks_stock=$5, base_unit=$6, min_qty=$7, barcode=$8, next_expiry=$9
       where id=$10 and org_id=$11`,
      [
        input.name.trim(),
        input.code ?? null,
        input.categoryId ?? null,
        input.kind,
        tracks,
        input.baseUnit,
        qStr(q(input.minQty ?? "0")),
        input.barcode ?? null,
        input.nextExpiry || null,
        input.id,
        actor.orgId,
      ],
    );
    await audit(sql, actor.orgId, actor.userId, "izmena", "artikal", input.id, null, prev, input);
    return input.id;
  }
  const id = newId();
  await sql.query(
    `insert into articles (id, org_id, code, name, category_id, kind, tracks_stock, base_unit, min_qty, barcode, next_expiry, is_demo)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      actor.orgId,
      input.code ?? null,
      input.name.trim(),
      input.categoryId ?? null,
      input.kind,
      tracks,
      input.baseUnit,
      qStr(q(input.minQty ?? "0")),
      input.barcode ?? null,
      input.nextExpiry || null,
      Boolean(input.demo),
    ],
  );
  await audit(sql, actor.orgId, actor.userId, "unos", "artikal", id, null, null, { name: input.name });
  return id;
}

export async function savePack(
  sql: Sql,
  actor: Actor,
  input: { articleId: string; name: string; qtyInBase: string },
): Promise<void> {
  await lockArt(sql, actor.orgId, input.articleId);
  const factor = q(input.qtyInBase);
  if (factor <= 0n) throw new Error("Pakovanje mora imati pozitivnu količinu.");
  await sql.query(
    `insert into article_packs (id, article_id, name, qty_in_base) values ($1,$2,$3,$4)
     on conflict (article_id, name) do update set qty_in_base = excluded.qty_in_base`,
    [newId(), input.articleId, input.name.trim(), qStr(factor)],
  );
}

export async function saveSupplier(
  sql: Sql,
  actor: Actor,
  input: { id?: string | null; name: string; pib?: string | null; note?: string | null },
): Promise<string> {
  if (input.id) {
    await sql.query(`update suppliers set name=$1, pib=$2, note=$3 where id=$4 and org_id=$5`, [
      input.name.trim(),
      input.pib ?? null,
      input.note ?? null,
      input.id,
      actor.orgId,
    ]);
    return input.id;
  }
  const id = newId();
  await sql.query(`insert into suppliers (id, org_id, name, pib, note) values ($1,$2,$3,$4,$5)`, [
    id,
    actor.orgId,
    input.name.trim(),
    input.pib ?? null,
    input.note ?? null,
  ]);
  return id;
}

export async function saveAlias(
  sql: Sql,
  actor: Actor,
  input: { supplierId: string; supplierName: string; articleId: string },
): Promise<void> {
  await sql.query(
    `insert into supplier_item_map (id, org_id, supplier_id, supplier_name, article_id)
     values ($1,$2,$3,$4,$5)
     on conflict (org_id, supplier_id, supplier_name) do update set article_id = excluded.article_id`,
    [newId(), actor.orgId, input.supplierId, input.supplierName.trim().toLowerCase(), input.articleId],
  );
}

export async function postOpening(
  sql: Sql,
  actor: Actor,
  input: {
    articleId: string;
    qty: string;
    unit: string;
    unitCost: string;
    date: string;
    note?: string | null;
    demo?: boolean;
    idempotencyKey: string;
  },
): Promise<{ id: string; duplicate: boolean }> {
  const claim = await sql.query(
    `insert into idempotency (org_id, key, kind) values ($1,$2,'pocetno') on conflict do nothing returning key`,
    [actor.orgId, input.idempotencyKey],
  );
  if (!claim.length) {
    const prev = await sql.query<{ ref_id: string | null }>(
      `select ref_id from idempotency where org_id=$1 and key=$2`,
      [actor.orgId, input.idempotencyKey],
    );
    return { id: prev[0]?.ref_id ?? "", duplicate: true };
  }
  const prior = await sql.query(
    `select id from stock_moves where article_id = $1 and voided = false limit 1`,
    [input.articleId],
  );
  if (prior.length) throw new Error("Početno stanje je već uneto za ovaj artikal. Dalje ide nabavka, rashod ili popis.");
  const base = await qtyBaseOf(sql, input.articleId, input.qty, input.unit);
  if (base < 0n) throw new Error("Početna količina ne može biti negativna.");
  const costPerEntered = c(input.unitCost);
  const entered = q(input.qty);
  const total = valuePara(entered, costPerEntered);
  const unit = entered === 0n ? costPerEntered : unitCostFromTotal(total, base);
  const at = new Date(`${input.date}T12:00:00`).toISOString();
  const ref = newId();
  await applyMove(sql, {
    orgId: actor.orgId,
    articleId: input.articleId,
    qtyDelta: base,
    inboundUnitCost: unit,
    kind: "pocetno",
    refType: "pocetno",
    refId: ref,
    businessDate: input.date,
    occurredAt: at,
    shiftId: null,
    userId: actor.userId,
    note: input.note ?? "Početno stanje",
    demo: Boolean(input.demo),
  });
  await sql.query(`update orgs set opening_stock_date = coalesce(opening_stock_date, $1) where id = $2`, [
    input.date,
    actor.orgId,
  ]);
  await sql.query(`update idempotency set ref_id = $1 where org_id = $2 and key = $3`, [
    ref,
    actor.orgId,
    input.idempotencyKey,
  ]);
  await audit(sql, actor.orgId, actor.userId, "pocetno", "artikal", input.articleId, null, null, {
    qty: qStr(base),
    date: input.date,
  });
  return { id: ref, duplicate: false };
}

export type InvoiceLineIn = {
  articleId: string | null;
  rawName: string;
  qty: string;
  unitName: string;
  unitPrice: string | null;
  discount: string;
  lineTotal: string | null;
  taxRate: string | null;
  needsReview: boolean;
  expiry: string | null;
};

function lineNet(line: InvoiceLineIn): bigint | null {
  if (line.lineTotal != null && line.lineTotal !== "") return m(line.lineTotal);
  if (line.unitPrice == null || line.unitPrice === "") return null;
  return valuePara(q(line.qty), c(line.unitPrice)) - m(line.discount || "0");
}

export async function upsertInvoice(
  sql: Sql,
  actor: Actor,
  input: {
    id?: string | null;
    supplierId: string | null;
    docNumber: string | null;
    docDate: string | null;
    receivedDate: string | null;
    dueDate: string | null;
    kind: string;
    total: string | null;
    note: string | null;
    demo?: boolean;
    idempotencyKey: string;
    lines: InvoiceLineIn[];
    files?: { name: string; mime: string; dataUrl: string }[];
  },
): Promise<{ id: string; duplicate: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  let invoiceId = input.id ?? null;
  if (!invoiceId) {
    const claim = await sql.query<{ key: string }>(
      `insert into idempotency (org_id, key, kind) values ($1,$2,'racun') on conflict do nothing returning key`,
      [actor.orgId, input.idempotencyKey],
    );
    if (!claim.length) {
      const prev = await sql.query<{ ref_id: string | null }>(
        `select ref_id from idempotency where org_id=$1 and key=$2`,
        [actor.orgId, input.idempotencyKey],
      );
      return { id: prev[0]?.ref_id ?? "", duplicate: true, warnings: ["Isti račun je već sačuvan."] };
    }
    invoiceId = newId();
    await sql.query(
      `insert into invoices (id, org_id, supplier_id, doc_number, doc_date, received_date, due_date, kind, status, total, note, is_demo, idempotency_key, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'nacrt',$9,$10,$11,$12,$13)`,
      [
        invoiceId,
        actor.orgId,
        input.supplierId,
        input.docNumber,
        input.docDate,
        input.receivedDate,
        input.dueDate,
        input.kind,
        input.total != null ? mStr(m(input.total)) : null,
        input.note,
        Boolean(input.demo),
        input.idempotencyKey,
        actor.userId,
      ],
    );
    await sql.query(`update idempotency set ref_id=$1 where org_id=$2 and key=$3`, [
      invoiceId,
      actor.orgId,
      input.idempotencyKey,
    ]);
  } else {
    const cur = await one<{ status: string }>(
      sql,
      `select status from invoices where id=$1 and org_id=$2`,
      [invoiceId, actor.orgId],
    );
    if (cur.status === "proknjizen" || cur.status === "storno" || cur.status === "arhiviran") {
      throw new Error("Knjižen račun se ne menja tiho. Stornirajte ga ili unesite ispravku.");
    }
    await sql.query(
      `update invoices set supplier_id=$1, doc_number=$2, doc_date=$3, received_date=$4, due_date=$5, kind=$6, total=$7, note=$8 where id=$9`,
      [
        input.supplierId,
        input.docNumber,
        input.docDate,
        input.receivedDate,
        input.dueDate,
        input.kind,
        input.total != null ? mStr(m(input.total)) : null,
        input.note,
        invoiceId,
      ],
    );
    await sql.query(`delete from invoice_lines where invoice_id=$1`, [invoiceId]);
    await sql.query(`delete from invoice_files where invoice_id=$1`, [invoiceId]);
  }
  if (input.supplierId && input.docNumber) {
    const dups = await sql.query<{ id: string }>(
      `select id from invoices where org_id=$1 and supplier_id=$2 and doc_number=$3 and id<>$4 and status in ('nacrt','provera','proknjizen')`,
      [actor.orgId, input.supplierId, input.docNumber, invoiceId],
    );
    if (dups.length) warnings.push("Mogući duplikat: isti dobavljač i broj dokumenta već postoje.");
  }
  let sum = 0n;
  let any = false;
  for (const line of input.lines) {
    const net = lineNet(line);
    if (net != null) {
      sum += net;
      any = true;
    }
    let qtyBase: string | null = null;
    if (line.articleId) {
      try {
        qtyBase = qStr(await qtyBaseOf(sql, line.articleId, line.qty, line.unitName));
      } catch (err) {
        warnings.push(err instanceof Error ? err.message : "Jedinica nije jasna");
      }
    }
    await sql.query(
      `insert into invoice_lines (id, invoice_id, article_id, raw_name, qty, unit_name, qty_base, unit_price, discount, line_total, tax_rate, needs_review, expiry)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        newId(),
        invoiceId,
        line.articleId,
        line.rawName.trim() || "bez naziva",
        qStr(q(line.qty)),
        line.unitName,
        qtyBase,
        line.unitPrice != null && line.unitPrice !== "" ? cStr(c(line.unitPrice)) : null,
        mStr(m(line.discount || "0")),
        net == null ? null : mStr(net),
        line.taxRate,
        line.needsReview || !line.articleId,
        line.expiry || null,
      ],
    );
  }
  let mismatch = false;
  if (input.total != null && input.total !== "" && any) {
    const diff = sum - m(input.total);
    const abs = diff < 0n ? -diff : diff;
    if (abs > m("1")) {
      mismatch = true;
      warnings.push("Zbir stavki se ne slaže sa ukupnim iznosom računa.");
    }
  }
  await sql.query(`update invoices set mismatch=$1, unclear=$2 where id=$3`, [
    mismatch,
    input.lines.some((l) => l.needsReview || !l.articleId),
    invoiceId,
  ]);
  for (const file of input.files ?? []) {
    if (file.dataUrl.length > 1_200_000) throw new Error("Fajl je prevelik. Smanjite fotografiju.");
    await sql.query(`insert into invoice_files (id, invoice_id, name, mime, data_url) values ($1,$2,$3,$4,$5)`, [
      newId(),
      invoiceId,
      file.name,
      file.mime,
      file.dataUrl,
    ]);
  }
  return { id: invoiceId, duplicate: false, warnings };
}

export async function postInvoice(
  sql: Sql,
  actor: Actor,
  input: { invoiceId: string; acceptMismatch: boolean; allowDuplicate: boolean; correctionReason?: string | null },
): Promise<{ status: string; warnings: string[] }> {
  const inv = await one<{
    id: string;
    supplier_id: string | null;
    doc_number: string | null;
    doc_date: string | null;
    received_date: string | null;
    kind: string;
    status: string;
    total: string | null;
    mismatch: boolean;
    unclear: boolean;
    is_demo: boolean;
  }>(
    sql,
    `select id, supplier_id, doc_number, doc_date::text, received_date::text, kind, status, total::text, mismatch, unclear, is_demo
     from invoices where id=$1 and org_id=$2 for update`,
    [input.invoiceId, actor.orgId],
  );
  if (inv.status === "proknjizen" || inv.status === "arhiviran" || inv.status === "storno") {
    return { status: inv.status, warnings: ["Račun je već završen. Stanje nije dirano ponovo."] };
  }
  const warnings: string[] = [];
  if (inv.supplier_id && inv.doc_number && !input.allowDuplicate) {
    const dups = await sql.query(
      `select id from invoices where org_id=$1 and supplier_id=$2 and doc_number=$3 and id<>$4 and status='proknjizen'`,
      [actor.orgId, inv.supplier_id, inv.doc_number, inv.id],
    );
    if (dups.length) throw new Error("Isti broj dokumenta ovog dobavljača je već proknjižen. Označite da je ispravka ako to namerno radite.");
  }
  if (inv.mismatch && !input.acceptMismatch) {
    await sql.query(`update invoices set status='provera' where id=$1`, [inv.id]);
    return { status: "provera", warnings: ["Zbir stavki i ukupan iznos se ne slažu. Knjiženje je zaustavljeno."] };
  }
  const lines = await sql.query<{
    id: string;
    article_id: string | null;
    raw_name: string;
    qty: string;
    unit_name: string;
    qty_base: string | null;
    line_total: string | null;
    needs_review: boolean;
    expiry: string | null;
  }>(
    `select id, article_id, raw_name, qty::text, unit_name, qty_base::text, line_total::text, needs_review, expiry::text
     from invoice_lines where invoice_id=$1`,
    [inv.id],
  );
  if (inv.kind === "arhiva") {
    await sql.query(`update invoices set status='arhiviran', posted_at=now() where id=$1`, [inv.id]);
    await audit(sql, actor.orgId, actor.userId, "arhiva", "racun", inv.id, null, null, { kind: inv.kind });
    return { status: "arhiviran", warnings: ["Arhivski račun ne menja zalihu."] };
  }
  const when = inv.received_date || inv.doc_date;
  if (!when) throw new Error("Unesite datum dokumenta ili datum prijema. Današnji dan nije upisan umesto njega.");
  const day = when;
  await assertPeriod(sql, actor.orgId, day, actor.role, input.correctionReason ?? null);
  const shift = await openShiftRow(sql, actor.orgId);
  const problems: string[] = [];
  for (const line of lines) {
    const label = line.raw_name || "bez naziva";
    if (line.needs_review) problems.push(`${label}: označena je kao nejasna. Nije knjižena nagađanjem.`);
    const movesStock = inv.kind === "nabavka" || inv.kind === "povracaj";
    if (!line.article_id) {
      if (movesStock) problems.push(`${label}: nije povezana sa artiklom. Artikal nije izmišljen.`);
      else if (line.line_total == null) problems.push(`${label}: nema iznosa. Nula nije upisana.`);
      continue;
    }
    const art = await lockArt(sql, actor.orgId, line.article_id);
    if (inv.kind === "trosak" || !art.tracks_stock) {
      if (line.line_total == null) problems.push(`${label}: nema iznosa. Trošak nije upisan kao nula.`);
      continue;
    }
    if (line.qty_base == null) {
      problems.push(`${label}: jedinica „${line.unit_name}“ nije poznata. Nije pretvorena u komad ni gram.`);
    } else if (inv.kind === "nabavka" && line.line_total == null && q(line.qty_base) !== 0n) {
      problems.push(`${label}: nema iznosa. Cena nije upisana kao nula.`);
    }
  }
  if (problems.length) {
    await sql.query(`update invoices set status='provera', unclear=true where id=$1`, [inv.id]);
    return { status: "provera", warnings: problems };
  }
  for (const line of lines) {
    if (!line.article_id) {
      await sql.query(
        `insert into expenses (id, org_id, invoice_id, invoice_line_id, article_id, title, amount, category, business_date, occurred_at, user_id, source, is_demo)
         values ($1,$2,$3,$4,null,$5,$6,'trosak',$7,$8,$9,'racun',$10)`,
        [newId(), actor.orgId, inv.id, line.id, line.raw_name, mStr(m(line.line_total ?? "")), day, `${day}T12:00:00.000Z`, actor.userId, inv.is_demo],
      );
      continue;
    }
    const art = await lockArt(sql, actor.orgId, line.article_id);
    if (inv.kind === "trosak" || !art.tracks_stock) {
      await sql.query(
        `insert into expenses (id, org_id, invoice_id, invoice_line_id, article_id, title, amount, category, business_date, occurred_at, user_id, source, is_demo)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'racun',$12)`,
        [
          newId(),
          actor.orgId,
          inv.id,
          line.id,
          line.article_id,
          line.raw_name,
          mStr(m(line.line_total ?? "")),
          art.tracks_stock ? null : "trosak",
          day,
          `${day}T12:00:00.000Z`,
          actor.userId,
          inv.is_demo,
        ],
      );
      continue;
    }
    const base = q(line.qty_base ?? "0");
    if (base === 0n) {
      warnings.push(`${line.raw_name}: količina je nula, zaliha nije dirana.`);
      continue;
    }
    if (inv.kind === "povracaj") {
      await applyMove(sql, {
        orgId: actor.orgId,
        articleId: line.article_id,
        qtyDelta: -base,
        inboundUnitCost: null,
        kind: "povrat_dobavljacu",
        refType: "racun",
        refId: inv.id,
        businessDate: day,
        occurredAt: `${day}T12:00:00.000Z`,
        shiftId: shift?.id ?? null,
        userId: actor.userId,
        note: inv.doc_number,
        demo: inv.is_demo,
      });
    } else {
      const net = m(line.line_total ?? "");
      const unit = unitCostFromTotal(net, base);
      await applyMove(sql, {
        orgId: actor.orgId,
        articleId: line.article_id,
        qtyDelta: base,
        inboundUnitCost: unit,
        kind: "nabavka",
        refType: "racun",
        refId: inv.id,
        businessDate: day,
        occurredAt: `${day}T12:00:00.000Z`,
        shiftId: shift?.id ?? null,
        userId: actor.userId,
        note: inv.doc_number,
        demo: inv.is_demo,
      });
      await sql.query(
        `update articles set prev_price = last_price, last_price = $1, next_expiry = coalesce($2, next_expiry) where id = $3`,
        [cStr(unit), line.expiry, line.article_id],
      );
      await sql.query(
        `insert into price_history (id, article_id, unit_price, qty, source, ref_id) values ($1,$2,$3,$4,'racun',$5)`,
        [newId(), line.article_id, cStr(unit), qStr(base), inv.id],
      );
      if (inv.supplier_id) {
        await saveAlias(sql, actor, {
          supplierId: inv.supplier_id,
          supplierName: line.raw_name,
          articleId: line.article_id,
        });
      }
    }
  }
  await sql.query(`update invoices set status='proknjizen', posted_at=now() where id=$1`, [inv.id]);
  await audit(sql, actor.orgId, actor.userId, "knjizenje", "racun", inv.id, input.correctionReason ?? null, null, {
    kind: inv.kind,
  });
  return { status: "proknjizen", warnings };
}

export async function voidInvoice(sql: Sql, actor: Actor, invoiceId: string, reason: string): Promise<void> {
  if (!reason.trim()) throw new Error("Storno traži razlog.");
  const inv = await one<{ status: string; doc_date: string | null }>(
    sql,
    `select status, doc_date::text from invoices where id=$1 and org_id=$2`,
    [invoiceId, actor.orgId],
  );
  if (inv.status !== "proknjizen") throw new Error("Storno je samo za proknjižen račun.");
  if (inv.doc_date) await assertPeriod(sql, actor.orgId, inv.doc_date, actor.role, reason);
  await voidMoves(sql, "racun", invoiceId, actor.userId);
  await sql.query(`update expenses set voided=true where invoice_id=$1`, [invoiceId]);
  await sql.query(`update invoices set status='storno' where id=$1`, [invoiceId]);
  await audit(sql, actor.orgId, actor.userId, "storno", "racun", invoiceId, reason, { status: "proknjizen" }, { status: "storno" });
}

export async function payInvoice(
  sql: Sql,
  actor: Actor,
  input: { invoiceId: string; amount: string; method: string; fromCash: boolean; paidAt?: string | null; note?: string | null; idempotencyKey: string },
): Promise<{ duplicate: boolean }> {
  const claim = await sql.query(
    `insert into idempotency (org_id, key, kind) values ($1,$2,'uplata') on conflict do nothing returning key`,
    [actor.orgId, input.idempotencyKey],
  );
  if (!claim.length) return { duplicate: true };
  const inv = await one<{ id: string; is_demo: boolean; status: string }>(
    sql,
    `select id, is_demo, status from invoices where id=$1 and org_id=$2`,
    [input.invoiceId, actor.orgId],
  );
  if (inv.status === "nacrt" || inv.status === "storno") throw new Error("Uplata ide na proknjižen ili proveren račun, ne na storno.");
  const stampAt = await stamp(sql, actor.orgId, input.paidAt);
  await assertPeriod(sql, actor.orgId, stampAt.day, actor.role, null);
  const amount = m(input.amount);
  if (amount <= 0n) throw new Error("Iznos uplate mora biti pozitivan.");
  const shift = await openShiftRow(sql, actor.orgId);
  const payId = newId();
  await sql.query(
    `insert into payments (id, org_id, invoice_id, amount, method, from_cash, paid_at, business_date, shift_id, note, user_id, idempotency_key, is_demo)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      payId,
      actor.orgId,
      inv.id,
      mStr(amount),
      input.method,
      input.fromCash,
      stampAt.at,
      stampAt.day,
      shift?.id ?? null,
      input.note ?? null,
      actor.userId,
      input.idempotencyKey,
      inv.is_demo,
    ],
  );
  if (input.fromCash) {
    await sql.query(
      `insert into cash_events (id, org_id, shift_id, kind, amount, ref_type, ref_id, note, user_id, occurred_at, business_date, idempotency_key, is_demo)
       values ($1,$2,$3,'isplata',$4,'uplata',$5,$6,$7,$8,$9,$10,$11)`,
      [
        newId(),
        actor.orgId,
        shift?.id ?? null,
        mStr(amount),
        payId,
        input.note ?? "Uplata dobavljaču",
        actor.userId,
        stampAt.at,
        stampAt.day,
        input.idempotencyKey,
        inv.is_demo,
      ],
    );
  }
  await sql.query(`update idempotency set ref_id=$1 where org_id=$2 and key=$3`, [payId, actor.orgId, input.idempotencyKey]);
  await audit(sql, actor.orgId, actor.userId, "uplata", "racun", inv.id, null, null, { amount: mStr(amount), method: input.method });
  return { duplicate: false };
}
