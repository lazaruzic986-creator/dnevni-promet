export const ROLES = ["super_admin", "admin", "knjigovodja"] as const;
export type Role = (typeof ROLES)[number];

export const PERM_KEYS = [
  "racuni",
  "artikli",
  "recepture",
  "proizvodnja",
  "prodaja",
  "smene",
  "rashod",
  "popis",
  "porudzbine",
  "troskovi",
  "izvestaji",
  "podesavanja",
  "korisnici",
  "kontrola",
  "knjigovodja",
] as const;
export type PermKey = (typeof PERM_KEYS)[number];
export type Perms = Record<PermKey, boolean>;

export function allPerms(on: boolean): Perms {
  return Object.fromEntries(PERM_KEYS.map((k) => [k, on])) as Perms;
}

export function defaultPerms(role: Role): Perms {
  if (role === "super_admin") return allPerms(true);
  if (role === "knjigovodja") {
    const p = allPerms(false);
    p.izvestaji = true;
    p.knjigovodja = true;
    return p;
  }
  const p = allPerms(true);
  p.podesavanja = false;
  p.korisnici = false;
  p.kontrola = false;
  return p;
}

export function normalizePerms(role: Role, raw: unknown): Perms {
  const base = defaultPerms(role);
  if (!raw || typeof raw !== "object") return base;
  const src = raw as Record<string, unknown>;
  for (const key of PERM_KEYS) {
    if (typeof src[key] === "boolean") base[key] = src[key];
  }
  if (role === "super_admin") return allPerms(true);
  return base;
}

/** Accountant stays read-only. That is the product rule from the spec, not a Grok policy. */
export function assertCan(role: string, perms: Perms, key: PermKey, write: boolean): void {
  if (role === "super_admin") return;
  if (role === "knjigovodja" && write) {
    throw new Error("Knjigovođa može da pregleda i preuzima izveštaje, ne da menja zalihe ili knjiženja.");
  }
  if (!perms[key]) throw new Error("Nemate dozvolu za ovu radnju.");
}
