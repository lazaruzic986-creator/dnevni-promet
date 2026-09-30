import type { Actor, InvoiceLineIn, Sql } from "./engine.ts";
import {
  audit,
  openShiftRow,
  payInvoice,
  postInvoice,
  postOpening,
  qtyBaseOf,
  saveArticle,
  savePack,
  saveSupplier,
  stamp,
  upsertInvoice,
  voidInvoice,
} from "./engine.ts";
import {
  addCashMove,
  closeShift,
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
import { c, m, mStr, q, qStr, valuePara } from "./money.ts";
import { assertCan, type PermKey } from "./perms.ts";

export type Body = Record<string, unknown>;

export type BotAction = { op: string; body: Body };

const OP_ALIAS: Record<string, string> = {
  artikal: "artikal",
  pakovanje: "pakovanje",
  pocetno: "pocetno",
  dobavljac: "dobavljac",
  proizvod: "proizvod",
  receptura: "receptura",
  racun: "racun",
  nabavka: "racun",
  prodaja: "prodaja",
  rashod: "rashod",
  proizvodnja: "proizvodnja",
  popis: "popis",
  trosak: "trosak",
  kasa: "kasa",
  smena_otvori: "smena_otvori",
  otvori_smenu: "smena_otvori",
  otvaranje: "smena_otvori",
  smena_zatvori: "smena_zatvori",
  zatvaranje: "smena_zatvori",
  zatvori_dan: "smena_zatvori",
  uplata: "uplata",
  porudzbina: "porudzbina",
  katalog: "katalog",
  storno_racun: "storno_racun",
  storno_prodaje: "storno_prodaje",
  povracaj: "povracaj",
};

const NEEDS_KEY = new Set([
  "pocetno",
  "racun",
  "prodaja",
  "rashod",
  "proizvodnja",
  "popis",
  "trosak",
  "kasa",
  "uplata",
  "porudzbina",
  "storno_racun",
  "storno_prodaje",
  "povracaj",
]);

const PACKET: { keys: string[]; op: string }[] = [
  { keys: ["artikli", "artikal"], op: "artikal" },
  { keys: ["pakovanja", "pakovanje"], op: "pakovanje" },
  { keys: ["pocetna", "pocetno"], op: "pocetno" },
  { keys: ["dobavljaci", "dobavljac"], op: "dobavljac" },
  { keys: ["proizvodi", "proizvod"], op: "proizvod" },
  { keys: ["recepture", "receptura"], op: "receptura" },
  { keys: ["racuni", "racun"], op: "racun" },
  { keys: ["proizvodnje", "proizvodnja"], op: "proizvodnja" },
  { keys: ["prodaje", "prodaja"], op: "prodaja" },
  { keys: ["rashodi", "rashod"], op: "rashod" },
  { keys: ["troskovi", "trosak"], op: "trosak" },
  { keys: ["kasa"], op: "kasa" },
  { keys: ["popisi", "popis"], op: "popis" },
  { keys: ["porudzbine", "porudzbina"], op: "porudzbina" },
  { keys: ["uplate", "uplata"], op: "uplata" },
  { keys: ["otvaranje", "smena_otvori"], op: "smena_otvori" },
  { keys: ["zatvaranje", "smena_zatvori"], op: "smena_zatvori" },
];

const ROLES = new Set(["sastojak", "dodatak", "ambalaza", "ambalaza_lokal", "ambalaza_preuzimanje", "ambalaza_dostava"]);
const KINDS = new Set(["sirovina", "pice", "ambalaza", "poluproizvod", "gotov", "higijena", "trosak"]);
const INVOICE_KINDS = new Set(["nabavka", "povracaj", "trosak", "arhiva"]);

export function expandPacket(input: unknown): BotAction[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Telo mora biti objekat sa radnjama.");
  }
  const body = input as Body;
  const parent = str(body, ["kljuc", "ključ", "idempotencyKey"]);
  if (Array.isArray(body.radnje) && (body.op || hasPacket(body))) {
    throw new Error("Pošaljite ili radnje, ili jednu op, ili paket. Ne sve odjednom, da se ništa ne unese dvaput.");
  }
  if (typeof body.op === "string" && body.op.trim() && hasPacket(body)) {
    throw new Error("Pošaljite ili op ili paket (artikli, racuni, rashodi, zatvaranje), ne oba.");
  }
  let actions: BotAction[] = [];
  if (Array.isArray(body.radnje)) {
    actions = body.radnje.map((item, index) => seal(item, parent, index));
  } else if (typeof body.op === "string" && body.op.trim()) {
    actions = [seal(body, parent, 0)];
  } else {
    if (body.katalog === true) actions.push(seal({ op: "katalog" }, parent, 0));
    for (const spec of PACKET) {
      for (const key of spec.keys) {
        if (!(key in body)) continue;
        pushValue(actions, spec.op, body[key], parent);
      }
    }
  }
  if (!actions.length) {
    throw new Error("Nema radnji. Pošaljite op ili paket: artikli, proizvodi, recepture, racuni, rashodi, zatvaranje.");
  }
  if (actions.length > 200) throw new Error("Najviše 200 radnji u jednoj poruci.");
  for (const action of actions) {
    if (NEEDS_KEY.has(action.op) && !str(action.body, ["idempotencyKey"])) {
      throw new Error(`${action.op} traži kljuc (isti pri ponovnom slanju) da se unos ne udvostruči.`);
    }
  }
  return actions;
}

const BUNDLE_KEYS = new Set([
  "artikli",
  "pakovanja",
  "pocetna",
  "pocetno",
  "dobavljaci",
  "proizvodi",
  "recepture",
  "racuni",
  "proizvodnje",
  "prodaje",
  "rashodi",
  "troskovi",
  "kasa",
  "popisi",
  "porudzbine",
  "uplate",
  "otvaranje",
  "zatvaranje",
  "smena_otvori",
  "smena_zatvori",
]);

function hasPacket(body: Body): boolean {
  if (body.katalog === true) return true;
  return Object.keys(body).some((key) => BUNDLE_KEYS.has(key));
}

function pushValue(actions: BotAction[], op: string, value: unknown, parent: string) {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`${op}: stavka mora biti objekat.`);
      }
      actions.push(seal({ ...(item as Body), op }, parent, actions.length));
    }
    return;
  }
  if (value && typeof value === "object") {
    actions.push(seal({ ...(value as Body), op }, parent, actions.length));
  }
}

function seal(item: unknown, parent: string, index: number): BotAction {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Radnja mora biti objekat.");
  const raw = item as Body;
  const name = str(raw, ["op"]).toLowerCase();
  const op = OP_ALIAS[name];
  if (!op) throw new Error(`Nepoznata radnja: ${name || "(prazno)"}.`);
  const own = str(raw, ["idempotencyKey", "kljuc", "ključ"]);
  const key = own || (parent ? `${parent}:${op}:${index}` : "");
  const body: Body = { ...raw, op };
  if (key) body.idempotencyKey = key;
  return { op, body };
}

function str(body: Body, keys: string[], fallback = ""): string {
  for (const key of keys) {
    const value = body[key];
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return fallback;
}

function has(body: Body, keys: string[]): boolean {
  return keys.some((key) => body[key] != null && String(body[key]).trim() !== "");
}

function opt(body: Body, keys: string[]): string | null {
  const value = str(body, keys);
  return value || null;
}

function flag(body: Body, keys: string[], fallback = false): boolean {
  for (const key of keys) {
    if (!(key in body) || body[key] == null || body[key] === "") continue;
    if (body[key] === true || body[key] === "true") return true;
    if (body[key] === false || body[key] === "false") return false;
  }
  return fallback;
}

function rowsOf(body: Body, keys: string[]): Body[] {
  for (const key of keys) {
    if (Array.isArray(body[key])) return (body[key] as unknown[]).map((row) => (row ?? {}) as Body);
  }
  return [];
}

function dateOnly(body: Body, keys: string[]): string | null {
  const value = str(body, keys);
  if (!value) return null;
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`Datum nije u obliku GGGG-MM-DD: ${value}`);
  return day;
}

function whenOf(body: Body): string | null {
  const value = str(body, ["occurredAt", "vreme"]);
  if (value) return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00.000Z` : value;
  const day = str(body, ["datum"]);
  if (!day) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`Datum nije u obliku GGGG-MM-DD: ${day}`);
  return `${day}T12:00:00.000Z`;
}

async function named<T extends { id: string }>(
  sql: Sql,
  text: string,
  params: unknown[],
  label: string,
  name: string,
): Promise<T> {
  const rows = await sql.query<T>(text, params);
  if (rows.length > 1) throw new Error(`${label} „${name}“ postoji više puta. Navedite tačan naziv, nije izabran nasumično.`);
  if (!rows[0]) throw new Error(`${label} „${name}“ nije pronađen. Nije napravljen nagađanjem.`);
  return rows[0];
}

async function findArticle(sql: Sql, orgId: string, name: string) {
  const rows = await sql.query<{
    id: string;
    name: string;
    base_unit: string;
    kind: string;
    min_qty: string;
    code: string | null;
    barcode: string | null;
    tracks_stock: boolean;
  }>(
    `select id, name, base_unit, kind, min_qty::text, code, barcode, tracks_stock from articles
     where org_id=$1 and is_demo=false and lower(btrim(name))=lower(btrim($2))`,
    [orgId, name],
  );
  if (rows.length > 1) throw new Error(`Artikal „${name}“ postoji više puta. Nije izabran nasumično.`);
  return rows[0] ?? null;
}

async function articleByName(sql: Sql, orgId: string, name: string) {
  const row = await findArticle(sql, orgId, name);
  if (!row) throw new Error(`Artikal „${name}“ nije pronađen. Nije napravljen nagađanjem.`);
  return row;
}

async function findProduct(sql: Sql, orgId: string, name: string) {
  const rows = await sql.query<{
    id: string;
    name: string;
    sell_price: string;
    sale_unit: string;
    consume_mode: string;
    output_article_id: string | null;
    code: string | null;
    group_name: string | null;
    size_label: string | null;
    pos_code: string | null;
  }>(
    `select id, name, sell_price::text, sale_unit, consume_mode, output_article_id, code, group_name, size_label, pos_code
     from products where org_id=$1 and is_demo=false and lower(btrim(name))=lower(btrim($2))`,
    [orgId, name],
  );
  if (rows.length > 1) throw new Error(`Proizvod „${name}“ postoji više puta. Nije izabran nasumično.`);
  return rows[0] ?? null;
}

async function productByName(sql: Sql, orgId: string, name: string) {
  const row = await findProduct(sql, orgId, name);
  if (!row) throw new Error(`Proizvod „${name}“ nije pronađen. Prodaja nije knjižena bez veze.`);
  return row;
}

async function supplierByName(sql: Sql, actor: Actor, name: string, pib: string | null): Promise<string> {
  const rows = await sql.query<{ id: string }>(
    `select id from suppliers where org_id=$1 and active=true and lower(btrim(name))=lower(btrim($2))`,
    [actor.orgId, name],
  );
  if (rows.length > 1) throw new Error(`Dobavljač „${name}“ postoji više puta. Nije izabran nasumično.`);
  if (rows[0]) return rows[0].id;
  return saveSupplier(sql, actor, { name, pib, note: null });
}

async function claim(sql: Sql, orgId: string, key: string, kind: string): Promise<string | null> {
  const inserted = await sql.query(
    `insert into idempotency (org_id, key, kind) values ($1,$2,$3) on conflict do nothing returning key`,
    [orgId, key, kind],
  );
  if (inserted.length) return null;
  const prev = await sql.query<{ ref_id: string | null }>(
    `select ref_id from idempotency where org_id=$1 and key=$2`,
    [orgId, key],
  );
  return prev[0]?.ref_id ?? "";
}

async function remember(sql: Sql, orgId: string, key: string, id: string) {
  await sql.query(`update idempotency set ref_id=$1 where org_id=$2 and key=$3`, [id, orgId, key]);
}

function allow(actor: Actor, key: PermKey) {
  assertCan(actor.role, actor.permissions, key, true);
}

async function mark(sql: Sql, actor: Actor, tokenName: string, op: string, id: string | null) {
  await audit(sql, actor.orgId, actor.userId, "grok_upis", op, id, tokenName, null, { op });
}

export async function runBotAction(
  sql: Sql,
  actor: Actor,
  action: BotAction,
  tokenName: string,
): Promise<Record<string, unknown>> {
  switch (action.op) {
    case "katalog":
      return katalog(sql, actor);
    case "artikal":
      return artikal(sql, actor, action.body, tokenName);
    case "pakovanje":
      return pakovanje(sql, actor, action.body, tokenName);
    case "pocetno":
      return pocetno(sql, actor, action.body, tokenName);
    case "dobavljac":
      return dobavljac(sql, actor, action.body, tokenName);
    case "proizvod":
      return proizvod(sql, actor, action.body, tokenName);
    case "receptura":
      return receptura(sql, actor, action.body, tokenName);
    case "racun":
      return racun(sql, actor, action.body, tokenName);
    case "prodaja":
      return prodaja(sql, actor, action.body, tokenName);
    case "rashod":
      return rashod(sql, actor, action.body, tokenName);
    case "proizvodnja":
      return proizvodnja(sql, actor, action.body, tokenName);
    case "popis":
      return popis(sql, actor, action.body, tokenName);
    case "trosak":
      return trosak(sql, actor, action.body, tokenName);
    case "kasa":
      return kasa(sql, actor, action.body, tokenName);
    case "smena_otvori":
      return smenaOtvori(sql, actor, action.body, tokenName);
    case "smena_zatvori":
      return smenaZatvori(sql, actor, action.body, tokenName);
    case "uplata":
      return uplata(sql, actor, action.body, tokenName);
    case "porudzbina":
      return porudzbina(sql, actor, action.body, tokenName);
    case "storno_racun":
      return stornoRacun(sql, actor, action.body, tokenName);
    case "storno_prodaje":
      return stornoProdaje(sql, actor, action.body, tokenName);
    case "povracaj":
      return povracaj(sql, actor, action.body, tokenName);
    default:
      throw new Error("Nepoznata radnja");
  }
}

export { loadActor } from "./engine.ts";

async function katalog(sql: Sql, actor: Actor): Promise<Record<string, unknown>> {
  const shift = await openShiftRow(sql, actor.orgId);
  const when = await stamp(sql, actor.orgId, null);
  return {
    datum: when.day,
    smena: shift ? "otvorena" : "nema",
    artikli: await sql.query(
      `select name, base_unit, kind, on_hand::text, avg_cost::text from articles
       where org_id=$1 and is_demo=false and active=true order by name`,
      [actor.orgId],
    ),
    pakovanja: await sql.query(
      `select a.name as artikal, p.name as pakovanje, p.qty_in_base::text as u_osnovnoj
       from article_packs p join articles a on a.id=p.article_id
       where a.org_id=$1 and a.is_demo=false order by a.name, p.name`,
      [actor.orgId],
    ),
    proizvodi: await sql.query(
      `select name, sell_price::text as cena, sale_unit, consume_mode from products
       where org_id=$1 and is_demo=false and active=true order by name`,
      [actor.orgId],
    ),
    dobavljaci: await sql.query(
      `select name, pib from suppliers where org_id=$1 and active=true order by name`,
      [actor.orgId],
    ),
    napomena: "Ako nabavna cena ili receptura nedostaju, trošak je nepoznat, nije nula. Nabavka nije promet. Polog nije umanjenje prometa.",
  };
}

async function artikal(sql: Sql, actor: Actor, body: Body, tokenName: string) {
  allow(actor, "artikli");
  const name = str(body, ["name", "naziv"]);
  if (!name) throw new Error("Artikal nema naziv.");
  const existing = await findArticle(sql, actor.orgId, name);
  const unit = str(body, ["baseUnit", "jedinica", "osnovna"]);
  if (!existing && !unit) throw new Error(`Artikal „${name}“ nema osnovnu jedinicu (g, ml ili kom). Nije pretpostavljena.`);
  if (unit && !["g", "ml", "kom"].includes(unit)) {
    throw new Error("Osnovna jedinica je g, ml ili kom. Kilogram i litar idu kao pakovanje, ne kao osnovna jedinica.");
  }
  if (existing && unit && unit !== existing.base_unit) {
    throw new Error(`„${existing.name}“ je već u ${existing.base_unit}. Jedinica se ne menja, jer bi zaliha bila pogrešno pretvorena.`);
  }
  const touches = ["kind", "vrsta", "code", "sifra", "minQty", "minimum", "barcode", "tracksStock", "pratiZalihu"].some((key) => has(body, [key]));
  if (existing && !touches) {
    return { id: existing.id, naziv: existing.name, poruka: "Artikal već postoji. Ništa nije prepisano." };
  }
  const kind = has(body, ["kind", "vrsta"]) ? str(body, ["kind", "vrsta"]) : existing?.kind ?? "sirovina";
  if (!KINDS.has(kind)) throw new Error(`Vrsta artikla nije poznata: ${kind}.`);
  const id = await saveArticle(sql, actor, {
    id: existing?.id ?? null,
    name,
    code: has(body, ["code", "sifra"]) ? opt(body, ["code", "sifra"]) : existing?.code ?? null,
    kind,
    tracksStock: has(body, ["tracksStock", "pratiZalihu"]) ? flag(body, ["tracksStock", "pratiZalihu"], true) : existing?.tracks_stock ?? kind !== "trosak",
    baseUnit: existing?.base_unit ?? unit,
    minQty: has(body, ["minQty", "minimum"]) ? str(body, ["minQty", "minimum"]) : existing?.min_qty ?? "0",
    barcode: has(body, ["barcode"]) ? opt(body, ["barcode"]) : existing?.barcode ?? null,
  });
  await mark(sql, actor, tokenName, "artikal", id);
  return { id, naziv: name, poruka: existing ? "Artikal je ažuriran." : "Artikal je dodat." };
}

async function pakovanje(sql: Sql, actor: Actor, body: Body, tokenName: string) {
  allow(actor, "artikli");
  const articleName = str(body, ["artikal", "article", "nazivArtikla"]);
  const name = str(body, ["pakovanje", "name", "naziv"]);
  const qty = str(body, ["qtyInBase", "uOsnovnoj", "kolicina"]);
  if (!articleName || !name || !qty) throw new Error("Pakovanje traži artikal, naziv pakovanja i količinu u osnovnoj jedinici.");
  const article = await articleByName(sql, actor.orgId, articleName);
  await savePack(sql, actor, { articleId: article.id, name, qtyInBase: qty });
  await mark(sql, actor, tokenName, "pakovanje", article.id);
  return { id: article.id, naziv: `${article.name} / ${name}`, poruka: "Pakovanje je sačuvano. Karton nije komad." };
}

async function pocetno(sql: Sql, actor: Actor, body: Body, tokenName: string) {
  allow(actor, "artikli");
  const article = await articleByName(sql, actor.orgId, str(body, ["artikal", "article", "naziv"]));
  const qty = str(body, ["qty", "kolicina"]);
  const unit = str(body, ["unit", "jedinica"]);
  const unitCost = str(body, ["unitCost", "cena"]);
  const date = dateOnly(body, ["date", "datum"]);
  if (!qty || !unit || !unitCost || !date) {
    throw new Error("Početno stanje traži količinu, jedinicu, cenu i datum. Ništa od toga nije pretpostavljeno.");
  }
  const saved = await postOpening(sql, actor, {
    articleId: article.id,
    qty,
    unit,
    unitCost,
    date,
    note: opt(body, ["note", "napomena"]),
    idempotencyKey: str(body, ["idempotencyKey"]),
  });
  await mark(sql, actor, tokenName, "pocetno", saved.id || article.id);
  return { ...saved, naziv: article.name };
}

async function dobavljac(sql: Sql, actor: Actor, body: Body, tokenName: string) {
  allow(actor, "racuni");
  const name = str(body, ["name", "naziv"]);
  if (!name) throw new Error("Dobavljač nema naziv.");
  const id = await supplierByName(sql, actor, name, opt(body, ["pib"]));
  await mark(sql, actor, tokenName, "dobavljac", id);
  return { id, naziv: name };
}

async function proizvod(sql: Sql, actor: Actor, body: Body, tokenName: string) {
  allow(actor, "recepture");
  const name = str(body, ["name", "naziv"]);
  if (!name) throw new Error("Proizvod nema naziv.");
  const existing = await findProduct(sql, actor.orgId, name);
  const modeRaw = str(body, ["consumeMode", "nacin"]);
  const mode = modeRaw === "zaliha" ? "zaliha" : modeRaw === "recept" || modeRaw === "" ? existing?.consume_mode ?? "recept" : null;
  if (!mode) throw new Error("Način utroška je recept ili zaliha.");
  let outputId = existing?.output_article_id ?? null;
  const outputName = str(body, ["outputArticle", "artikalZalihe"]);
  if (outputName) outputId = (await articleByName(sql, actor.orgId, outputName)).id;
  if (mode === "zaliha" && !outputId) throw new Error("Priprema unapred mora imati artikal zalihe. Nije pretpostavljen.");
  const touches = ["sellPrice", "cena", "code", "sifra", "groupName", "grupa", "sizeLabel", "velicina", "saleUnit", "jedinica", "consumeMode", "nacin", "outputArticle", "artikalZalihe", "posCode", "kasaSifra"].some((key) => has(body, [key]));
  if (existing && !touches) {
    return { id: existing.id, naziv: existing.name, poruka: "Proizvod već postoji. Cena i receptura nisu dirani." };
  }
  if (!existing && !has(body, ["sellPrice", "cena"])) throw new Error(`Proizvod „${name}“ nema prodajnu cenu. Nije upisana nula.`);
  const saleUnit = has(body, ["saleUnit", "jedinica"]) ? str(body, ["saleUnit", "jedinica"]) : existing?.sale_unit ?? "";
  if (!saleUnit) throw new Error(`Proizvod „${name}“ nema jedinicu prodaje. Komad nije pretpostavljen.`);
  const sellPrice = has(body, ["sellPrice", "cena"]) ? str(body, ["sellPrice", "cena"]) : existing?.sell_price ?? "";
  if (!sellPrice) throw new Error(`Proizvod „${name}“ nema prodajnu cenu. Nije upisana nula.`);
  const id = await saveProduct(sql, actor, {
    id: existing?.id ?? null,
    name,
    code: has(body, ["code", "sifra"]) ? opt(body, ["code", "sifra"]) : existing?.code ?? null,
    groupName: has(body, ["groupName", "grupa"]) ? opt(body, ["groupName", "grupa"]) : existing?.group_name ?? null,
    sizeLabel: has(body, ["sizeLabel", "velicina"]) ? opt(body, ["sizeLabel", "velicina"]) : existing?.size_label ?? null,
    sellPrice,
    saleUnit,
    consumeMode: mode as "recept" | "zaliha",
    outputArticleId: outputId,
    posCode: has(body, ["posCode", "kasaSifra"]) ? opt(body, ["posCode", "kasaSifra"]) : existing?.pos_code ?? null,
  });
  await mark(sql, actor, tokenName, "proizvod", id);
  return { id, naziv: name, poruka: existing ? "Proizvod je ažuriran. Receptura nije dirana." : "Proizvod je dodat. Bez recepture utrošak ostaje nepoznat." };
}

async function receptura(sql: Sql, actor: Actor, body: Body, tokenName: string) {
  allow(actor, "recepture");
  const productName = str(body, ["proizvod", "product", "naziv"]);
  if (!productName) throw new Error("Receptura nema proizvod.");
  const product = await productByName(sql, actor.orgId, productName);
  const lines = rowsOf(body, ["lines", "stavke"]);
  if (!lines.length) throw new Error("Receptura nema stavki. Prazna receptura nije sačuvana.");
  const mapped: { articleId: string; qty: string; unit: string; role: string; addonCode: string | null }[] = [];
  for (const line of lines) {
    const articleName = str(line, ["artikal", "article", "naziv"]);
    const qty = str(line, ["qty", "kolicina"]);
    const unit = str(line, ["unit", "jedinica"]);
    if (!articleName || !qty || !unit) throw new Error("Stavka recepture traži artikal, količinu i jedinicu. Nije dopunjena.");
    const role = str(line, ["role", "uloga"], "sastojak");
    if (!ROLES.has(role)) throw new Error(`Uloga „${role}“ nije poznata.`);
    const addonCode = opt(line, ["addonCode", "kod"]);
    if (role === "dodatak" && !addonCode) throw new Error(`Dodatak „${articleName}“ mora imati kod. Nije uključen u svaku prodaju.`);
    mapped.push({ articleId: (await articleByName(sql, actor.orgId, articleName)).id, qty, unit, role, addonCode });
  }
  const current = await sql.query<{ id: string }>(
    `select id from recipe_versions where product_id=$1 order by valid_from desc limit 1`,
    [product.id],
  );
  if (current[0]) {
    const prev = await sql.query<{ article_id: string; qty: string; role: string; addon_code: string | null }>(
      `select article_id, qty::text, role, addon_code from recipe_lines where version_id=$1`,
      [current[0].id],
    );
    const next: string[] = [];
    for (const line of mapped) {
      const base = await qtyBaseOf(sql, line.articleId, line.qty, line.unit);
      next.push(`${line.articleId}|${base.toString()}|${line.role}|${line.addonCode ?? ""}`);
    }
    const before = prev.map((row) => `${row.article_id}|${q(row.qty).toString()}|${row.role}|${row.addon_code ?? ""}`);
    const same = before.length === next.length && before.sort().join(";") === next.sort().join(";");
    if (same) return { id: current[0].id, naziv: product.name, duplicate: true, poruka: "Ista receptura već važi. Nova verzija nije pravljena." };
  }
  const id = await saveRecipe(sql, actor, {
    productId: product.id,
    validFrom: opt(body, ["validFrom", "vaziOd"]),
    note: opt(body, ["note", "napomena"]),
    lines: mapped,
  });
  await mark(sql, actor, tokenName, "receptura", id);
  return { id, naziv: product.name, poruka: "Receptura je sačuvana kao nova verzija. Stare prodaje ostaju na starom normativu." };
}

async function racun(sql: Sql, actor: Actor, body: Body, tokenName: string) {
  allow(actor, "racuni");
  const supplierName = str(body, ["supplier", "dobavljac", "naziv"]);
  if (!supplierName) throw new Error("Račun nabavke nema dobavljača.");
  const supplierId = await supplierByName(sql, actor, supplierName, opt(body, ["pib"]));
  const docNumber = opt(body, ["docNumber", "broj"]);
  const key = str(body, ["idempotencyKey"]);
  let kind = str(body, ["kind", "vrsta"], "nabavka");
  if (kind === "arhiv") kind = "arhiva";
  if (!INVOICE_KINDS.has(kind)) throw new Error(`Vrsta dokumenta nije poznata: ${kind}.`);
  const docDate = dateOnly(body, ["docDate", "datum"]);
  const receivedDate = dateOnly(body, ["receivedDate", "prijem"]);
  const linesIn = rowsOf(body, ["lines", "stavke"]);
  if (!linesIn.length && kind !== "arhiva") throw new Error("Račun nema stavki. Prazan račun nije sačuvan.");
  const warnings: string[] = [];
  const lines: InvoiceLineIn[] = [];
  for (const line of linesIn) {
    const rawName = str(line, ["rawName", "naziv", "artikal"], "");
    const articleName = str(line, ["artikal", "article"]);
    const qty = str(line, ["qty", "kolicina"]);
    const unit = str(line, ["unit", "jedinica", "unitName"]);
    if (!qty) throw new Error(`Stavka „${rawName || articleName || "bez naziva"}“ nema količinu. Nula nije upisana umesto nje.`);
    let articleId: string | null = null;
    let needsReview = flag(line, ["needsReview", "nejasno"]);
    if (articleName) {
      const found = await findArticle(sql, actor.orgId, articleName);
      if (!found) {
        needsReview = true;
        warnings.push(`„${articleName}“ nije u šifarniku. Stavka čeka povezivanje, artikal nije izmišljen.`);
      } else articleId = found.id;
    } else if (supplierId && rawName) {
      const alias = await sql.query<{ article_id: string }>(
        `select article_id from supplier_item_map where org_id=$1 and supplier_id=$2 and supplier_name=lower(btrim($3))`,
        [actor.orgId, supplierId, rawName],
      );
      if (alias.length === 1) articleId = alias[0].article_id;
    }
    if (!articleId && kind !== "arhiva" && kind !== "trosak") needsReview = true;
    if (!unit) {
      needsReview = true;
      warnings.push(`„${rawName || articleName}“ nema jedinicu. Karton nije pretpostavljen kao komad.`);
    }
    const lineTotal = opt(line, ["lineTotal", "iznos"]);
    const unitPrice = opt(line, ["unitPrice", "cena"]);
    if (lineTotal == null && unitPrice == null && kind !== "arhiva") {
      needsReview = true;
      warnings.push(`„${rawName || articleName}“ nema iznos. Cena nije upisana kao nula.`);
    }
    lines.push({
      articleId,
      rawName: rawName || articleName || "Stavka",
      qty,
      unitName: unit || "nepoznato",
      unitPrice,
      discount: str(line, ["discount", "rabat"], "0"),
      lineTotal,
      taxRate: opt(line, ["taxRate", "porez"]),
      needsReview,
      expiry: dateOnly(line, ["expiry", "rok"]),
    });
  }
  if (docNumber) {
    const posted = await sql.query<{ id: string }>(
      `select id from invoices where org_id=$1 and supplier_id=$2 and doc_number=$3 and status='proknjizen'`,
      [actor.orgId, supplierId, docNumber],
    );
    if (posted[0] && !flag(body, ["allowDuplicate", "dozvoliDuplikat"])) {
      return {
        id: posted[0].id,
        status: "vec_proknjizen",
        duplicate: true,
        naziv: docNumber,
        upozorenja: ["Isti dobavljač i broj dokumenta su već proknjiženi. Zaliha nije dirana ponovo."],
      };
    }
  }
  let draftId: string | null = null;
  if (docNumber) {
    const draft = await sql.query<{ id: string }>(
      `select id from invoices where org_id=$1 and supplier_id=$2 and doc_number=$3 and status in ('nacrt','provera') order by created_at desc limit 1`,
      [actor.orgId, supplierId, docNumber],
    );
    draftId = draft[0]?.id ?? null;
  }
  const saved = await upsertInvoice(sql, actor, {
    id: draftId,
    supplierId,
    docNumber,
    docDate,
    receivedDate,
    dueDate: dateOnly(body, ["dueDate", "valuta"]),
    kind,
    total: opt(body, ["total", "ukupno"]),
    note: opt(body, ["note", "napomena"]),
    idempotencyKey: key,
    lines,
  });
  let invoiceId = saved.id;
  if (saved.duplicate && !invoiceId) throw new Error("Isti ključ je već iskorišćen, ali račun nije pronađen. Nije pravljen novi.");
  if (saved.duplicate && invoiceId) {
    const status = await sql.query<{ status: string }>(`select status from invoices where id=$1 and org_id=$2`, [invoiceId, actor.orgId]);
    if (status[0] && status[0].status !== "nacrt" && status[0].status !== "provera") {
      return { id: invoiceId, status: status[0].status, duplicate: true, upozorenja: saved.warnings };
    }
    const again = await upsertInvoice(sql, actor, {
      id: invoiceId,
      supplierId,
      docNumber,
      docDate,
      receivedDate,
      dueDate: dateOnly(body, ["dueDate", "valuta"]),
      kind,
      total: opt(body, ["total", "ukupno"]),
      note: opt(body, ["note", "napomena"]),
      idempotencyKey: key,
      lines,
    });
    warnings.push(...again.warnings);
  } else {
    warnings.push(...saved.warnings);
    invoiceId = saved.id;
  }
  const unclear = lines.some((line) => line.needsReview || !line.articleId);
  const knjizi = flag(body, ["knjizi", "post"], true);
  if (!knjizi) {
    await mark(sql, actor, tokenName, "racun", invoiceId);
    return { id: invoiceId, status: "nacrt", naziv: docNumber, upozorenja: warnings.concat("Sačuvano, nije knjiženo jer knjiženje nije traženo.") };
  }
  if (!docDate && !receivedDate && kind !== "arhiva") {
    await sql.query(`update invoices set status='provera', unclear=true where id=$1`, [invoiceId]);
    await mark(sql, actor, tokenName, "racun", invoiceId);
    return { id: invoiceId, status: "provera", naziv: docNumber, upozorenja: warnings.concat("Nema datuma. Zaliha nije dirana.") };
  }
  if (unclear && kind !== "arhiva") {
    await sql.query(`update invoices set status='provera', unclear=true where id=$1`, [invoiceId]);
    await mark(sql, actor, tokenName, "racun", invoiceId);
    return { id: invoiceId, status: "provera", naziv: docNumber, upozorenja: warnings.concat("Ima nejasnih stavki. Zaliha nije dirana.") };
  }
  if (!has(body, ["total", "ukupno"]) && kind !== "arhiva") {
    warnings.push("Ukupan iznos računa nije naveden. Knjiži se po stavkama, zbir nije izmišljen.");
  }
  const posted = await postInvoice(sql, actor, {
    invoiceId,
    acceptMismatch: flag(body, ["acceptMismatch", "prihvatiRazliku"]),
    allowDuplicate: flag(body, ["allowDuplicate", "dozvoliDuplikat"]),
  });
  await mark(sql, actor, tokenName, "racun", invoiceId);
  return { id: invoiceId, status: posted.status, naziv: docNumber, upozorenja: warnings.concat(posted.warnings) };
}

async function prodaja(sql: Sql, actor: Actor, body: Body, tokenName: string) {
  allow(actor, "prodaja");
  const summary = flag(body, ["isSummary", "zbir"]);
  const linesIn = rowsOf(body, ["lines", "stavke"]);
  if (!summary && !linesIn.length) throw new Error("Prodaja nema stavki. Promet nije upisan kao nula.");
  const tenders = tenderOf(body);
  const lines = [];
  let lineSum = 0n;
  for (const line of linesIn) {
    const name = str(line, ["proizvod", "product", "name", "naziv"]);
    if (!name) throw new Error("Stavka prodaje nema proizvod.");
    const product = await productByName(sql, actor.orgId, name);
    const qty = str(line, ["qty", "kolicina"]);
    if (!qty) throw new Error(`„${name}“ nema količinu.`);
    const lineNet = lineMoney(line, name);
    lineSum += m(lineNet);
    lines.push({
      productId: product.id,
      name: product.name,
      qty,
      unitPrice: opt(line, ["unitPrice", "cena"]),
      lineNet,
      addons: Array.isArray(line.dodaci) ? line.dodaci.map(String) : Array.isArray(line.addons) ? line.addons.map(String) : [],
      omitted: Array.isArray(line.bez) ? line.bez.map(String) : Array.isArray(line.omitted) ? line.omitted.map(String) : [],
    });
  }
  const target = summary ? m(str(body, ["summaryNet", "promet", "ukupno"])) : lineSum;
  if (summary && !has(body, ["summaryNet", "promet", "ukupno"])) throw new Error("Zbirni promet nema iznos.");
  const paid = tenders.sum;
  const diff = paid > target ? paid - target : target - paid;
  const warnings: string[] = [];
  if (diff > m("1") && !flag(body, ["prihvatiRazliku", "acceptMismatch"])) {
    throw new Error("Zbir naplate se ne slaže sa stavkama. Nije knjiženo. Pošaljite keš, karticu i neplaćeno posebno, ili prihvatiRazliku.");
  }
  if (diff > m("1")) warnings.push("Naplata i stavke se razlikuju. Knjiženo je jer je razlika izričito prihvaćena.");
  if (!summary && lines.every((line) => !line.addons.length && !line.omitted.length)) {
    warnings.push("Dodaci i izmene nisu navedeni. Utrošak je po osnovnom normativu.");
  }
  const saved = await postSale(sql, actor, {
    externalKey: str(body, ["idempotencyKey"]),
    channel: str(body, ["channel", "kanal"]),
    tenderCash: tenders.kes,
    tenderCard: tenders.kartica,
    tenderOther: tenders.ostalo,
    tenderUnpaid: tenders.neplaceno,
    prepaid: tenders.avans,
    discount: str(body, ["discount", "rabat"], "0"),
    occurredAt: whenOf(body),
    source: str(body, ["source", "izvor"], "grok"),
    isSummary: summary,
    summaryNet: summary ? str(body, ["summaryNet", "promet", "ukupno"]) : null,
    note: opt(body, ["note", "napomena"]),
    lines,
  });
  await mark(sql, actor, tokenName, "prodaja", saved.id);
  return { ...saved, upozorenja: warnings.concat(saved.warnings), napomena: "Kartica nije keš. Ako receptura ili cena nedostaju, trošak je nepoznat, nije nula." };
}

function tenderOf(body: Body) {
  const kes = moneyField(body, ["tenderCash", "kes", "gotovina"]);
  const kartica = moneyField(body, ["tenderCard", "kartica"]);
  const ostalo = moneyField(body, ["tenderOther", "ostalo"]);
  const neplaceno = moneyField(body, ["tenderUnpaid", "neplaceno"]);
  const avans = moneyField(body, ["prepaid", "avans"]);
  if (!kes.on && !kartica.on && !ostalo.on && !neplaceno.on && !avans.on) {
    throw new Error("Nema načina naplate (keš, kartica, ostalo, neplaćeno ili avans). Keš nije pretpostavljen.");
  }
  const sum = m(kes.value) + m(kartica.value) + m(ostalo.value) + m(neplaceno.value) + m(avans.value);
  return { kes: kes.value, kartica: kartica.value, ostalo: ostalo.value, neplaceno: neplaceno.value, avans: avans.value, sum };
}

function moneyField(body: Body, keys: string[]): { on: boolean; value: string } {
  if (!has(body, keys)) return { on: false, value: "0" };
  return { on: true, value: str(body, keys) };
}

function lineMoney(line: Body, name: string): string {
  if (has(line, ["lineNet", "iznos", "ukupno"])) return str(line, ["lineNet", "iznos", "ukupno"]);
  if (has(line, ["unitPrice", "cena"]) && has(line, ["qty", "kolicina"])) {
    return mStr(valuePara(q(str(line, ["qty", "kolicina"])), c(str(line, ["unitPrice", "cena"]))));
  }
  throw new Error(`„${name}“ nema iznos ni cenu. Nula nije upisana.`);
}

async function rashod(sql: Sql, actor: Actor, body: Body, tokenName: string) {
  allow(actor, "rashod");
  const qty = str(body, ["qty", "kolicina"]);
  const unit = str(body, ["unit", "jedinica"]);
  const reason = str(body, ["reason", "razlog"]);
  if (!qty || !unit || !reason) throw new Error("Rashod traži količinu, jedinicu i razlog. Nije knjižen.");
  const productName = str(body, ["proizvod", "product"]);
  const articleName = str(body, ["artikal", "article"]);
  let articleId: string | null = null;
  let productId: string | null = null;
  if (productName) {
    const product = await productByName(sql, actor.orgId, productName);
    if (unit !== product.sale_unit) {
      throw new Error(`Rashod „${product.name}“ je u jedinici prodaje (${product.sale_unit}), ne u ${unit}. Nije pretvoren.`);
    }
    productId = product.id;
  } else if (articleName) {
    articleId = (await articleByName(sql, actor.orgId, articleName)).id;
  } else throw new Error("Rashod traži artikal ili proizvod.");
  const saved = await postWaste(sql, actor, {
    articleId,
    productId,
    qty,
    unit,
    reason,
    note: opt(body, ["note", "napomena"]),
    allowOver: flag(body, ["allowOver", "prekoZalihe"]),
    occurredAt: whenOf(body),
    idempotencyKey: str(body, ["idempotencyKey"]),
  });
  await mark(sql, actor, tokenName, "rashod", saved.id);
  const upozorenja = [...saved.warnings];
  if (saved.value == null) upozorenja.push("Vrednost rashoda je nepoznata, nije nula.");
  return { ...saved, upozorenja, napomena: "Rashod nije utrošak recepture i nije popisna razlika." };
}

async function proizvodnja(sql: Sql, actor: Actor, body: Body, tokenName: string) {
  allow(actor, "proizvodnja");
  const output = await articleByName(sql, actor.orgId, str(body, ["artikal", "output", "naziv"]));
  const planned = str(body, ["plannedQty", "plan"]);
  const actual = str(body, ["actualQty", "dobijeno"]);
  if (!planned || !actual) throw new Error("Proizvodnja traži plan i stvarno dobijenu količinu.");
  const lines = [];
  for (const line of rowsOf(body, ["lines", "stavke"])) {
    const name = str(line, ["artikal", "naziv"]);
    const qty = str(line, ["qty", "kolicina"]);
    const unit = str(line, ["unit", "jedinica"]);
    if (!name || !qty || !unit) throw new Error("Sastojak proizvodnje traži artikal, količinu i jedinicu.");
    lines.push({ articleId: (await articleByName(sql, actor.orgId, name)).id, qty, unit });
  }
  if (!lines.length) throw new Error("Proizvodnja nema utrošenih sastojaka. Nisu uzeti iz recepture nagađanjem.");
  const saved = await postProduction(sql, actor, {
    outputArticleId: output.id,
    plannedQty: planned,
    actualQty: actual,
    lines,
    occurredAt: whenOf(body),
    note: opt(body, ["note", "napomena"]),
    idempotencyKey: str(body, ["idempotencyKey"]),
  });
  await mark(sql, actor, tokenName, "proizvodnja", saved.id);
  return { ...saved, naziv: output.name, napomena: "Prodaja ovog artikla troši gotovu zalihu, ne sirovine ponovo." };
}

async function popis(sql: Sql, actor: Actor, body: Body, tokenName: string) {
  allow(actor, "popis");
  const key = str(body, ["idempotencyKey"]);
  const prior = await claim(sql, actor.orgId, key, "popis");
  if (prior != null) return { id: prior, duplicate: true, poruka: "Isti popis je već primljen." };
  const items = rowsOf(body, ["stavke", "lines"]);
  if (!items.length) throw new Error("Popis nema izbrojanih stavki. Očekivano stanje nije upisano kao izbrojano.");
  const ids: string[] = [];
  const counts: { id: string; base: bigint }[] = [];
  for (const line of items) {
    const name = str(line, ["artikal", "naziv"]);
    const counted = str(line, ["counted", "izbrojano", "kolicina"]);
    const unit = str(line, ["unit", "jedinica"]);
    if (!name || !counted || !unit) throw new Error("Stavka popisa traži artikal, izbrojanu količinu i jedinicu.");
    const article = await articleByName(sql, actor.orgId, name);
    ids.push(article.id);
    counts.push({ id: article.id, base: await qtyBaseOf(sql, article.id, counted, unit) });
  }
  const countId = await startCount(sql, actor, { scope: "deo", articleIds: ids, note: opt(body, ["note", "napomena"]) });
  for (const line of counts) {
    await setCountQty(sql, actor, countId, line.id, qStr(line.base));
  }
  const posted = await postCount(sql, actor, countId);
  await remember(sql, actor.orgId, key, countId);
  await mark(sql, actor, tokenName, "popis", countId);
  return { id: countId, ...posted, napomena: "Popisna razlika nije rashod i ne ponavlja utrošak recepture." };
}

async function trosak(sql: Sql, actor: Actor, body: Body, tokenName: string) {
  allow(actor, "troskovi");
  const title = str(body, ["title", "naziv"]);
  const amount = str(body, ["amount", "iznos"]);
  if (!title || !amount) throw new Error("Trošak traži naziv i iznos.");
  const id = await saveExpense(sql, actor, {
    title,
    amount,
    category: opt(body, ["category", "vrsta"]),
    fromCash: flag(body, ["fromCash", "izKase"]),
    note: opt(body, ["note", "napomena"]),
    occurredAt: whenOf(body),
    idempotencyKey: str(body, ["idempotencyKey"]),
  });
  await mark(sql, actor, tokenName, "trosak", id);
  return {
    id,
    naziv: title,
    napomena: flag(body, ["fromCash", "izKase"])
      ? "Iznos je skinut iz kase. Promet nije umanjen."
      : "Trošak nije skinut iz kase jer izKase nije traženo. Nije dobit.",
  };
}

async function kasa(sql: Sql, actor: Actor, body: Body, tokenName: string) {
  allow(actor, "smene");
  const kind = str(body, ["kind", "vrsta"]);
  if (kind !== "ulaz" && kind !== "isplata" && kind !== "polog") {
    throw new Error("Kasa traži vrstu: ulaz, isplata ili polog.");
  }
  const amount = str(body, ["amount", "iznos"]);
  if (!amount) throw new Error("Kasa nema iznos.");
  await addCashMove(sql, actor, {
    kind,
    amount,
    note: opt(body, ["note", "napomena"]),
    idempotencyKey: str(body, ["idempotencyKey"]),
  });
  await mark(sql, actor, tokenName, "kasa", null);
  return {
    ok: true,
    vrsta: kind,
    napomena: kind === "polog" ? "Polog skida keš iz kase. Ne smanjuje promet." : "Kartica nije keš.",
  };
}

async function smenaOtvori(sql: Sql, actor: Actor, body: Body, tokenName: string) {
  allow(actor, "smene");
  if (!has(body, ["openingCash", "pocetniNovac", "kes"])) {
    throw new Error("Otvaranje smene traži početni novac. Nula nije pretpostavljena. Ako je fioka prazna, pošaljite 0.");
  }
  const open = await openShiftRow(sql, actor.orgId);
  if (open) return { id: open.id, status: "vec_otvorena", poruka: "Smena je već otvorena. Nova nije pravljena." };
  const id = await openShift(sql, actor, { openingCash: str(body, ["openingCash", "pocetniNovac", "kes"]), occurredAt: whenOf(body) });
  await mark(sql, actor, tokenName, "smena_otvori", id);
  return { id, status: "otvorena" };
}

async function smenaZatvori(sql: Sql, actor: Actor, body: Body, tokenName: string) {
  allow(actor, "smene");
  if (!has(body, ["counted", "izbrojano"])) {
    throw new Error("Zatvaranje traži izbrojan novac u kasi. Nije pretpostavljen i dan nije zatvoren.");
  }
  const closed = await closeShift(sql, actor, { counted: str(body, ["counted", "izbrojano"]), note: opt(body, ["note", "napomena"]) });
  const when = await stamp(sql, actor.orgId, null);
  const day = await snapshot(sql, actor.orgId, when.day, when.day, false);
  await mark(sql, actor, tokenName, "smena_zatvori", null);
  return {
    ...closed,
    datum: when.day,
    promet: day.revenue,
    trosakSastojaka: day.costKnown,
    nepotpunTrosak: day.incomplete,
    rashod: day.waste,
    nabavka: day.purchases,
    troskovi: day.expenses,
    kartica: day.card,
    kesProdaja: day.cashSales,
    polog: day.drops,
    napomena:
      "Razlika kase nije promet i nije dobit. Trošak sastojaka nije čista zarada: plate, kirija, energija, amortizacija i porez nisu u tome osim ako su uneti kao trošak. Ako prodaja nije uneta, nula prometa znači da nema knjiženja, ne da je dan proveren. Nabavka nije promet. Polog ne smanjuje promet. Dan nije zaključan za naknadnu ispravku.",
  };
}

async function uplata(sql: Sql, actor: Actor, body: Body, tokenName: string) {
  allow(actor, "racuni");
  const amount = str(body, ["amount", "iznos"]);
  if (!amount) throw new Error("Uplata nema iznos.");
  const invoiceId = await invoiceIdOf(sql, actor, body);
  const method = str(body, ["method", "nacin"], "prenos");
  const saved = await payInvoice(sql, actor, {
    invoiceId,
    amount,
    method,
    fromCash: flag(body, ["fromCash", "izKase"]),
    paidAt: whenOf(body),
    note: opt(body, ["note", "napomena"]),
    idempotencyKey: str(body, ["idempotencyKey"]),
  });
  await mark(sql, actor, tokenName, "uplata", invoiceId);
  return { ...saved, id: invoiceId, napomena: "Uplata dobavljaču nije nabavka i nije umanjenje prometa." };
}

async function invoiceIdOf(sql: Sql, actor: Actor, body: Body): Promise<string> {
  const id = str(body, ["invoiceId", "id"]);
  if (id) return id;
  const supplierName = str(body, ["dobavljac", "supplier"]);
  const docNumber = str(body, ["broj", "docNumber"]);
  if (!supplierName || !docNumber) throw new Error("Treba id računa ili dobavljač i broj dokumenta.");
  const supplierId = await named<{ id: string }>(
    sql,
    `select id from suppliers where org_id=$1 and active and lower(btrim(name))=lower(btrim($2))`,
    [actor.orgId, supplierName],
    "Dobavljač",
    supplierName,
  );
  const rows = await sql.query<{ id: string }>(
    `select id from invoices where org_id=$1 and supplier_id=$2 and doc_number=$3 and status in ('proknjizen','provera') order by created_at desc`,
    [actor.orgId, supplierId.id, docNumber],
  );
  if (rows.length !== 1) throw new Error(`Račun ${docNumber} nije jedinstven ili nije spreman za uplatu.`);
  return rows[0].id;
}

async function porudzbina(sql: Sql, actor: Actor, body: Body, tokenName: string) {
  allow(actor, "porudzbine");
  const key = str(body, ["idempotencyKey"]);
  const prior = await claim(sql, actor.orgId, key, "porudzbina");
  if (prior != null) return { id: prior, duplicate: true, poruka: "Ista porudžbina je već primljena." };
  const customer = str(body, ["customerName", "kupac", "naziv"]);
  if (!customer) throw new Error("Porudžbina nema kupca.");
  const lines = [];
  let total = 0n;
  for (const line of rowsOf(body, ["lines", "stavke"])) {
    const name = str(line, ["proizvod", "naziv"]);
    const qty = str(line, ["qty", "kolicina"]);
    if (!name || !qty) throw new Error("Stavka porudžbine traži proizvod i količinu.");
    const product = await productByName(sql, actor.orgId, name);
    const price = has(line, ["unitPrice", "cena"])
      ? str(line, ["unitPrice", "cena"])
      : m(product.sell_price) > 0n
        ? product.sell_price
        : "";
    if (!price) throw new Error(`„${name}“ nema cenu. Nula nije upisana.`);
    const net = valuePara(q(qty), c(price));
    total += net;
    lines.push({ productId: product.id, name: product.name, qty, unitPrice: price });
  }
  if (!lines.length) throw new Error("Porudžbina nema stavki.");
  const id = await saveOrder(sql, actor, {
    customerName: customer,
    company: opt(body, ["company", "firma"]),
    phone: opt(body, ["phone", "telefon"]),
    dueAt: opt(body, ["dueAt", "rok"]),
    place: opt(body, ["place", "mesto"]),
    note: opt(body, ["note", "napomena"]),
    lines,
  });
  const advance = str(body, ["avans"]);
  if (has(body, ["avans"])) {
    await takeAdvance(sql, actor, { orderId: id, amount: advance, idempotencyKey: `${key}:avans` });
  }
  let sale: { saleId: string; duplicate: boolean; warnings: string[] } | null = null;
  if (flag(body, ["realizuj"])) {
    const pay: Body = { ...body };
    delete pay.avans;
    delete pay.prepaid;
    const advancePaid = m(has(body, ["avans"]) ? advance : "0");
    const hasPay = ["tenderCash", "kes", "gotovina", "tenderCard", "kartica", "tenderOther", "ostalo", "tenderUnpaid", "neplaceno"].some((key) => has(pay, [key]));
    if (!hasPay && advancePaid === 0n) {
      throw new Error("Realizacija traži keš, karticu, ostalo ili neplaćeno. Avans se ne pretvara sam u naplatu.");
    }
    const rest = hasPay ? tenderOf(pay) : { kes: "0", kartica: "0", ostalo: "0", neplaceno: "0", avans: "0", sum: 0n };
    const covered = rest.sum + advancePaid;
    const diff = covered > total ? covered - total : total - covered;
    if (diff > m("1") && !flag(body, ["prihvatiRazliku"])) {
      throw new Error("Naplata porudžbine se ne slaže sa stavkama. Avans ide posebno, ne i u keš.");
    }
    sale = await realizeOrder(sql, actor, {
      orderId: id,
      tenderCash: rest.kes,
      tenderCard: rest.kartica,
      tenderOther: rest.ostalo,
      tenderUnpaid: rest.neplaceno,
    });
  }
  await remember(sql, actor.orgId, key, id);
  await mark(sql, actor, tokenName, "porudzbina", id);
  return {
    id,
    naziv: customer,
    prodaja: sale?.saleId ?? null,
    upozorenja: sale?.warnings ?? [],
    napomena: "Avans nije promet dok porudžbina nije realizovana. Nije uračunat dvaput.",
  };
}

async function stornoRacun(sql: Sql, actor: Actor, body: Body, tokenName: string) {
  allow(actor, "racuni");
  const reason = str(body, ["reason", "razlog"]);
  if (!reason) throw new Error("Storno traži razlog. Dokument nije diran.");
  const invoiceId = await invoiceIdOf(sql, actor, body);
  const prior = await claim(sql, actor.orgId, str(body, ["idempotencyKey"]), "storno_racun");
  if (prior != null) return { id: invoiceId, duplicate: true };
  await voidInvoice(sql, actor, invoiceId, reason);
  await remember(sql, actor.orgId, str(body, ["idempotencyKey"]), invoiceId);
  await mark(sql, actor, tokenName, "storno_racun", invoiceId);
  return { id: invoiceId, status: "storno", napomena: "Zaliha je vraćena stornom. Dokument nije obrisan." };
}

async function stornoProdaje(sql: Sql, actor: Actor, body: Body, tokenName: string) {
  allow(actor, "prodaja");
  const reason = str(body, ["reason", "razlog"]);
  const saleId = str(body, ["saleId", "id"]);
  if (!reason || !saleId) throw new Error("Storno prodaje traži id i razlog.");
  const prior = await claim(sql, actor.orgId, str(body, ["idempotencyKey"]), "storno_prodaje");
  if (prior != null) return { id: saleId, duplicate: true };
  await voidSale(sql, actor, saleId, reason);
  await remember(sql, actor.orgId, str(body, ["idempotencyKey"]), saleId);
  await mark(sql, actor, tokenName, "storno_prodaje", saleId);
  return { id: saleId, status: "storno" };
}

async function povracaj(sql: Sql, actor: Actor, body: Body, tokenName: string) {
  allow(actor, "prodaja");
  const saleId = str(body, ["saleId", "id"]);
  const amount = str(body, ["amount", "iznos"]);
  const reason = str(body, ["reason", "razlog"]);
  if (!saleId || !amount || !reason) throw new Error("Povraćaj traži prodaju, iznos i razlog.");
  const method = str(body, ["method", "nacin"], "");
  if (method !== "kes" && method !== "kartica" && method !== "prenos") {
    throw new Error("Način povraćaja je kes, kartica ili prenos. Nije pretpostavljen.");
  }
  const saved = await postRefund(sql, actor, {
    saleId,
    amount,
    method,
    restoresStock: flag(body, ["restoresStock", "vratiZalihu"]),
    reason,
    idempotencyKey: str(body, ["idempotencyKey"]),
    occurredAt: whenOf(body),
  });
  await mark(sql, actor, tokenName, "povracaj", saved.id);
  return {
    ...saved,
    napomena: flag(body, ["restoresStock", "vratiZalihu"])
      ? "Novac je vraćen i zaliha je vraćena jer je to izričito traženo."
      : "Novac je vraćen. Zaliha nije vraćena jer vratiZalihu nije traženo.",
  };
}
