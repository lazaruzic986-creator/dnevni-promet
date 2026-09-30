import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { setupOrg, saveArticle, postOpening, type Actor } from "./engine.ts";
import { defaultPerms } from "./perms.ts";
import { startCount, setCountQty, postWaste, postCount, stockRow } from "./engine-ops.ts";

test("popis čuva fizičko stanje u trenutku brojanja i prenosi kasniji rashod", async () => {
  const pg = new PGlite();
  await pg.exec(readFileSync(new URL("../../../migrations/0002_hospitality.sql", import.meta.url), "utf8"));
  await pg.exec(readFileSync(new URL("../../../migrations/0003_count_timing.sql", import.meta.url), "utf8"));
  const sql = {
    query: async <T>(text: string, params: unknown[] = []) => {
      const result = await pg.query<T>(text, params);
      return result.rows;
    },
  };
  const userId = "count-timing-user";
  const setup = await setupOrg(sql, { userId, email: "count@example.test", name: "Popis" }, {
    name: "Test popis",
    endHour: 4,
    initialCash: "0",
    openingDate: "2026-09-30",
    force: true,
  });
  const actor: Actor = {
    userId,
    memberId: setup.memberId,
    role: "super_admin",
    permissions: defaultPerms("super_admin"),
    orgId: setup.orgId,
  };
  const articleId = await saveArticle(sql, actor, {
    name: "Mleko",
    kind: "sirovina",
    tracksStock: true,
    baseUnit: "ml",
    minQty: "0",
  });
  await postOpening(sql, actor, {
    articleId,
    qty: "1000",
    unit: "ml",
    unitCost: "0.10",
    date: "2026-09-30",
    idempotencyKey: "milk-open",
  });
  const countId = await startCount(sql, actor, { scope: "sve" });
  await setCountQty(sql, actor, countId, articleId, "900");
  await postWaste(sql, actor, {
    articleId,
    qty: "100",
    unit: "ml",
    reason: "prosuto posle brojanja",
    allowOver: false,
    idempotencyKey: "milk-waste-after-count",
  });
  await postCount(sql, actor, countId);
  const state = await stockRow(sql, articleId);
  const line = await sql.query<{ diff_qty: string }>(
    "select diff_qty::text from count_lines where count_id=$1 and article_id=$2",
    [countId, articleId],
  );
  assert.equal(line[0]?.diff_qty, "0.0000");
  assert.equal(state.onHand, "800.0000");
  await pg.close();
});
