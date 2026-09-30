import { explodeRecipe, type RecipeLine, type RecipeRole } from "./calc.ts";
import {
  type Actor,
  type Sql,
  applyMove,
  assertPeriod,
  audit,
  newId,
  openShiftRow,
  qtyBaseOf,
  stamp,
  voidMoves,
} from "./engine.ts";
import { c, cStr, m, mStr, q, qStr, unitCostFromTotal, valuePara } from "./money.ts";

export async function saveProduct(
  sql: Sql,
  actor: Actor,
  input: {
    id?: string | null;
    name: string;
    code?: string | null;
    groupName?: string | null;
    sizeLabel?: string | null;
    sellPrice: string;
    saleUnit?: string;
    consumeMode: "recept" | "zaliha";
    outputArticleId?: string | null;
    posCode?: string | null;
    demo?: boolean;
  },
): Promise<string> {
  if (!String(input.sellPrice ?? "").trim()) throw new Error("Prodajna cena nije uneta. Nula nije upisana.");
  if (!String(input.saleUnit ?? "").trim()) throw new Error("Jedinica prodaje nije uneta. Komad nije pretpostavljen.");
  if (input.consumeMode === "zaliha" && !input.outputArticleId) {
    throw new Error("Priprema unapred mora imati artikal zalihe (porcije ili poluproizvod).");
  }
  if (input.outputArticleId) {
    const outputArticle = await sql.query<{ id: string }>(
      `select id from articles where id=$1 and org_id=$2`,
      [input.outputArticleId, actor.orgId],
    );
    if (!outputArticle[0]) throw new Error("Artikal izlaza ne postoji u ovoj firmi.");
  }
  const after = {
    name: input.name.trim(),
    code: input.code ?? null,
    groupName: input.groupName ?? null,
    sizeLabel: input.sizeLabel ?? null,
    sellPrice: mStr(m(input.sellPrice)),
    saleUnit: input.saleUnit,
    consumeMode: input.consumeMode,
    outputArticleId: input.outputArticleId ?? null,
    posCode: input.posCode ?? null,
  };
  if (input.id) {
    const existing = await sql.query<Record<string, unknown>>(
      `select code, name, group_name, size_label, sell_price::text, sale_unit, consume_mode, output_article_id, pos_code
       from products where id=$1 and org_id=$2`,
      [input.id, actor.orgId],
    );
    if (!existing[0]) throw new Error("Proizvod ne postoji u ovoj firmi.");
    await sql.query(
      `update products set name=$1, code=$2, group_name=$3, size_label=$4, sell_price=$5, sale_unit=$6, consume_mode=$7, output_article_id=$8, pos_code=$9
       where id=$10 and org_id=$11`,
      [
        after.name,
        after.code,
        after.groupName,
        after.sizeLabel,
        after.sellPrice,
        after.saleUnit,
        after.consumeMode,
        after.outputArticleId,
        after.posCode,
        input.id,
        actor.orgId,
      ],
    );
    await audit(sql, actor.orgId, actor.userId, "izmena", "proizvod", input.id, null, existing[0], after);
    if (input.posCode) {
      await sql.query(
        `insert into pos_map (id, org_id, pos_code, product_id) values ($1,$2,$3,$4)
         on conflict (org_id, pos_code) do update set product_id = excluded.product_id`,
        [newId(), actor.orgId, input.posCode, input.id],
      );
    }
    return input.id;
  }
  const id = newId();
  await sql.query(
    `insert into products (id, org_id, code, name, group_name, size_label, sell_price, sale_unit, consume_mode, output_article_id, pos_code, is_demo)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      actor.orgId,
      input.code ?? null,
      input.name.trim(),
      input.groupName ?? null,
      input.sizeLabel ?? null,
      mStr(m(input.sellPrice)),
      input.saleUnit,
      input.consumeMode,
      input.outputArticleId ?? null,
      input.posCode ?? null,
      Boolean(input.demo),
      ],
  );
  if (input.posCode) {
    await sql.query(
      `insert into pos_map (id, org_id, pos_code, product_id) values ($1,$2,$3,$4)
       on conflict (org_id, pos_code) do update set product_id = excluded.product_id`,
      [newId(), actor.orgId, input.posCode, id],
    );
  }
  await audit(sql, actor.orgId, actor.userId, "unos", "proizvod", id, null, null, after);
  return id;
}

export async function saveRecipe(
  sql: Sql,
  actor: Actor,
  input: {
    productId: string;
    validFrom?: string | null;
    note?: string | null;
    lines: { articleId: string; qty: string; unit: string; role: string; addonCode?: string | null; yieldRatio?: string | null }[];
  },
): Promise<string> {
  const product = await sql.query(`select id from products where id=$1 and org_id=$2`, [input.productId, actor.orgId]);
  if (!product[0]) throw new Error("Proizvod ne postoji");
  for (const line of input.lines) {
    const article = await sql.query<{ id: string }>(
      `select id from articles where id=$1 and org_id=$2`,
      [line.articleId, actor.orgId],
    );
    if (!article[0]) throw new Error("Sastojak recepture ne postoji u ovoj firmi.");
  }
  const versionId = newId();
  const from = input.validFrom ? new Date(input.validFrom).toISOString() : new Date().toISOString();
  await sql.query(
    `insert into recipe_versions (id, product_id, valid_from, note, created_by) values ($1,$2,$3,$4,$5)`,
    [versionId, input.productId, from, input.note ?? null, actor.userId],
  );
  for (const line of input.lines) {
    const base = await qtyBaseOf(sql, line.articleId, line.qty, line.unit);
    if (base <= 0n) throw new Error("Količina u recepturi mora biti veća od nule.");
    await sql.query(
      `insert into recipe_lines (id, version_id, article_id, qty, role, addon_code, yield_ratio) values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        newId(),
        versionId,
        line.articleId,
        qStr(base),
        line.role,
        line.addonCode ?? null,
        line.yieldRatio ?? null,
      ],
    );
  }
  await audit(sql, actor.orgId, actor.userId, "receptura", "proizvod", input.productId, input.note ?? null, null, {
    versionId,
    from,
    lines: input.lines.map((line) => ({
      articleId: line.articleId,
      qty: line.qty,
      unit: line.unit,
      role: line.role,
      addonCode: line.addonCode ?? null,
      yieldRatio: line.yieldRatio ?? null,
    })),
  });
  return versionId;
}

async function recipeAt(sql: Sql, productId: string, at: string): Promise<{ id: string; lines: RecipeLine[] } | null> {
  const versions = await sql.query<{ id: string }>(
    `select id from recipe_versions where product_id=$1 and valid_from <= $2::timestamptz order by valid_from desc limit 1`,
    [productId, at],
  );
  if (!versions[0]) return null;
  const lines = await sql.query<{ article_id: string; qty: string; role: string; addon_code: string | null }>(
    `select article_id, qty::text, role, addon_code from recipe_lines where version_id=$1`,
    [versions[0].id],
  );
  return {
    id: versions[0].id,
    lines: lines.map((l) => ({
      articleId: l.article_id,
      qtyPer: l.qty,
      role: l.role as RecipeRole,
      addonCode: l.addon_code,
    })),
  };
}

async function cashEvent(
  sql: Sql,
  args: {
    orgId: string;
    shiftId: string | null;
    kind: string;
    amount: bigint;
    refType: string;
    refId: string;
    note: string | null;
    userId: string;
    at: string;
    day: string;
    key: string | null;
    demo: boolean;
  },
): Promise<void> {
  if (args.amount === 0n) return;
  await sql.query(
    `insert into cash_events (id, org_id, shift_id, kind, amount, ref_type, ref_id, note, user_id, occurred_at, business_date, idempotency_key, is_demo)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      newId(),
      args.orgId,
      args.shiftId,
      args.kind,
      mStr(args.amount < 0n ? -args.amount : args.amount),
      args.refType,
      args.refId,
      args.note,
      args.userId,
      args.at,
      args.day,
      args.key,
      args.demo,
    ],
  );
}

type SaleLineIn = {
  productId: string | null;
  name: string;
  qty: string;
  unitPrice: string | null;
  lineNet: string;
  addons?: string[];
  omitted?: string[];
};

export async function postSale(
  sql: Sql,
  actor: Actor,
  input: {
    lines: SaleLineIn[];
    channel?: string;
    tenderCash?: string;
    tenderCard?: string;
    tenderOther?: string;
    tenderUnpaid?: string;
    discount?: string;
    occurredAt?: string | null;
    source?: string;
    externalKey: string;
    reason?: string | null;
    isSummary?: boolean;
    summaryNet?: string | null;
    note?: string | null;
    demo?: boolean;
    correctionReason?: string | null;
    orderId?: string | null;
    prepaid?: string;
  },
): Promise<{ id: string; duplicate: boolean; reconcileOnly: boolean; warnings: string[] }> {
  const warnings: string[] = [];
  const existing = await sql.query<{ id: string }>(
    `select id from sales where org_id=$1 and external_key=$2`,
    [actor.orgId, input.externalKey],
  );
  if (existing[0]) return { id: existing[0].id, duplicate: true, reconcileOnly: false, warnings: ["Ista prodaja je već knjižena."] };

  const channel = (input.channel ?? "").trim();
  if (channel && channel !== "lokal" && channel !== "preuzimanje" && channel !== "dostava") {
    throw new Error("Kanal je lokal, preuzimanje ili dostava. Nije pretpostavljen.");
  }
  if (!channel) warnings.push("Kanal nije naveden. Posebna ambalaža za lokal, preuzimanje ili dostavu nije uračunata.");

  const when = await stamp(sql, actor.orgId, input.occurredAt);
  await assertPeriod(sql, actor.orgId, when.day, actor.role, input.correctionReason ?? null);
  const shift = await openShiftRow(sql, actor.orgId);
  if (!shift) warnings.push("Nema otvorene smene. Prodaja je sačuvana, ali kasa nije vezana za smenu.");

  const detailed = await sql.query(
    `select id from sales where org_id=$1 and business_date=$2 and is_summary=false and reconcile_only=false and status='proknjizen' and is_demo=$3 limit 1`,
    [actor.orgId, when.day, Boolean(input.demo)],
  );
  const reconcileOnly = Boolean(input.isSummary) && detailed.length > 0;
  if (reconcileOnly) warnings.push("Detaljna prodaja za ovaj dan već postoji. Zbir je sačuvan samo za usaglašavanje, nije knjižen ponovo.");

  const demo = Boolean(input.demo);
  const cash = m(input.tenderCash ?? "0");
  const card = m(input.tenderCard ?? "0");
  const other = m(input.tenderOther ?? "0");
  const unpaid = m(input.tenderUnpaid ?? "0");
  const prepaid = m(input.prepaid ?? "0");
  let net = cash + card + other + unpaid + prepaid;
  if (input.isSummary) net = m(input.summaryNet ?? mStr(net));

  const saleId = newId();
  let cost = 0n;
  let costAny = false;
  let complete = !input.isSummary && !reconcileOnly;
  const basic = (input.lines ?? []).every((l) => !(l.addons?.length || l.omitted?.length));

  await sql.query(
    `insert into sales (id, org_id, status, source, external_key, occurred_at, business_date, shift_id, channel, net, discount,
      tender_cash, tender_card, tender_other, tender_unpaid, prepaid, reason, is_summary, reconcile_only, order_id, user_id,
      cost_value, cost_complete, basic_normative, is_demo, note)
     values ($1,$2,'proknjizen',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,null,false,$21,$22,$23)`,
    [
      saleId,
      actor.orgId,
      input.source ?? "rucno",
      input.externalKey,
      when.at,
      when.day,
      shift?.id ?? null,
      channel,
      mStr(net),
      mStr(m(input.discount ?? "0")),
      mStr(cash),
      mStr(card),
      mStr(other),
      mStr(unpaid),
      mStr(prepaid),
      input.reason ?? null,
      Boolean(input.isSummary),
      reconcileOnly,
      input.orderId ?? null,
      actor.userId,
      basic,
      demo,
      input.note ?? null,
    ],
  );

  if (!input.isSummary && !reconcileOnly) {
    for (const line of input.lines) {
      const lineId = newId();
      await sql.query(
        `insert into sale_lines (id, sale_id, product_id, name, qty, unit_price, line_net, addons, omitted, cost_complete)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,false)`,
        [
          lineId,
          saleId,
          line.productId,
          line.name,
          qStr(q(line.qty)),
          line.unitPrice != null ? mStr(m(line.unitPrice)) : null,
          mStr(m(line.lineNet)),
          JSON.stringify(line.addons ?? []),
          JSON.stringify(line.omitted ?? []),
        ],
      );
      let versionId: string | null = null;
      let lineCost = 0n;
      let lineComplete = true;
      let mode: string | null = null;
      if (!line.productId) {
        lineComplete = false;
        warnings.push(`${line.name}: nema vezan proizvod, utrošak nije obračunat.`);
      } else {
        const products = await sql.query<{ consume_mode: string; output_article_id: string | null; name: string }>(
          `select consume_mode, output_article_id, name from products where id=$1 and org_id=$2`,
          [line.productId, actor.orgId],
        );
        const product = products[0];
        if (!product) throw new Error("Proizvod nije iz ovog objekta.");
        mode = product.consume_mode;
        if (mode === "zaliha") {
          if (!product.output_article_id) throw new Error(`${product.name} nema artikal zalihe.`);
          const moved = await applyMove(sql, {
            orgId: actor.orgId,
            articleId: product.output_article_id,
            qtyDelta: -q(line.qty),
            inboundUnitCost: null,
            kind: "prodaja",
            refType: "prodaja",
            refId: saleId,
            businessDate: when.day,
            occurredAt: when.at,
            shiftId: shift?.id ?? null,
            userId: actor.userId,
            note: product.name,
            demo,
          });
          await sql.query(
            `insert into sale_consumptions (id, sale_line_id, article_id, qty, unit_cost, value) values ($1,$2,$3,$4,$5,$6)`,
            [newId(), lineId, product.output_article_id, qStr(q(line.qty)), moved.unitCost, moved.value],
          );
          if (!moved.complete || moved.value == null) lineComplete = false;
          else lineCost += -m(moved.value);
          if (moved.over) warnings.push(`${product.name}: prodaja je veća od evidentirane zalihe porcija.`);
        } else {
          const recipe = await recipeAt(sql, line.productId, when.at);
          if (!recipe) {
            lineComplete = false;
            warnings.push(`${line.name}: nema recepture koja važi na datum prodaje. Utrošak je nepoznat, nije nula.`);
          } else {
            versionId = recipe.id;
            const parts = explodeRecipe(recipe.lines, line.qty, channel, line.addons ?? [], line.omitted ?? []);
            if (!parts.length) {
              lineComplete = false;
              warnings.push(`${line.name}: receptura nema stavki za ovu prodaju.`);
            }
            for (const part of parts) {
              const moved = await applyMove(sql, {
                orgId: actor.orgId,
                articleId: part.articleId,
                qtyDelta: -q(part.qty),
                inboundUnitCost: null,
                kind: "prodaja",
                refType: "prodaja",
                refId: saleId,
                businessDate: when.day,
                occurredAt: when.at,
                shiftId: shift?.id ?? null,
                userId: actor.userId,
                note: line.name,
                demo,
              });
              await sql.query(
                `insert into sale_consumptions (id, sale_line_id, article_id, qty, unit_cost, value) values ($1,$2,$3,$4,$5,$6)`,
                [newId(), lineId, part.articleId, part.qty, moved.unitCost, moved.value],
              );
              if (!moved.complete || moved.value == null) lineComplete = false;
              else lineCost += -m(moved.value);
              if (moved.over) warnings.push(`${line.name}: utrošak prelazi evidentiranu zalihu.`);
            }
          }
        }
      }
      if (!lineComplete) complete = false;
      else {
        cost += lineCost;
        costAny = true;
      }
      await sql.query(
        `update sale_lines set recipe_version_id=$1, consume_mode=$2, cost_value=$3, cost_complete=$4 where id=$5`,
        [versionId, mode, lineComplete ? mStr(lineCost) : null, lineComplete, lineId],
      );
    }
  } else if (input.isSummary) {
    complete = false;
    warnings.push("Zbirni promet nema stavke. Utrošak namirnica se ne može izračunati.");
  }

  await sql.query(`update sales set cost_value=$1, cost_complete=$2 where id=$3`, [
    complete ? mStr(cost) : costAny ? mStr(cost) : null,
    complete,
    saleId,
  ]);

  if (!reconcileOnly && cash > 0n) {
    await cashEvent(sql, {
      orgId: actor.orgId,
      shiftId: shift?.id ?? null,
      kind: "naplata",
      amount: cash,
      refType: "prodaja",
      refId: saleId,
      note: "Gotovinska naplata",
      userId: actor.userId,
      at: when.at,
      day: when.day,
      key: input.externalKey + ":kes",
      demo,
    });
  }
  if (basic && (input.source === "csv" || input.source === "kasa" || input.source === "excel")) {
    warnings.push("Uvoz nema dodatke ni izmene. Utrošak je po osnovnom normativu.");
  }
  return { id: saleId, duplicate: false, reconcileOnly, warnings };
}

export async function postRefund(
  sql: Sql,
  actor: Actor,
  input: {
    saleId: string;
    amount: string;
    method: "kes" | "kartica" | "prenos";
    restoresStock: boolean;
    reason: string;
    idempotencyKey: string;
    occurredAt?: string | null;
  },
): Promise<{ id: string; duplicate: boolean }> {
  const existing = await sql.query<{ id: string }>(
    `select id from sales where org_id=$1 and external_key=$2`,
    [actor.orgId, input.idempotencyKey],
  );
  if (existing[0]) return { id: existing[0].id, duplicate: true };
  const orig = await sql.query<{ id: string; is_demo: boolean; channel: string }>(
    `select id, is_demo, channel from sales where id=$1 and org_id=$2 and status='proknjizen'`,
    [input.saleId, actor.orgId],
  );
  if (!orig[0]) throw new Error("Originalna prodaja nije pronađena.");
  if (!input.reason.trim()) throw new Error("Povraćaj traži razlog.");
  const when = await stamp(sql, actor.orgId, input.occurredAt);
  await assertPeriod(sql, actor.orgId, when.day, actor.role, input.reason);
  const amount = m(input.amount);
  const shift = await openShiftRow(sql, actor.orgId);
  const id = newId();
  const cash = input.method === "kes" ? amount : 0n;
  const card = input.method === "kartica" ? amount : 0n;
  const other = input.method === "prenos" ? amount : 0n;
  await sql.query(
    `insert into sales (id, org_id, status, source, external_key, occurred_at, business_date, shift_id, channel, net, discount,
      tender_cash, tender_card, tender_other, tender_unpaid, prepaid, is_refund, restores_stock, refund_of, reason, user_id,
      cost_complete, basic_normative, is_demo, note)
     values ($1,$2,'proknjizen','povracaj',$3,$4,$5,$6,$7,$8,0,$9,$10,$11,0,0,true,$12,$13,$14,$15,true,true,$16,$17)`,
    [
      id,
      actor.orgId,
      input.idempotencyKey,
      when.at,
      when.day,
      shift?.id ?? null,
      orig[0].channel,
      mStr(-amount),
      mStr(cash),
      mStr(card),
      mStr(other),
      input.restoresStock,
      input.saleId,
      input.reason,
      actor.userId,
      orig[0].is_demo,
      input.restoresStock ? "Povrat robe i novca" : "Samo povraćaj novca, sirovine ostaju utrošene",
    ],
  );
  if (input.restoresStock) {
    const cons = await sql.query<{ article_id: string; qty: string; unit_cost: string | null }>(
      `select c.article_id, c.qty::text, c.unit_cost::text from sale_consumptions c
       join sale_lines l on l.id = c.sale_line_id where l.sale_id = $1`,
      [input.saleId],
    );
    for (const row of cons) {
      await applyMove(sql, {
        orgId: actor.orgId,
        articleId: row.article_id,
        qtyDelta: q(row.qty),
        inboundUnitCost: row.unit_cost != null ? c(row.unit_cost) : null,
        kind: "povrat_robe",
        refType: "povracaj",
        refId: id,
        businessDate: when.day,
        occurredAt: when.at,
        shiftId: shift?.id ?? null,
        userId: actor.userId,
        note: input.reason,
        demo: orig[0].is_demo,
      });
    }
  }
  if (cash > 0n) {
    await cashEvent(sql, {
      orgId: actor.orgId,
      shiftId: shift?.id ?? null,
      kind: "povracaj",
      amount: cash,
      refType: "povracaj",
      refId: id,
      note: input.reason,
      userId: actor.userId,
      at: when.at,
      day: when.day,
      key: input.idempotencyKey,
      demo: orig[0].is_demo,
    });
  }
  await audit(sql, actor.orgId, actor.userId, "povracaj", "prodaja", input.saleId, input.reason, null, {
    amount: mStr(amount),
    restoresStock: input.restoresStock,
  });
  return { id, duplicate: false };
}

export async function voidSale(sql: Sql, actor: Actor, saleId: string, reason: string): Promise<void> {
  if (!reason.trim()) throw new Error("Storno traži razlog.");
  const sale = await sql.query<{ status: string; business_date: string; tender_cash: string; is_demo: boolean }>(
    `select status, business_date::text, tender_cash::text, is_demo from sales where id=$1 and org_id=$2`,
    [saleId, actor.orgId],
  );
  if (!sale[0]) throw new Error("Prodaja ne postoji");
  if (sale[0].status === "storno") return;
  await assertPeriod(sql, actor.orgId, sale[0].business_date, actor.role, reason);
  await voidMoves(sql, "prodaja", saleId, actor.userId);
  await sql.query(`update sales set status='storno' where id=$1`, [saleId]);
  const cash = m(sale[0].tender_cash);
  if (cash > 0n) {
    const when = await stamp(sql, actor.orgId, null);
    const shift = await openShiftRow(sql, actor.orgId);
    await cashEvent(sql, {
      orgId: actor.orgId,
      shiftId: shift?.id ?? null,
      kind: "povracaj",
      amount: cash,
      refType: "storno",
      refId: saleId,
      note: reason,
      userId: actor.userId,
      at: when.at,
      day: when.day,
      key: null,
      demo: sale[0].is_demo,
    });
  }
  await audit(sql, actor.orgId, actor.userId, "storno", "prodaja", saleId, reason, null, { status: "storno" });
}

export async function postProduction(
  sql: Sql,
  actor: Actor,
  input: {
    outputArticleId: string;
    plannedQty: string;
    actualQty: string;
    lines: { articleId: string; qty: string; unit: string }[];
    occurredAt?: string | null;
    note?: string | null;
    idempotencyKey: string;
    demo?: boolean;
  },
): Promise<{ id: string; duplicate: boolean; costComplete: boolean; warnings: string[] }> {
  const existing = await sql.query<{ id: string }>(
    `select id from production_batches where org_id=$1 and idempotency_key=$2`,
    [actor.orgId, input.idempotencyKey],
  );
  if (existing[0]) return { id: existing[0].id, duplicate: true, costComplete: false, warnings: [] };
  const when = await stamp(sql, actor.orgId, input.occurredAt);
  await assertPeriod(sql, actor.orgId, when.day, actor.role, null);
  const actual = q(input.actualQty);
  if (actual <= 0n) throw new Error("Stvarno dobijena količina mora biti veća od nule.");
  const shift = await openShiftRow(sql, actor.orgId);
  const id = newId();
  const demo = Boolean(input.demo);
  let cost = 0n;
  let complete = true;
  const warnings: string[] = [];
  await sql.query(
    `insert into production_batches (id, org_id, output_article_id, planned_qty, actual_qty, status, occurred_at, business_date, shift_id, user_id, note, cost_complete, idempotency_key, is_demo)
     values ($1,$2,$3,$4,$5,'proknjizen',$6,$7,$8,$9,$10,false,$11,$12)`,
    [
      id,
      actor.orgId,
      input.outputArticleId,
      qStr(q(input.plannedQty)),
      qStr(actual),
      when.at,
      when.day,
      shift?.id ?? null,
      actor.userId,
      input.note ?? null,
      input.idempotencyKey,
      demo,
    ],
  );
  for (const line of input.lines) {
    const base = await qtyBaseOf(sql, line.articleId, line.qty, line.unit);
    await sql.query(`insert into production_lines (id, batch_id, article_id, qty) values ($1,$2,$3,$4)`, [
      newId(),
      id,
      line.articleId,
      qStr(base),
    ]);
    const moved = await applyMove(sql, {
      orgId: actor.orgId,
      articleId: line.articleId,
      qtyDelta: -base,
      inboundUnitCost: null,
      kind: "proizvodnja_izlaz",
      refType: "proizvodnja",
      refId: id,
      businessDate: when.day,
      occurredAt: when.at,
      shiftId: shift?.id ?? null,
      userId: actor.userId,
      note: input.note ?? null,
      demo,
    });
    if (!moved.complete || moved.value == null) complete = false;
    else cost += -m(moved.value);
    if (moved.over) warnings.push("Utrošak sirovine je veći od zalihe.");
  }
  const unit = complete ? unitCostFromTotal(cost, actual) : null;
  await applyMove(sql, {
    orgId: actor.orgId,
    articleId: input.outputArticleId,
    qtyDelta: actual,
    inboundUnitCost: unit,
    kind: "proizvodnja_ulaz",
    refType: "proizvodnja",
    refId: id,
    businessDate: when.day,
    occurredAt: when.at,
    shiftId: shift?.id ?? null,
    userId: actor.userId,
    note: input.note ?? null,
    demo,
  });
  await sql.query(`update production_batches set cost_value=$1, cost_complete=$2 where id=$3`, [
    complete ? mStr(cost) : null,
    complete,
    id,
  ]);
  if (q(input.plannedQty) !== actual) {
    warnings.push("Prinos se razlikuje od plana. Razlika je u ceni porcije, nije poseban rashod.");
  }
  return { id, duplicate: false, costComplete: complete, warnings };
}

export async function postWaste(
  sql: Sql,
  actor: Actor,
  input: {
    articleId?: string | null;
    productId?: string | null;
    qty: string;
    unit: string;
    reason: string;
    note?: string | null;
    photoUrl?: string | null;
    allowOver: boolean;
    occurredAt?: string | null;
    idempotencyKey: string;
    demo?: boolean;
  },
): Promise<{ id: string; duplicate: boolean; value: string | null; over: boolean; warnings: string[] }> {
  const existing = await sql.query<{ id: string }>(
    `select id from wastes where org_id=$1 and idempotency_key=$2`,
    [actor.orgId, input.idempotencyKey],
  );
  if (existing[0]) return { id: existing[0].id, duplicate: true, value: null, over: false, warnings: [] };
  const when = await stamp(sql, actor.orgId, input.occurredAt);
  await assertPeriod(sql, actor.orgId, when.day, actor.role, null);
  const shift = await openShiftRow(sql, actor.orgId);
  const id = newId();
  const demo = Boolean(input.demo);
  const warnings: string[] = [];
  let value = 0n;
  let complete = true;
  let over = false;
  let qtyBase = q("0");
  if (input.productId) {
    const recipe = await recipeAt(sql, input.productId, when.at);
    if (!recipe) throw new Error("Gotov proizvod nema recepturu, rashod sirovina nije moguć.");
    const parts = explodeRecipe(recipe.lines, input.qty, "", [], []);
    if (recipe.lines.some((line) => line.role.startsWith("ambalaza_"))) {
      warnings.push("Rashod nema kanal. Posebna ambalaža za lokal, preuzimanje ili dostavu nije skinuta.");
    }
    qtyBase = q(input.qty);
    for (const part of parts) {
      const moved = await applyMove(sql, {
        orgId: actor.orgId,
        articleId: part.articleId,
        qtyDelta: -q(part.qty),
        inboundUnitCost: null,
        kind: "rashod",
        refType: "rashod",
        refId: id,
        businessDate: when.day,
        occurredAt: when.at,
        shiftId: shift?.id ?? null,
        userId: actor.userId,
        note: input.reason,
        demo,
      });
      if (moved.over) over = true;
      if (!moved.complete || moved.value == null) complete = false;
      else value += -m(moved.value);
    }
  } else if (input.articleId) {
    qtyBase = await qtyBaseOf(sql, input.articleId, input.qty, input.unit);
    const moved = await applyMove(sql, {
      orgId: actor.orgId,
      articleId: input.articleId,
      qtyDelta: -qtyBase,
      inboundUnitCost: null,
      kind: "rashod",
      refType: "rashod",
      refId: id,
      businessDate: when.day,
      occurredAt: when.at,
      shiftId: shift?.id ?? null,
      userId: actor.userId,
      note: input.reason,
      demo,
    });
    over = moved.over;
    if (!moved.complete || moved.value == null) complete = false;
    else value = -m(moved.value);
  } else throw new Error("Izaberite artikal ili proizvod.");
  if (over && !input.allowOver) {
    throw new Error("Količina je veća od evidentirane zalihe. Proverite jedinicu. Ako je stvarno tako, potvrdite rashod preko zalihe.");
  }
  if (over) warnings.push("Rashod je veći od zalihe. Zaliha može otići u minus dok se ne proveri.");
  await sql.query(
    `insert into wastes (id, org_id, article_id, product_id, qty, unit_name, qty_base, reason, note, photo_url, value, cost_complete, over_stock, occurred_at, business_date, shift_id, user_id, idempotency_key, is_demo)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      id,
      actor.orgId,
      input.articleId ?? null,
      input.productId ?? null,
      qStr(q(input.qty)),
      input.unit,
      qStr(qtyBase),
      input.reason,
      input.note ?? null,
      input.photoUrl ?? null,
      complete ? mStr(value) : null,
      complete,
      over,
      when.at,
      when.day,
      shift?.id ?? null,
      actor.userId,
      input.idempotencyKey,
      demo,
    ],
  );
  return { id, duplicate: false, value: complete ? mStr(value) : null, over, warnings };
}

export async function startCount(
  sql: Sql,
  actor: Actor,
  input: { scope: "sve" | "deo"; articleIds?: string[]; note?: string | null },
): Promise<string> {
  const when = await stamp(sql, actor.orgId, null);
  const id = newId();
  await sql.query(
    `insert into counts (id, org_id, status, scope, started_at, business_date, user_id, note) values ($1,$2,'nacrt',$3,$4,$5,$6,$7)`,
    [id, actor.orgId, input.scope, when.at, when.day, actor.userId, input.note ?? null],
  );
  const arts =
    input.scope === "sve"
      ? await sql.query<{ id: string; on_hand: string }>(
          `select id, on_hand::text from articles where org_id=$1 and tracks_stock=true and active=true`,
          [actor.orgId],
        )
      : await sql.query<{ id: string; on_hand: string }>(
          `select id, on_hand::text from articles where org_id=$1 and tracks_stock=true and id = any($2::uuid[])`,
          [actor.orgId, input.articleIds ?? []],
        );
  for (const art of arts) {
    await sql.query(
      `insert into count_lines (id, count_id, article_id, expected_qty) values ($1,$2,$3,$4)`,
      [newId(), id, art.id, art.on_hand],
    );
  }
  return id;
}

export async function setCountQty(sql: Sql, actor: Actor, countId: string, articleId: string, counted: string): Promise<void> {
  const qty = q(counted);
  if (qty < 0n) throw new Error("Prebrojana količina ne može biti negativna.");
  const count = await sql.query<{ status: string }>(
    `select status from counts where id=$1 and org_id=$2 for update`,
    [countId, actor.orgId],
  );
  if (!count[0] || count[0].status !== "nacrt") throw new Error("Popis nije otvoren.");
  const article = await sql.query(
    `select id from articles where id=$1 and org_id=$2 for update`,
    [articleId, actor.orgId],
  );
  if (!article[0]) throw new Error("Artikal ne postoji u ovoj firmi.");
  const updated = await sql.query(
    `update count_lines set counted_qty=$1, counted_at=now() where count_id=$2 and article_id=$3 returning id`,
    [qStr(qty), countId, articleId],
  );
  if (!updated[0]) throw new Error("Artikal nije deo ovog popisa.");
}

export async function postCount(sql: Sql, actor: Actor, countId: string): Promise<{ lines: number }> {
  const header = await sql.query<{ status: string; business_date: string; started_at: string }>(
    `select status, business_date::text, started_at::text from counts where id=$1 and org_id=$2 for update`,
    [countId, actor.orgId],
  );
  if (!header[0]) throw new Error("Popis ne postoji");
  if (header[0].status === "proknjizen") return { lines: 0 };
  await assertPeriod(sql, actor.orgId, header[0].business_date, actor.role, null);
  const when = await stamp(sql, actor.orgId, null);
  const lines = await sql.query<{
    article_id: string;
    expected_qty: string;
    counted_qty: string | null;
    counted_at: string | null;
  }>(
    `select article_id, expected_qty::text, counted_qty::text, counted_at::text
     from count_lines where count_id=$1 order by article_id`,
    [countId],
  );
  const missing = lines.filter((line) => line.counted_qty == null || line.counted_at == null).length;
  if (missing > 0) {
    throw new Error(`Popis nije potpun: unesite količinu za svih ${missing} preostalih stavki pre knjiženja.`);
  }
  for (const line of lines) {
    const current = await sql.query<{ on_hand: string }>(
      `select on_hand::text from articles where id=$1 and org_id=$2 for update`,
      [line.article_id, actor.orgId],
    );
    if (!current[0]) throw new Error("Artikal iz popisa ne postoji u ovoj firmi.");
    const movements = await sql.query<{ during_count: string; after_count: string }>(
      `select
         coalesce(sum(qty) filter (
           where occurred_at > $2::timestamptz and occurred_at <= $3::timestamptz
         ), 0)::text as during_count,
         coalesce(sum(qty) filter (
           where occurred_at > $3::timestamptz and occurred_at <= $4::timestamptz
         ), 0)::text as after_count
       from stock_moves where article_id=$1`,
      [line.article_id, header[0].started_at, line.counted_at, when.at],
    );
    const expectedAtCount = q(line.expected_qty) + q(movements[0]?.during_count ?? "0");
    const diff = q(line.counted_qty!) - expectedAtCount;
    const targetNow = q(line.counted_qty!) + q(movements[0]?.after_count ?? "0");
    const adjustment = targetNow - q(current[0].on_hand);
    let value: string | null = "0.00";
    let complete = true;
    if (adjustment !== 0n) {
      const moved = await applyMove(sql, {
        orgId: actor.orgId,
        articleId: line.article_id,
        qtyDelta: adjustment,
        inboundUnitCost: null,
        kind: "popis",
        refType: "popis",
        refId: countId,
        businessDate: header[0].business_date,
        occurredAt: when.at,
        shiftId: null,
        userId: actor.userId,
        note: "Popisna razlika prilagođena kretanjima posle brojanja",
        demo: false,
      });
      value = moved.value;
      complete = moved.complete;
    }
    await sql.query(
      `update count_lines set diff_qty=$1, value=$2, cost_complete=$3 where count_id=$4 and article_id=$5`,
      [qStr(diff), value, complete, countId, line.article_id],
    );
  }
  await sql.query(`update counts set status='proknjizen', posted_at=now() where id=$1`, [countId]);
  await audit(sql, actor.orgId, actor.userId, "popis", "popis", countId, null, null, { lines: lines.length });
  return { lines: lines.length };
}

export async function openShift(
  sql: Sql,
  actor: Actor,
  input: { openingCash: string; occurredAt?: string | null },
): Promise<string> {
  const existing = await openShiftRow(sql, actor.orgId);
  if (existing) throw new Error("Smena je već otvorena.");
  const when = await stamp(sql, actor.orgId, input.occurredAt);
  const id = newId();
  if (input.openingCash == null || String(input.openingCash).trim() === "") {
    throw new Error("Početni novac nije unet. Ako je fioka prazna, upišite 0.");
  }
  const cash = m(input.openingCash);
  await sql.query(
    `insert into shifts (id, org_id, status, business_date, opened_at, opener_id, opening_cash) values ($1,$2,'otvorena',$3,$4,$5,$6)`,
    [id, actor.orgId, when.day, when.at, actor.userId, mStr(cash)],
  );
  if (cash !== 0n) {
    await cashEvent(sql, {
      orgId: actor.orgId,
      shiftId: id,
      kind: "otvaranje",
      amount: cash,
      refType: "smena",
      refId: id,
      note: "Početni novac",
      userId: actor.userId,
      at: when.at,
      day: when.day,
      key: null,
      demo: false,
    });
  }
  return id;
}

export async function addCashMove(
  sql: Sql,
  actor: Actor,
  input: { kind: "ulaz" | "isplata" | "polog"; amount: string; note?: string | null; idempotencyKey: string },
): Promise<void> {
  const claim = await sql.query(
    `insert into idempotency (org_id, key, kind) values ($1,$2,'kasa') on conflict do nothing returning key`,
    [actor.orgId, input.idempotencyKey],
  );
  if (!claim.length) return;
  const shift = await openShiftRow(sql, actor.orgId);
  if (!shift) throw new Error("Nema otvorene smene.");
  const when = await stamp(sql, actor.orgId, null);
  await cashEvent(sql, {
    orgId: actor.orgId,
    shiftId: shift.id,
    kind: input.kind,
    amount: m(input.amount),
    refType: "kasa",
    refId: shift.id,
    note: input.note ?? null,
    userId: actor.userId,
    at: when.at,
    day: when.day,
    key: input.idempotencyKey,
    demo: false,
  });
  await sql.query(`update idempotency set ref_id=$1 where org_id=$2 and key=$3`, [shift.id, actor.orgId, input.idempotencyKey]);
}

const CASH_SIGN: Record<string, bigint> = {
  otvaranje: 1n,
  naplata: 1n,
  ulaz: 1n,
  avans: 1n,
  povracaj: -1n,
  isplata: -1n,
  polog: -1n,
  korekcija: 1n,
};

export async function expectedCashOf(sql: Sql, shiftId: string): Promise<bigint> {
  const rows = await sql.query<{ kind: string; amount: string }>(
    `select kind, amount::text from cash_events where shift_id=$1`,
    [shiftId],
  );
  let sum = 0n;
  for (const row of rows) sum += (CASH_SIGN[row.kind] ?? 1n) * m(row.amount);
  return sum;
}

export async function closeShift(
  sql: Sql,
  actor: Actor,
  input: { counted: string; note?: string | null },
): Promise<{ expected: string; counted: string; variance: string }> {
  const shift = await openShiftRow(sql, actor.orgId);
  if (!shift) throw new Error("Nema otvorene smene.");
  const expected = await expectedCashOf(sql, shift.id);
  const counted = m(input.counted);
  const variance = counted - expected;
  const when = await stamp(sql, actor.orgId, null);
  await sql.query(
    `update shifts set status='zatvorena', closed_at=$1, closer_id=$2, expected_cash=$3, counted_cash=$4, variance=$5, variance_note=$6 where id=$7`,
    [when.at, actor.userId, mStr(expected), mStr(counted), mStr(variance), input.note ?? null, shift.id],
  );
  await audit(sql, actor.orgId, actor.userId, "zatvaranje_smene", "smena", shift.id, input.note ?? null, null, {
    expected: mStr(expected),
    counted: mStr(counted),
    variance: mStr(variance),
  });
  return { expected: mStr(expected), counted: mStr(counted), variance: mStr(variance) };
}

export async function correctShift(
  sql: Sql,
  actor: Actor,
  input: { shiftId: string; counted: string; reason: string },
): Promise<void> {
  if (actor.role !== "super_admin") throw new Error("Korekciju zatvorene smene radi vlasnik.");
  if (!input.reason.trim()) throw new Error("Unesite razlog korekcije.");
  const shift = await sql.query<{ id: string; status: string; expected_cash: string | null }>(
    `select id, status, expected_cash::text from shifts where id=$1 and org_id=$2`,
    [input.shiftId, actor.orgId],
  );
  if (!shift[0] || shift[0].status !== "zatvorena") throw new Error("Korekcija je za zatvorenu smenu.");
  const expected = shift[0].expected_cash != null ? m(shift[0].expected_cash) : await expectedCashOf(sql, input.shiftId);
  const counted = m(input.counted);
  await sql.query(
    `update shifts set counted_cash=$1, variance=$2, variance_note=$3, corrected=true, correction_reason=$4 where id=$5`,
    [mStr(counted), mStr(counted - expected), input.reason, input.reason, input.shiftId],
  );
  await audit(sql, actor.orgId, actor.userId, "korekcija_smene", "smena", input.shiftId, input.reason, shift[0], {
    counted: mStr(counted),
  });
}

export async function saveExpense(
  sql: Sql,
  actor: Actor,
  input: { title: string; amount: string; category?: string | null; fromCash: boolean; note?: string | null; occurredAt?: string | null; idempotencyKey: string },
): Promise<string> {
  const claim = await sql.query(
    `insert into idempotency (org_id, key, kind) values ($1,$2,'trosak') on conflict do nothing returning key`,
    [actor.orgId, input.idempotencyKey],
  );
  if (!claim.length) {
    const prev = await sql.query<{ ref_id: string | null }>(`select ref_id from idempotency where org_id=$1 and key=$2`, [
      actor.orgId,
      input.idempotencyKey,
    ]);
    return prev[0]?.ref_id ?? "";
  }
  const when = await stamp(sql, actor.orgId, input.occurredAt);
  const id = newId();
  const amount = m(input.amount);
  await sql.query(
    `insert into expenses (id, org_id, title, amount, category, business_date, occurred_at, note, user_id, source)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'rucno')`,
    [id, actor.orgId, input.title.trim(), mStr(amount), input.category ?? null, when.day, when.at, input.note ?? null, actor.userId],
  );
  if (input.fromCash) {
    const shift = await openShiftRow(sql, actor.orgId);
    await cashEvent(sql, {
      orgId: actor.orgId,
      shiftId: shift?.id ?? null,
      kind: "isplata",
      amount,
      refType: "trosak",
      refId: id,
      note: input.title,
      userId: actor.userId,
      at: when.at,
      day: when.day,
      key: input.idempotencyKey,
      demo: false,
    });
  }
  await sql.query(`update idempotency set ref_id=$1 where org_id=$2 and key=$3`, [id, actor.orgId, input.idempotencyKey]);
  return id;
}

export async function saveOrder(
  sql: Sql,
  actor: Actor,
  input: {
    id?: string | null;
    customerName: string;
    company?: string | null;
    phone?: string | null;
    dueAt?: string | null;
    place?: string | null;
    note?: string | null;
    status?: string;
    recurNote?: string | null;
    lines: { productId: string | null; name: string; qty: string; unitPrice: string }[];
  },
): Promise<string> {
  let id = input.id ?? null;
  if (id) {
    const cur = await sql.query<{ status: string; sale_id: string | null }>(
      `select status, sale_id from orders where id=$1 and org_id=$2`,
      [id, actor.orgId],
    );
    if (cur[0]?.sale_id) throw new Error("Realizovana porudžbina se ne menja. Napravite novu.");
    await sql.query(
      `update orders set customer_name=$1, company=$2, phone=$3, due_at=$4, place=$5, note=$6, status=$7, recur_note=$8 where id=$9`,
      [
        input.customerName.trim(),
        input.company ?? null,
        input.phone ?? null,
        input.dueAt ?? null,
        input.place ?? null,
        input.note ?? null,
        input.status ?? "najavljeno",
        input.recurNote ?? null,
        id,
      ],
    );
    await sql.query(`delete from order_lines where order_id=$1`, [id]);
  } else {
    id = newId();
    await sql.query(
      `insert into orders (id, org_id, customer_name, company, phone, due_at, place, note, status, recur_note, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        actor.orgId,
        input.customerName.trim(),
        input.company ?? null,
        input.phone ?? null,
        input.dueAt ?? null,
        input.place ?? null,
        input.note ?? null,
        input.status ?? "najavljeno",
        input.recurNote ?? null,
        actor.userId,
      ],
    );
  }
  for (const line of input.lines) {
    await sql.query(
      `insert into order_lines (id, order_id, product_id, name, qty, unit_price) values ($1,$2,$3,$4,$5,$6)`,
      [newId(), id, line.productId, line.name, qStr(q(line.qty)), mStr(m(line.unitPrice))],
    );
  }
  return id;
}

export async function takeAdvance(
  sql: Sql,
  actor: Actor,
  input: { orderId: string; amount: string; idempotencyKey: string },
): Promise<void> {
  const claim = await sql.query(
    `insert into idempotency (org_id, key, kind) values ($1,$2,'avans') on conflict do nothing returning key`,
    [actor.orgId, input.idempotencyKey],
  );
  if (!claim.length) return;
  const order = await sql.query<{ id: string }>(`select id from orders where id=$1 and org_id=$2`, [input.orderId, actor.orgId]);
  if (!order[0]) throw new Error("Porudžbina ne postoji");
  const amount = m(input.amount);
  const when = await stamp(sql, actor.orgId, null);
  const shift = await openShiftRow(sql, actor.orgId);
  await sql.query(`update orders set advance = advance + $1 where id=$2`, [mStr(amount), input.orderId]);
  await cashEvent(sql, {
    orgId: actor.orgId,
    shiftId: shift?.id ?? null,
    kind: "avans",
    amount,
    refType: "avans",
    refId: input.orderId,
    note: "Avans, nije promet",
    userId: actor.userId,
    at: when.at,
    day: when.day,
    key: input.idempotencyKey,
    demo: false,
  });
}

export async function realizeOrder(
  sql: Sql,
  actor: Actor,
  input: { orderId: string; tenderCash: string; tenderCard: string; tenderOther: string; tenderUnpaid: string },
): Promise<{ saleId: string; duplicate: boolean; warnings: string[] }> {
  const order = await sql.query<{ id: string; status: string; sale_id: string | null; advance: string; customer_name: string }>(
    `select id, status, sale_id, advance::text, customer_name from orders where id=$1 and org_id=$2`,
    [input.orderId, actor.orgId],
  );
  if (!order[0]) throw new Error("Porudžbina ne postoji");
  if (order[0].sale_id) return { saleId: order[0].sale_id, duplicate: true, warnings: ["Porudžbina je već realizovana."] };
  const lines = await sql.query<{ product_id: string | null; name: string; qty: string; unit_price: string }>(
    `select product_id, name, qty::text, unit_price::text from order_lines where order_id=$1`,
    [input.orderId],
  );
  const advance = m(order[0].advance);
  const result = await postSale(sql, actor, {
    externalKey: `order-${input.orderId}`,
    source: "porudzbina",
    channel: "dostava",
    orderId: input.orderId,
    prepaid: mStr(advance),
    tenderCash: input.tenderCash,
    tenderCard: input.tenderCard,
    tenderOther: input.tenderOther,
    tenderUnpaid: input.tenderUnpaid,
    lines: lines.map((l) => ({
      productId: l.product_id,
      name: l.name,
      qty: l.qty,
      unitPrice: l.unit_price,
      lineNet: mStr(valuePara(q(l.qty), c(l.unit_price))),
    })),
    note: order[0].customer_name,
  });
  await sql.query(`update orders set status='isporuceno', sale_id=$1, advance_applied=$2 where id=$3`, [
    result.id,
    mStr(advance),
    input.orderId,
  ]);
  return { saleId: result.id, duplicate: result.duplicate, warnings: result.warnings };
}

export async function snapshot(
  sql: Sql,
  orgId: string,
  from: string,
  to: string,
  includeDemo: boolean,
): Promise<{
  revenue: string;
  costKnown: string | null;
  incomplete: number;
  waste: string | null;
  wasteIncomplete: number;
  purchases: string;
  expenses: string;
  card: string;
  cashSales: string;
  drops: string;
}> {
  const sales = await sql.query<{ net: string; cost: string | null; incomplete: number; card: string; cash: string }>(
    `select coalesce(sum(net),0)::text as net,
            coalesce(sum(cost_value) filter (where cost_complete),0)::text as cost,
            count(*) filter (where cost_complete = false and reconcile_only = false)::int as incomplete,
            coalesce(sum(tender_card) filter (where is_refund = false and status='proknjizen'),0)::text as card,
            coalesce(sum(tender_cash) filter (where is_refund = false and status='proknjizen' and reconcile_only=false),0)::text as cash
     from sales
     where org_id=$1 and business_date between $2 and $3 and status='proknjizen' and reconcile_only=false
       and ($4::boolean or is_demo=false)`,
    [orgId, from, to, includeDemo],
  );
  const waste = await sql.query<{ value: string | null; incomplete: number }>(
    `select coalesce(sum(value) filter (where cost_complete),0)::text as value,
            count(*) filter (where cost_complete = false)::int as incomplete
     from wastes where org_id=$1 and business_date between $2 and $3 and status='proknjizen' and ($4::boolean or is_demo=false)`,
    [orgId, from, to, includeDemo],
  );
  const purchases = await sql.query<{ total: string }>(
    `select coalesce(sum(total),0)::text as total from invoices
     where org_id=$1 and status='proknjizen' and kind='nabavka' and coalesce(doc_date, received_date) between $2 and $3
       and ($4::boolean or is_demo=false)`,
    [orgId, from, to, includeDemo],
  );
  const expenses = await sql.query<{ total: string }>(
    `select coalesce(sum(amount),0)::text as total from expenses
     where org_id=$1 and voided=false and business_date between $2 and $3 and ($4::boolean or is_demo=false)`,
    [orgId, from, to, includeDemo],
  );
  const drops = await sql.query<{ total: string }>(
    `select coalesce(sum(amount),0)::text as total from cash_events
     where org_id=$1 and kind='polog' and business_date between $2 and $3 and ($4::boolean or is_demo=false)`,
    [orgId, from, to, includeDemo],
  );
  const s = sales[0];
  const incomplete = Number(s?.incomplete ?? 0);
  return {
    revenue: s?.net ?? "0.00",
    costKnown: incomplete > 0 ? null : (s?.cost ?? "0.00"),
    incomplete,
    waste: Number(waste[0]?.incomplete ?? 0) > 0 ? null : (waste[0]?.value ?? "0.00"),
    wasteIncomplete: Number(waste[0]?.incomplete ?? 0),
    purchases: purchases[0]?.total ?? "0.00",
    expenses: expenses[0]?.total ?? "0.00",
    card: s?.card ?? "0.00",
    cashSales: s?.cash ?? "0.00",
    drops: drops[0]?.total ?? "0.00",
  };
}

export async function stockRow(sql: Sql, articleId: string): Promise<{ onHand: string; avg: string | null; name: string }> {
  const row = await sql.query<{ on_hand: string; avg_cost: string | null; name: string }>(
    `select on_hand::text, avg_cost::text, name from articles where id=$1`,
    [articleId],
  );
  if (!row[0]) throw new Error("Nema artikla");
  return { onHand: row[0].on_hand, avg: row[0].avg_cost, name: row[0].name };
}
