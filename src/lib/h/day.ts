/** Business day in Europe/Belgrade (or the venue timezone). Hours before `endHour` belong to the previous day. */

export function zonedParts(date: Date, timeZone: string): { y: string; m: string; d: string; hour: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const parts = dtf.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0;
  return { y: get("year"), m: get("month"), d: get("day"), hour };
}

function prevIso(y: string, m: string, d: string): string {
  const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

export function businessDate(occurredAt: Date, endHour: number, timeZone = "Europe/Belgrade"): string {
  const p = zonedParts(occurredAt, timeZone);
  const iso = `${p.y}-${p.m}-${p.d}`;
  const end = Number.isFinite(endHour) ? endHour : 4;
  if (p.hour < end) return prevIso(p.y, p.m, p.d);
  return iso;
}

export function todayBusiness(endHour: number, timeZone = "Europe/Belgrade"): string {
  return businessDate(new Date(), endHour, timeZone);
}
