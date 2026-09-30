import { createHash } from "node:crypto";

/** Bearer value with line breaks and spaces removed. Chat wrap must not change the key. */
export function tokenFromAuthHeader(header: string): string {
  const raw = header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
  return raw.replace(/\s+/g, "");
}

/** Original and lowercased hashes. A bot that lowercases the header still matches a hex key. */
export function tokenHashes(token: string): [string, string] {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  return [hash(token), hash(token.toLowerCase())];
}
