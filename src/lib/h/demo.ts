import { postInvoice, postOpening, saveArticle, savePack, saveSupplier, upsertInvoice, type Actor, type Sql } from "./engine.ts";
import { postSale, saveProduct, saveRecipe } from "./engine-ops.ts";

export async function seedDemo(sql: Sql, actor: Actor): Promise<{ created: boolean }> {
  const existing = await sql.query(`select id from articles where org_id = $1 and is_demo = true limit 1`, [actor.orgId]);
  if (existing.length) return { created: false };
  const cheese = await saveArticle(sql, actor, { name: "Sir (proba)", kind: "sirovina", tracksStock: true, baseUnit: "g", demo: true });
  const meat = await saveArticle(sql, actor, { name: "Pljeskavica (proba)", kind: "sirovina", tracksStock: true, baseUnit: "g", demo: true });
  const sauce = await saveArticle(sql, actor, { name: "Sos (proba)", kind: "sirovina", tracksStock: true, baseUnit: "g", demo: true });
  const wrap = await saveArticle(sql, actor, { name: "Ambalaža (proba)", kind: "ambalaza", tracksStock: true, baseUnit: "kom", demo: true });
  const bun = await saveArticle(sql, actor, { name: "Zemička (proba)", kind: "sirovina", tracksStock: true, baseUnit: "kom", demo: true });
  await savePack(sql, actor, { articleId: bun, name: "karton", qtyInBase: "20" });
  const day = "2026-04-01";
  await postOpening(sql, actor, { articleId: cheese, qty: "4000", unit: "g", unitCost: "0.80", date: day, idempotencyKey: "demo-op-sir", demo: true });
  await postOpening(sql, actor, { articleId: meat, qty: "3000", unit: "g", unitCost: "0.90", date: day, idempotencyKey: "demo-op-meso", demo: true });
  await postOpening(sql, actor, { articleId: sauce, qty: "1000", unit: "g", unitCost: "0.40", date: day, idempotencyKey: "demo-op-sos", demo: true });
  await postOpening(sql, actor, { articleId: wrap, qty: "80", unit: "kom", unitCost: "8", date: day, idempotencyKey: "demo-op-amb", demo: true });
  const supplier = await saveSupplier(sql, actor, { name: "Pekara (proba)" });
  const inv = await upsertInvoice(sql, actor, {
    supplierId: supplier,
    docNumber: "PROBA-1",
    docDate: day,
    receivedDate: day,
    dueDate: null,
    kind: "nabavka",
    total: "800",
    note: "Probni račun",
    demo: true,
    idempotencyKey: "demo-inv-1",
    lines: [{
      articleId: bun, rawName: "Zemicka karton", qty: "2", unitName: "karton", unitPrice: "400",
      discount: "0", lineTotal: "800", taxRate: null, needsReview: false, expiry: null,
    }],
  });
  await postInvoice(sql, actor, { invoiceId: inv.id, acceptMismatch: false, allowDuplicate: false });
  const burger = await saveProduct(sql, actor, { name: "Burger (proba)", sellPrice: "500", saleUnit: "kom", consumeMode: "recept", demo: true });
  await saveRecipe(sql, actor, {
    productId: burger,
    validFrom: "2026-01-01T00:00:00.000Z",
    lines: [
      { articleId: meat, qty: "150", unit: "g", role: "sastojak" },
      { articleId: bun, qty: "1", unit: "kom", role: "sastojak" },
      { articleId: cheese, qty: "20", unit: "g", role: "sastojak" },
      { articleId: sauce, qty: "15", unit: "g", role: "sastojak" },
      { articleId: wrap, qty: "1", unit: "kom", role: "ambalaza" },
    ],
  });
  await postSale(sql, actor, {
    externalKey: "demo-sale-10",
    tenderCash: "5000",
    demo: true,
    occurredAt: "2026-04-01T16:00:00.000Z",
    note: "Probni dan",
    lines: [{ productId: burger, name: "Burger (proba)", qty: "10", unitPrice: "500", lineNet: "5000" }],
  });
  return { created: true };
}

export async function wipeDemo(sql: Sql, orgId: string): Promise<void> {
  const mixed = await sql.query(
    `select 1 from recipe_lines rl
     join recipe_versions rv on rv.id = rl.version_id
     join products p on p.id = rv.product_id
     join articles a on a.id = rl.article_id
     where p.org_id = $1 and p.is_demo = false and a.is_demo = true limit 1`,
    [orgId],
  );
  if (mixed.length) throw new Error("Probni artikal je u pravoj recepturi. Prvo ga zamenite, pa obrišite probu.");
  await sql.query(
    `delete from sale_consumptions where sale_line_id in (
      select l.id from sale_lines l join sales s on s.id = l.sale_id where s.org_id = $1 and s.is_demo = true)`,
    [orgId],
  );
  await sql.query(`delete from sale_lines where sale_id in (select id from sales where org_id = $1 and is_demo = true)`, [orgId]);
  await sql.query(`delete from sales where org_id = $1 and is_demo = true`, [orgId]);
  await sql.query(
    `delete from production_lines where batch_id in (select id from production_batches where org_id = $1 and is_demo = true)`,
    [orgId],
  );
  await sql.query(`delete from production_batches where org_id = $1 and is_demo = true`, [orgId]);
  await sql.query(`delete from wastes where org_id = $1 and is_demo = true`, [orgId]);
  await sql.query(`delete from cash_events where org_id = $1 and is_demo = true`, [orgId]);
  await sql.query(`delete from payments where org_id = $1 and is_demo = true`, [orgId]);
  await sql.query(`delete from expenses where org_id = $1 and is_demo = true`, [orgId]);
  await sql.query(
    `delete from invoice_lines where invoice_id in (select id from invoices where org_id = $1 and is_demo = true)`,
    [orgId],
  );
  await sql.query(
    `delete from invoice_files where invoice_id in (select id from invoices where org_id = $1 and is_demo = true)`,
    [orgId],
  );
  await sql.query(`delete from invoices where org_id = $1 and is_demo = true`, [orgId]);
  await sql.query(`delete from stock_moves where org_id = $1 and is_demo = true`, [orgId]);
  await sql.query(
    `delete from recipe_lines where version_id in (
      select rv.id from recipe_versions rv join products p on p.id = rv.product_id where p.org_id = $1 and p.is_demo = true)`,
    [orgId],
  );
  await sql.query(
    `delete from recipe_versions where product_id in (select id from products where org_id = $1 and is_demo = true)`,
    [orgId],
  );
  await sql.query(`delete from pos_map where product_id in (select id from products where org_id = $1 and is_demo = true)`, [orgId]);
  await sql.query(`delete from products where org_id = $1 and is_demo = true`, [orgId]);
  await sql.query(
    `delete from price_history where article_id in (select id from articles where org_id = $1 and is_demo = true)`,
    [orgId],
  );
  await sql.query(
    `delete from supplier_item_map where article_id in (select id from articles where org_id = $1 and is_demo = true)`,
    [orgId],
  );
  await sql.query(
    `delete from article_packs where article_id in (select id from articles where org_id = $1 and is_demo = true)`,
    [orgId],
  );
  await sql.query(`delete from articles where org_id = $1 and is_demo = true`, [orgId]);
  await sql.query(`delete from suppliers where org_id = $1 and name like '%(proba)'`, [orgId]);
  await sql.query(
    `update articles a set on_hand = coalesce((select sum(qty) from stock_moves m where m.article_id = a.id), 0)
     where a.org_id = $1`,
    [orgId],
  );
}
