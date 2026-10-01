export type CsvDelimiter = ";" | ",";

/** Detect the separator from the first non-empty CSV record, ignoring quoted fields. */
export function detectCsvDelimiter(text: string): CsvDelimiter {
  let quoted = false;
  let semicolons = 0;
  let commas = 0;
  for (const char of text.replace(/^\uFEFF/, "")) {
    if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (semicolons || commas) break;
    } else if (!quoted && char === ";") {
      semicolons += 1;
    } else if (!quoted && char === ",") {
      commas += 1;
    }
  }
  return semicolons >= commas ? ";" : ",";
}

/** Parse a small RFC 4180 style CSV/semicolon file, including quoted delimiters and newlines. */
export function parseSalesCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "");
  const delimiter = detectCsvDelimiter(source);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"' && cell.length === 0) {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell.trim());
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error("CSV sadrži nezatvoren navodnik.");
  if (cell.length || row.length) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows;
}

export async function fingerprintCsv(text: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Pregledač ne podržava bezbedan potpis CSV fajla.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Stable across retries, while preserving separate identical rows in one import. */
export function csvSaleIdempotencyKey(fingerprint: string, recordIndex: number): string {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Neispravan potpis CSV fajla.");
  if (!Number.isInteger(recordIndex) || recordIndex < 1) throw new Error("Neispravan broj CSV reda.");
  return `csv-${fingerprint}-${recordIndex}`;
}
