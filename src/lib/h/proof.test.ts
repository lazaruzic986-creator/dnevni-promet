import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { businessDate } from "./day.ts";
import { mStr, q, valuePara } from "./money.ts";
import { runProof } from "./proof.ts";

test("zaokruživanje i poslovni dan", () => {
  const qty = q("1500");
  const cost = q("0"); // placeholder to keep import used if tree changes
  void cost;
  assert.equal(mStr(valuePara(q("1000"), 800_000n)), "800.00");
  assert.equal(businessDate(new Date("2026-04-01T22:30:00.000Z"), 4, "Europe/Belgrade"), "2026-04-01");
  assert.equal(businessDate(new Date("2026-04-02T03:00:00.000Z"), 4, "Europe/Belgrade"), "2026-04-02");
  assert.equal(businessDate(new Date("2026-01-14T23:30:00.000Z"), 4, "Europe/Belgrade"), "2026-01-14");
  void qty;
});

test("glavni obračun ugostitelja", async () => {
  const pg = new PGlite();
  await pg.exec(readFileSync(new URL("../../../migrations/0002_hospitality.sql", import.meta.url), "utf8"));
  await pg.exec(readFileSync(new URL("../../../migrations/0003_count_timing.sql", import.meta.url), "utf8"));
  const sql = {
    query: async <T>(text: string, params: unknown[] = []) => {
      const result = await pg.query<T>(text, params);
      return result.rows;
    },
  };
  const checks = await runProof(sql);
  const report = checks.map((c) => `${c.ok ? "OK" : "FAIL"} ${c.name} — ${c.detail}`).join("\n");
  const failed = checks.filter((c) => !c.ok);
  assert.equal(failed.length, 0, report);
  await pg.close();
});
