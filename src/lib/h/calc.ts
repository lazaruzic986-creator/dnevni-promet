import { QSCALE, divRound, q, qStr } from "./money.ts";

export type RecipeRole =
  | "sastojak"
  | "dodatak"
  | "ambalaza"
  | "ambalaza_lokal"
  | "ambalaza_preuzimanje"
  | "ambalaza_dostava";

export type RecipeLine = {
  articleId: string;
  qtyPer: string;
  role: RecipeRole;
  addonCode: string | null;
};

export type Explosion = { articleId: string; qty: string; role: RecipeRole };

const CHANNEL_ROLE: Record<string, RecipeRole> = {
  lokal: "ambalaza_lokal",
  preuzimanje: "ambalaza_preuzimanje",
  dostava: "ambalaza_dostava",
};

/** Normative consumption for one sale line. Add-ons apply only when named. Omitted ingredients are skipped. */
export function explodeRecipe(
  lines: RecipeLine[],
  saleQty: string,
  channel: string,
  addons: string[],
  omitted: string[],
): Explosion[] {
  const qty = q(saleQty);
  if (qty === 0n) return [];
  const addonSet = new Set(addons.map((a) => a.trim().toLowerCase()).filter(Boolean));
  const omit = new Set(omitted);
  const channelRole = CHANNEL_ROLE[channel];
  const out: Explosion[] = [];
  for (const line of lines) {
    if (omit.has(line.articleId)) continue;
    if (line.role === "dodatak") {
      const code = (line.addonCode ?? "").trim().toLowerCase();
      if (!code || !addonSet.has(code)) continue;
    } else if (line.role === "ambalaza_lokal" || line.role === "ambalaza_preuzimanje" || line.role === "ambalaza_dostava") {
      if (!channelRole || line.role !== channelRole) continue;
    }
    const per = q(line.qtyPer);
    const total = divRound(per * qty, QSCALE);
    if (total === 0n) continue;
    out.push({ articleId: line.articleId, qty: qStr(total), role: line.role });
  }
  return out;
}

export function expectedCash(parts: {
  opening: bigint;
  cashSales: bigint;
  cashIn: bigint;
  cashRefunds: bigint;
  payouts: bigint;
  drop: bigint;
}): bigint {
  return parts.opening + parts.cashSales + parts.cashIn - parts.cashRefunds - parts.payouts - parts.drop;
}

/** Revenue is sales net. A cash drop is not a reduction of turnover. Card is not cash. */
export function turnover(parts: { cash: bigint; card: bigint; other: bigint; refunds: bigint }): bigint {
  return parts.cash + parts.card + parts.other - parts.refunds;
}
