import assert from "node:assert/strict";
import test from "node:test";
import { postCount, saveProduct, saveRecipe } from "./engine-ops.ts";
import type { Actor, Sql } from "./engine.ts";
import { defaultPerms } from "./perms.ts";

const actor: Actor = {
  userId: "user-1",
  memberId: "member-1",
  orgId: "org-1",
  role: "admin",
  permissions: defaultPerms("admin"),
};

function sqlMock(
  respond: (text: string, params?: unknown[]) => unknown[],
  calls: string[] = [],
): Sql {
  return {
    async query<T>(text: string, params?: unknown[]) {
      calls.push(text);
      return respond(text, params) as T[];
    },
  };
}

test("postCount refuses to post while any counted item is missing", async () => {
  const calls: string[] = [];
  const sql = sqlMock((text) => {
    if (text.includes("from counts where id=$1")) {
      return [{ status: "nacrt", business_date: "2026-09-30" }];
    }
    if (text.includes("from orgs where id = $1")) {
      return [{
        id: actor.orgId,
        timezone: "Europe/Belgrade",
        business_day_end_hour: 4,
        locked_through: null,
        name: "Test lokal",
      }];
    }
    if (text.includes("from count_lines where count_id=$1")) {
      return [
        { article_id: "article-1", expected_qty: "5", counted_qty: "5" },
        { article_id: "article-2", expected_qty: "2", counted_qty: null },
      ];
    }
    return [];
  }, calls);

  await assert.rejects(
    postCount(sql, actor, "count-1"),
    /Popis nije potpun.*1 preostalih stavki/,
  );
  assert.equal(calls.some((text) => text.includes("insert into stock_moves")), false);
  assert.equal(calls.some((text) => text.includes("update counts set status='proknjizen'")), false);
});

test("saveProduct rejects an output article owned by another organization", async () => {
  const calls: string[] = [];
  const sql = sqlMock(() => [], calls);

  await assert.rejects(
    saveProduct(sql, actor, {
      name: "Poluproizvod",
      sellPrice: "100",
      saleUnit: "porcija",
      consumeMode: "zaliha",
      outputArticleId: "foreign-article",
    }),
    /Artikal izlaza ne postoji u ovoj firmi/,
  );
  assert.equal(calls.some((text) => text.startsWith("insert into products")), false);
  assert.equal(calls.some((text) => text.startsWith("update products")), false);
});

test("saveProduct records a creation in the audit log", async () => {
  const calls: string[] = [];
  const sql = sqlMock(() => [], calls);

  const id = await saveProduct(sql, actor, {
    name: "Burger",
    sellPrice: "500",
    saleUnit: "kom",
    consumeMode: "recept",
  });

  assert.ok(id);
  assert.equal(calls.some((text) => text.includes("insert into audit_log")), true);
});

test("saveRecipe rejects an ingredient owned by another organization", async () => {
  const calls: string[] = [];
  const sql = sqlMock((text) => {
    if (text.includes("from products where id=$1 and org_id=$2")) {
      return [{ id: "product-1" }];
    }
    return [];
  }, calls);

  await assert.rejects(
    saveRecipe(sql, actor, {
      productId: "product-1",
      lines: [{ articleId: "foreign-article", qty: "100", unit: "g", role: "sastojak" }],
    }),
    /Sastojak recepture ne postoji u ovoj firmi/,
  );
  assert.equal(calls.some((text) => text.startsWith("insert into recipe_versions")), false);
  assert.equal(calls.some((text) => text.startsWith("insert into recipe_lines")), false);
});
