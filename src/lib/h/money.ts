/** Scaled integers. Quantities 4 dp, unit costs 6 dp (RSD per base unit), money 2 dp (para). */

export const QSCALE = 10_000n;
export const CSCALE = 1_000_000n;
export const MSCALE = 100n;
const VALUE_DIV = 100_000_000n; // QSCALE * CSCALE / MSCALE

export class MoneyError extends Error {}

/** Half away from zero. */
export function divRound(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new MoneyError("Deljenje nulom");
  const neg = n < 0n !== d < 0n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = an / ad;
  const r = an % ad;
  const up = r * 2n >= ad;
  const res = up ? q + 1n : q;
  return neg ? -res : res;
}

function scaleDigits(scale: bigint): number {
  return scale.toString().length - 1;
}

export function parseScaled(input: string | number, scale: bigint): bigint {
  let s = typeof input === "number" ? String(input) : input;
  if (typeof input === "number" && !Number.isFinite(input)) {
    throw new MoneyError("Broj nije ispravan");
  }
  s = s.trim().replace(/\s/g, "");
  if (!s) throw new MoneyError("Prazan broj");
  if (s.includes(",") && s.includes(".")) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (s.includes(",")) {
    s = s.replace(",", ".");
  }
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new MoneyError("Broj nije ispravan");
  const [whole, fracRaw = ""] = s.split(".");
  const digits = scaleDigits(scale);
  const frac = (fracRaw + "0".repeat(digits)).slice(0, digits);
  const rest = fracRaw.slice(digits);
  let v = BigInt(whole) * scale + BigInt(frac || "0");
  if (rest.length && rest[0] >= "5") v += 1n;
  return neg ? -v : v;
}

export function formatScaled(v: bigint, digits: number): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const scale = 10n ** BigInt(digits);
  const i = a / scale;
  const f = (a % scale).toString().padStart(digits, "0");
  return `${neg ? "-" : ""}${i}.${f}`;
}

export const q = (input: string | number) => parseScaled(input, QSCALE);
export const c = (input: string | number) => parseScaled(input, CSCALE);
export const m = (input: string | number) => parseScaled(input, MSCALE);
export const qStr = (v: bigint) => formatScaled(v, 4);
export const cStr = (v: bigint) => formatScaled(v, 6);
export const mStr = (v: bigint) => formatScaled(v, 2);

/** Line value in para from a base-unit quantity and a unit cost. */
export function valuePara(qty: bigint, unitCost: bigint): bigint {
  return divRound(qty * unitCost, VALUE_DIV);
}

export function unitCostFromTotal(totalPara: bigint, qty: bigint): bigint {
  if (qty === 0n) throw new MoneyError("Količina je nula");
  return divRound(totalPara * VALUE_DIV, qty);
}

export function applyInbound(
  onHand: bigint,
  avg: bigint | null,
  qtyIn: bigint,
  unitCost: bigint,
): { onHand: bigint; avg: bigint | null } {
  if (qtyIn <= 0n) throw new MoneyError("Ulaz mora biti pozitivan");
  const base = onHand > 0n ? onHand : 0n;
  const newOnHand = onHand + qtyIn;
  if (base === 0n) return { onHand: newOnHand, avg: unitCost };
  if (avg == null) return { onHand: newOnHand, avg: null };
  const newQty = base + qtyIn;
  const newAvg = divRound(base * avg + qtyIn * unitCost, newQty);
  return { onHand: newOnHand, avg: newAvg };
}

export function convertPack(qtyScaled: bigint, unitsPerPackScaled: bigint): bigint {
  return divRound(qtyScaled * unitsPerPackScaled, QSCALE);
}

const BUILTIN: Record<string, { base: "g" | "ml" | "kom"; factor: string }> = {
  g: { base: "g", factor: "1" },
  kg: { base: "g", factor: "1000" },
  ml: { base: "ml", factor: "1" },
  l: { base: "ml", factor: "1000" },
  kom: { base: "kom", factor: "1" },
};

export function builtinFactor(baseUnit: string, enteredUnit: string): string | null {
  const spec = BUILTIN[enteredUnit];
  if (!spec || spec.base !== baseUnit) return null;
  return spec.factor;
}

export function toBaseQty(baseUnit: string, enteredUnit: string, qty: string | number, packFactor: string | null): bigint {
  const amount = q(qty);
  if (packFactor != null) return convertPack(amount, q(packFactor));
  const factor = builtinFactor(baseUnit, enteredUnit);
  if (!factor) throw new MoneyError(`Jedinica ${enteredUnit} ne ide u ${baseUnit} bez pakovanja`);
  return convertPack(amount, q(factor));
}

export function formatRsd(value: string | null | undefined): string {
  if (value == null || value === "") return "nepoznato";
  const n = Number(value);
  if (!Number.isFinite(n)) return "nepoznato";
  return (
    new Intl.NumberFormat("sr-RS", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) +
    " RSD"
  );
}

export function formatQty(value: string | null | undefined, unit?: string): string {
  if (value == null || value === "") return "nepoznato";
  const n = Number(value);
  if (!Number.isFinite(n)) return "nepoznato";
  const text = new Intl.NumberFormat("sr-RS", { maximumFractionDigits: 3 }).format(n);
  return unit ? `${text} ${unit}` : text;
}

/** Display stock in a friendlier unit when the base is g or ml. */
export function displayStock(baseQty: string, baseUnit: string): { qty: string; unit: string } {
  const v = q(baseQty);
  if (baseUnit === "g" && v >= q("1000")) return { qty: qStr(divRound(v, 1000n)), unit: "kg" };
  if (baseUnit === "ml" && v >= q("1000")) return { qty: qStr(divRound(v, 1000n)), unit: "l" };
  return { qty: qStr(v), unit: baseUnit === "kom" ? "kom" : baseUnit };
}
