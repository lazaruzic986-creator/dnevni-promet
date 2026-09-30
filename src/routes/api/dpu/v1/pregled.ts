import { createFileRoute } from "@tanstack/react-router";
import { dbSource, getSql } from "@/lib/db";
import { snapshot } from "@/lib/h/engine-ops";
import { tokenFromAuthHeader, tokenHashes } from "@/lib/h/keys";

export const Route = createFileRoute("/api/dpu/v1/pregled")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const token = tokenFromAuthHeader(request.headers.get("authorization") ?? "");
        if (!token) return Response.json({ greska: "Nedostaje ključ." }, { status: 401 });
        const [hash, lower] = tokenHashes(token);
        const sql = await getSql();
        const rows = await sql.query<{ org_id: string; scopes: Record<string, boolean> }>(
          `select org_id, scopes from api_tokens
           where revoked_at is null and (token_hash = $1 or token_hash = $2)`,
          [hash, lower],
        );
        const tokenRow = rows[0];
        if (!tokenRow) {
          const counted = await sql.query<{ n: number }>(`select count(*)::int as n from api_tokens where revoked_at is null`);
          const n = Number(counted[0]?.n ?? 0);
          const greska = n === 0
            ? "Na ovoj adresi nema sačuvanog ključa. Napravite ga ovde, na stranici Povezivanje. Ključ iz pregleda u četu ovde ne važi."
            : "Ključ nije važeći. Pošaljite ga u jednom redu, bez razmaka, sa ove iste adrese.";
          return Response.json({ greska, baza: dbSource, kljuceva: n }, { status: 401 });
        }
        const url = new URL(request.url);
        const from = url.searchParams.get("od") ?? new Date().toISOString().slice(0, 10);
        const to = url.searchParams.get("do") ?? from;
        const scopes = tokenRow.scopes ?? {};
        const out: Record<string, unknown> = { od: from, do: to, ukljuceno: scopes };
        if (scopes.promet) out.promet = await snapshot(sql, tokenRow.org_id, from, to, false);
        if (scopes.zalihe) {
          out.zalihe = await sql.query(
            `select name, base_unit, on_hand::text, avg_cost::text from articles where org_id=$1 and tracks_stock and is_demo=false order by name`,
            [tokenRow.org_id],
          );
        }
        if (scopes.dokumenti) {
          out.racuni = await sql.query(
            `select doc_number, doc_date::text, status, total::text, kind from invoices
             where org_id=$1 and is_demo=false and coalesce(doc_date, received_date) between $2 and $3`,
            [tokenRow.org_id, from, to],
          );
        }
        if (scopes.upozorenja) {
          out.napomena = "Upozorenja nisu dokaz nepravilnosti. Otvorite kontrolni pregled u aplikaciji za detalje.";
        }
        if (scopes.upis) out.upis = "POST /api/dpu/v1/radnja";
        if (!scopes.promet && !scopes.zalihe && !scopes.dokumenti && !scopes.upozorenja) {
          out.napomena = scopes.upis
            ? "Ovaj ključ sme da upisuje. Čitanje prometa nije uključeno. Poziv je POST /api/dpu/v1/radnja."
            : "Vlasnik još nije uključio nijedan opseg za ovaj ključ.";
        }
        return Response.json(out);
      },
    },
  },
});
