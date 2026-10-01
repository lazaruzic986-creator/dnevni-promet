import assert from "node:assert/strict";
import test from "node:test";
import { csvSaleIdempotencyKey, detectCsvDelimiter, fingerprintCsv, parseSalesCsv } from "./sales-csv.ts";

test("CSV parser handles semicolon separators and quoted comma decimals", () => {
  const rows = parseSalesCsv('datum;vreme;sifra;naziv;kolicina;iznos;placanje\n2026-09-30;12:00;A1;"Burger, veliki";2;"1.200,00";kartica');
  assert.equal(detectCsvDelimiter("datum;vreme,iznos\n"), ";");
  assert.deepEqual(rows[1], ["2026-09-30", "12:00", "A1", "Burger, veliki", "2", "1.200,00", "kartica"]);
});

test("CSV parser handles commas inside quoted names and escaped quotes", () => {
  const rows = parseSalesCsv('date,time,code,name,qty,amount,payment\n2026-09-30,12:00,A1,"Burger; ""XXL""",1,500,cash');
  assert.deepEqual(rows[1], ["2026-09-30", "12:00", "A1", 'Burger; "XXL"', "1", "500", "cash"]);
});

test("CSV import keys distinguish identical rows and remain stable on re-import", async () => {
  const content = "head\nA1;Burger;1;500\nA1;Burger;1;500";
  const fingerprint = await fingerprintCsv(content);
  assert.equal(fingerprint.length, 64);
  assert.equal(await fingerprintCsv(content), fingerprint);
  assert.notEqual(csvSaleIdempotencyKey(fingerprint, 2), csvSaleIdempotencyKey(fingerprint, 3));
  assert.equal(csvSaleIdempotencyKey(fingerprint, 2), csvSaleIdempotencyKey(fingerprint, 2));
});

test("CSV parser refuses a quote that was never closed", () => {
  assert.throws(() => parseSalesCsv('head;name\nrow;"unfinished'), /nezatvoren navodnik/);
});
