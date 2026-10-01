import { assertCan, defaultPerms } from "./perms.ts";
import { setupOrg, saveArticle, savePack, saveSupplier, postOpening, upsertInvoice, postInvoice, type Actor, type Sql } from "./engine.ts";
import {
  closeShift,
  expectedCashOf,
  openShift,
  postProduction,
  postRefund,
  postSale,
  postWaste,
  addCashMove,
  saveProduct,
  saveRecipe,
  setCountQty,
  snapshot,
  startCount,
  stockRow,
  postCount,
} from "./engine-ops.ts";
import { mStr } from "./money.ts";

export type Check = { name: string; ok: boolean; detail: string };

function push(list: Check[], name: string, ok: boolean, detail: string) {
  list.push({ name, ok, detail });
}

async function art(sql: Sql, actor: Actor, name: string, unit: "g" | "ml" | "kom", priceHint?: string) {
  const id = await saveArticle(sql, actor, {
    name,
    kind: unit === "kom" && name.toLowerCase().includes("ambala") ? "ambalaza" : "sirovina",
    tracksStock: true,
    baseUnit: unit,
    minQty: "0",
  });
  return id;
}

export async function runProof(sql: Sql): Promise<Check[]> {
  const checks: Check[] = [];
  const userId = "proof-user";
  const setup = await setupOrg(sql, { userId, email: "vlasnik@primer.rs", name: "Provera" }, {
    name: "Provera obračuna",
    endHour: 4,
    initialCash: "0",
    openingDate: "2026-04-01",
    force: true,
  });
  const actor: Actor = {
    userId,
    memberId: setup.memberId,
    role: "super_admin",
    permissions: defaultPerms("super_admin"),
    orgId: setup.orgId,
  };

  const cheese = await art(sql, actor, "Sir", "g");
  const meat = await art(sql, actor, "Pljeskavica", "g");
  const sauce = await art(sql, actor, "Sos", "g");
  const pack = await art(sql, actor, "Ambalaža", "kom");
  const bun = await art(sql, actor, "Zemička", "kom");
  const flour = await art(sql, actor, "Brašno", "g");
  const dough = await saveArticle(sql, actor, {
    name: "Testo porcije",
    kind: "poluproizvod",
    tracksStock: true,
    baseUnit: "kom",
  });
  await savePack(sql, actor, { articleId: bun, name: "karton", qtyInBase: "20" });

  await openShift(sql, actor, { openingCash: "5000" });

  await postOpening(sql, actor, {
    articleId: cheese, qty: "4000", unit: "g", unitCost: "0.80", date: "2026-04-01", idempotencyKey: "op-sir",
  });
  await postOpening(sql, actor, {
    articleId: meat, qty: "5000", unit: "g", unitCost: "0.90", date: "2026-04-01", idempotencyKey: "op-meso",
  });
  await postOpening(sql, actor, {
    articleId: sauce, qty: "1000", unit: "g", unitCost: "0.40", date: "2026-04-01", idempotencyKey: "op-sos",
  });
  await postOpening(sql, actor, {
    articleId: pack, qty: "100", unit: "kom", unitCost: "8", date: "2026-04-01", idempotencyKey: "op-amb",
  });
  await postOpening(sql, actor, {
    articleId: flour, qty: "1000", unit: "g", unitCost: "0.10", date: "2026-04-01", idempotencyKey: "op-brasno",
  });

  const cheeseAfterOpen = await stockRow(sql, cheese);
  push(checks, "Početno stanje povećava zalihu", cheeseAfterOpen.onHand === "4000.0000", `sir ${cheeseAfterOpen.onHand} g, cena ${cheeseAfterOpen.avg}`);

  const supplier = await saveSupplier(sql, actor, { name: "Pekara" });
  const draft = await upsertInvoice(sql, actor, {
    supplierId: supplier,
    docNumber: "IF-1",
    docDate: "2026-04-01",
    receivedDate: "2026-04-01",
    dueDate: null,
    kind: "nabavka",
    total: "800",
    note: null,
    idempotencyKey: "inv-1",
    lines: [{
      articleId: bun, rawName: "Zemicka karton", qty: "2", unitName: "karton", unitPrice: "400",
      discount: "0", lineTotal: "800", taxRate: null, needsReview: false, expiry: null,
    }],
  });
  await postInvoice(sql, actor, { invoiceId: draft.id, acceptMismatch: false, allowDuplicate: false });
  const again = await postInvoice(sql, actor, { invoiceId: draft.id, acceptMismatch: false, allowDuplicate: false });
  const buns = await stockRow(sql, bun);
  push(checks, "Isti račun se ne knjiži dvaput", again.status === "proknjizen" && buns.onHand === "40.0000", `zemičke ${buns.onHand}, drugi poziv ${again.status}`);
  push(checks, "Karton postaje komadi", buns.onHand === "40.0000" && buns.avg === "20.000000", `2 kartona × 20 = ${buns.onHand}, cena ${buns.avg}`);

  let dupBlocked = false;
  try {
    const other = await upsertInvoice(sql, actor, {
      supplierId: supplier, docNumber: "IF-1", docDate: "2026-04-01", receivedDate: "2026-04-01", dueDate: null,
      kind: "nabavka", total: "800", note: null, idempotencyKey: "inv-dup",
      lines: [{
        articleId: bun, rawName: "Zemicka karton", qty: "2", unitName: "karton", unitPrice: "400",
        discount: "0", lineTotal: "800", taxRate: null, needsReview: false, expiry: null,
      }],
    });
    await postInvoice(sql, actor, { invoiceId: other.id, acceptMismatch: false, allowDuplicate: false });
  } catch {
    dupBlocked = true;
  }
  const bunsAfterDup = await stockRow(sql, bun);
  push(checks, "Dupli broj dokumenta ne povećava zalihu", dupBlocked && bunsAfterDup.onHand === "40.0000", `zaliha ${bunsAfterDup.onHand}`);

  const archived = await upsertInvoice(sql, actor, {
    supplierId: supplier, docNumber: "STARI-1", docDate: "2025-01-01", receivedDate: "2025-01-01", dueDate: null,
    kind: "arhiva", total: "1000", note: "samo arhiva", idempotencyKey: "inv-ar",
    lines: [{
      articleId: cheese, rawName: "Sir stari", qty: "1000", unitName: "g", unitPrice: "0.80",
      discount: "0", lineTotal: "800", taxRate: null, needsReview: false, expiry: null,
    }],
  });
  const archStatus = await postInvoice(sql, actor, { invoiceId: archived.id, acceptMismatch: true, allowDuplicate: false });
  const cheeseAfterArch = await stockRow(sql, cheese);
  push(checks, "Arhivski račun ne dira početno stanje", archStatus.status === "arhiviran" && cheeseAfterArch.onHand === "4000.0000", `status ${archStatus.status}, sir ${cheeseAfterArch.onHand}`);

  const burger = await saveProduct(sql, actor, { name: "Burger", sellPrice: "500", consumeMode: "recept", saleUnit: "kom" });
  const version = await saveRecipe(sql, actor, {
    productId: burger,
    validFrom: "2026-01-01T00:00:00.000Z",
    lines: [
      { articleId: meat, qty: "150", unit: "g", role: "sastojak" },
      { articleId: bun, qty: "1", unit: "kom", role: "sastojak" },
      { articleId: cheese, qty: "20", unit: "g", role: "sastojak" },
      { articleId: sauce, qty: "15", unit: "g", role: "sastojak" },
      { articleId: pack, qty: "1", unit: "kom", role: "ambalaza" },
    ],
  });
  const sale = await postSale(sql, actor, {
    externalKey: "sale-10",
    channel: "lokal",
    tenderCash: "5000",
    lines: [{ productId: burger, name: "Burger", qty: "10", unitPrice: "500", lineNet: "5000" }],
    occurredAt: "2026-09-30T10:00:00.000Z",
  });
  const used = await sql.query<{ qty: string; unit_cost: string | null; value: string | null }>(
    `select c.qty::text, c.unit_cost::text, c.value::text
     from sale_consumptions c join sale_lines l on l.id = c.sale_line_id
     where l.sale_id = $1 and c.article_id = $2`,
    [sale.id, cheese],
  );
  const cheeseAfterSale = await stockRow(sql, cheese);
  push(
    checks,
    "Prodaja troši sastojke po recepturi",
    used[0]?.qty === "200.0000" && cheeseAfterSale.onHand === "3800.0000" && (await stockRow(sql, bun)).onHand === "30.0000",
    `sir utrošen ${used[0]?.qty}, ostalo ${cheeseAfterSale.onHand}, zemičke ${(await stockRow(sql, bun)).onHand}`,
  );
  const saleRow = await sql.query<{ cost_value: string; cost_complete: boolean }>(
    `select cost_value::text, cost_complete from sales where id=$1`,
    [sale.id],
  );
  push(checks, "Trošak prodaje je poznat i nije nula", saleRow[0]?.cost_complete === true && saleRow[0]?.cost_value === "1850.00", `trošak ${saleRow[0]?.cost_value}`);

  const replay = await postSale(sql, actor, {
    externalKey: "sale-10",
    tenderCash: "5000",
    lines: [{ productId: burger, name: "Burger", qty: "10", unitPrice: "500", lineNet: "5000" }],
  });
  push(checks, "Isti izveštaj prodaje ne skida namirnice dvaput", replay.duplicate === true && (await stockRow(sql, cheese)).onHand === "3800.0000", `duplikat ${replay.duplicate}`);

  const waste = await postWaste(sql, actor, {
    articleId: cheese, qty: "100", unit: "g", reason: "kvarenje", allowOver: false, idempotencyKey: "w-1",
    occurredAt: "2026-09-30T13:00:00.000Z",
  });
  const cheeseAfterWaste = await stockRow(sql, cheese);
  push(checks, "Rashod umanjuje zalihu i ima vrednost", waste.value === "80.00" && cheeseAfterWaste.onHand === "3700.0000", `vrednost ${waste.value}, stanje ${cheeseAfterWaste.onHand}`);

  const countId = await startCount(sql, actor, { scope: "sve" });
  const expectedLine = await sql.query<{ expected_qty: string }>(
    `select expected_qty::text from count_lines where count_id=$1 and article_id=$2`,
    [countId, cheese],
  );
  const countItems = await sql.query<{ article_id: string; expected_qty: string }>(
    `select article_id, expected_qty::text from count_lines where count_id=$1`,
    [countId],
  );
  for (const item of countItems) {
    await setCountQty(sql, actor, countId, item.article_id, item.article_id === cheese ? "3600" : item.expected_qty);
  }
  await postCount(sql, actor, countId);
  const countLine = await sql.query<{ diff_qty: string; value: string }>(
    `select diff_qty::text, value::text from count_lines where count_id=$1 and article_id=$2`,
    [countId, cheese],
  );
  const wasteCount = await sql.query<{ n: number }>(
    `select count(*)::int as n from wastes where org_id=$1 and article_id=$2`,
    [actor.orgId, cheese],
  );
  const cheeseAfterCount = await stockRow(sql, cheese);
  push(
    checks,
    "Popis pokazuje manjak i ne ponavlja rashod",
    expectedLine[0]?.expected_qty === "3700.0000" && countLine[0]?.diff_qty === "-100.0000" && Number(wasteCount[0]?.n) === 1 && cheeseAfterCount.onHand === "3600.0000",
    `očekivano ${expectedLine[0]?.expected_qty}, razlika ${countLine[0]?.diff_qty}, rashoda ${wasteCount[0]?.n}, stanje ${cheeseAfterCount.onHand}`,
  );

  await saveRecipe(sql, actor, {
    productId: burger,
    validFrom: "2026-12-01T00:00:00.000Z",
    note: "nova",
    lines: [
      { articleId: meat, qty: "150", unit: "g", role: "sastojak" },
      { articleId: bun, qty: "1", unit: "kom", role: "sastojak" },
      { articleId: cheese, qty: "30", unit: "g", role: "sastojak" },
      { articleId: sauce, qty: "15", unit: "g", role: "sastojak" },
      { articleId: pack, qty: "1", unit: "kom", role: "ambalaza" },
    ],
  });
  const usedAfter = await sql.query<{ qty: string; version: string | null }>(
    `select c.qty::text, l.recipe_version_id as version from sale_consumptions c
     join sale_lines l on l.id = c.sale_line_id where l.sale_id=$1 and c.article_id=$2`,
    [sale.id, cheese],
  );
  push(checks, "Nova receptura ne menja stari obračun", usedAfter[0]?.qty === "200.0000" && usedAfter[0]?.version === version, `stari utrošak ${usedAfter[0]?.qty}`);

  const oldCost = used[0]?.unit_cost;
  const more = await upsertInvoice(sql, actor, {
    supplierId: supplier, docNumber: "IF-2", docDate: "2026-09-30", receivedDate: "2026-09-30", dueDate: null,
    kind: "nabavka", total: "1600", note: null, idempotencyKey: "inv-sir",
    lines: [{
      articleId: cheese, rawName: "Sir", qty: "1000", unitName: "g", unitPrice: "1.60",
      discount: "0", lineTotal: "1600", taxRate: null, needsReview: false, expiry: null,
    }],
  });
  await postInvoice(sql, actor, { invoiceId: more.id, acceptMismatch: false, allowDuplicate: false });
  const costStill = await sql.query<{ unit_cost: string }>(
    `select unit_cost::text from sale_consumptions c join sale_lines l on l.id=c.sale_line_id where l.sale_id=$1 and c.article_id=$2`,
    [sale.id, cheese],
  );
  push(checks, "Nova nabavna cena ne menja stari trošak", costStill[0]?.unit_cost === oldCost, `stara cena ${oldCost}, i dalje ${costStill[0]?.unit_cost}`);

  await postProduction(sql, actor, {
    outputArticleId: dough,
    plannedQty: "10",
    actualQty: "8",
    idempotencyKey: "prod-1",
    occurredAt: "2026-09-30T11:00:00.000Z",
    lines: [{ articleId: flour, qty: "500", unit: "g" }],
  });
  const kifla = await saveProduct(sql, actor, {
    name: "Kifla", sellPrice: "80", saleUnit: "kom", consumeMode: "zaliha", outputArticleId: dough,
  });
  await postSale(sql, actor, {
    externalKey: "sale-kifla",
    tenderCard: "160",
    occurredAt: "2026-09-30T12:00:00.000Z",
    lines: [{ productId: kifla, name: "Kifla", qty: "2", unitPrice: "80", lineNet: "160" }],
  });
  const flourLeft = await stockRow(sql, flour);
  const doughLeft = await stockRow(sql, dough);
  push(
    checks,
    "Proizvodnja pa prodaja ne troši sirovinu dvaput",
    flourLeft.onHand === "500.0000" && doughLeft.onHand === "6.0000",
    `brašno ${flourLeft.onHand}, testo ${doughLeft.onHand}`,
  );

  const beforeRefund = await stockRow(sql, cheese);
  await postRefund(sql, actor, {
    saleId: sale.id, amount: "500", method: "kes", restoresStock: false, reason: "Gost odustao, jelo je pripremljeno", idempotencyKey: "ref-1",
    occurredAt: "2026-09-30T14:00:00.000Z",
  });
  const afterRefund = await stockRow(sql, cheese);
  push(checks, "Povraćaj novca ne vraća sirovinu", beforeRefund.onHand === afterRefund.onHand, `pre ${beforeRefund.onHand}, posle ${afterRefund.onHand}`);

  await postSale(sql, actor, {
    externalKey: "sale-card",
    tenderCard: "500",
    occurredAt: "2026-09-30T15:00:00.000Z",
    lines: [{ productId: burger, name: "Burger", qty: "1", unitPrice: "500", lineNet: "500" }],
  });
  await addCashMove(sql, actor, { kind: "polog", amount: "1000", note: "Polog", idempotencyKey: "drop-1" });
  const shift = await sql.query<{ id: string }>(`select id from shifts where org_id=$1 and status='otvorena'`, [actor.orgId]);
  const expected = await expectedCashOf(sql, shift[0].id);
  const closed = await closeShift(sql, actor, { counted: mStr(expected), note: "Tačno" });
  const snap = await snapshot(sql, actor.orgId, "2026-04-01", "2099-12-31", false);
  const revenueDirect = await sql.query<{ net: string }>(
    `select coalesce(sum(net),0)::text as net from sales where org_id=$1 and status='proknjizen' and reconcile_only=false and business_date between '2026-04-01' and '2099-12-31'`,
    [actor.orgId],
  );
  push(
    checks,
    "Kartica i polog nisu gotovina niti umanjuju promet",
    closed.expected === "8500.00" && snap.card === "660.00" && snap.drops === "1000.00" && snap.revenue === revenueDirect[0]?.net,
    `očekivana kasa ${closed.expected}, kartice ${snap.card}, polog ${snap.drops}, promet ${snap.revenue}`,
  );
  // cash: 5000 open + 5000 sale - 500 refund - 1000 drop = 8500. Cards: kifla 160 + burger 500 = 660.

  const night = await postSale(sql, actor, {
    externalKey: "night",
    tenderCard: "100",
    occurredAt: "2026-04-01T22:30:00.000Z",
    lines: [{ productId: null, name: "Posle ponoći", qty: "1", unitPrice: "100", lineNet: "100" }],
  });
  const nightRow = await sql.query<{ business_date: string }>(`select business_date::text from sales where id=$1`, [night.id]);
  const morning = await postSale(sql, actor, {
    externalKey: "morning",
    tenderCard: "100",
    occurredAt: "2026-04-02T03:00:00.000Z",
    lines: [{ productId: null, name: "Ujutru", qty: "1", unitPrice: "100", lineNet: "100" }],
  });
  const morningRow = await sql.query<{ business_date: string }>(`select business_date::text from sales where id=$1`, [morning.id]);
  push(
    checks,
    "Prodaja posle ponoći pripada prethodnom poslovnom danu",
    nightRow[0]?.business_date === "2026-04-01" && morningRow[0]?.business_date === "2026-04-02",
    `00:30 → ${nightRow[0]?.business_date}, 05:00 → ${morningRow[0]?.business_date}`,
  );

  let blocked = false;
  try {
    assertCan("knjigovodja", defaultPerms("knjigovodja"), "rashod", true);
  } catch {
    blocked = true;
  }
  const canRead = (() => {
    try {
      assertCan("knjigovodja", defaultPerms("knjigovodja"), "izvestaji", false);
      return true;
    } catch {
      return false;
    }
  })();
  push(checks, "Knjigovođa čita izveštaje i ne menja zalihu", blocked && canRead, `zabrana upisa ${blocked}, čitanje ${canRead}`);

  const remembered = await stockRow(sql, cheese);
  const againStock = await stockRow(sql, cheese);
  push(checks, "Stanje ostaje sačuvano u bazi", againStock.onHand === remembered.onHand && remembered.onHand !== "0.0000", `pročitano ${remembered.onHand}, ponovo ${againStock.onHand}`);

  return checks;
}
