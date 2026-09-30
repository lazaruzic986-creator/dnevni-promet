import { createFileRoute } from "@tanstack/react-router";
import { dbSource, getSql, withTransaction } from "@/lib/db";
import { expandPacket, loadActor, runBotAction } from "@/lib/h/bot";
import { tokenFromAuthHeader, tokenHashes } from "@/lib/h/keys";

const UPUTSTVO = {
  poziv: "POST /api/dpu/v1/radnja",
  zaglavlje: "Authorization: Bearer ključ",
  pravila: [
    "Isti kljuc pri ponovnom slanju ne pravi dupli račun, rashod, prodaju ni popis.",
    "Nova poruka dobija novi kljuc.",
    "Ako nema jedinice, cene, recepture ili izbrojanog novca, to nije nula i nije pogađanje.",
    "Nejasan račun ostaje na proveri i ne dira zalihu.",
    "Nabavka nije promet. Polog ne smanjuje promet. Kartica nije keš.",
    "Rashod nije utrošak recepture i nije popis.",
    "Povraćaj novca ne vraća zalihu osim ako je vratiZalihu izričito true.",
    "Avans porudžbine nije uračunat i u kešu i posebno.",
    "Zatvaranje poredi izbrojan keš sa očekivanim. Razlika nije dobit. Plate, kirija, energija, amortizacija i porez nisu u marži osim ako su uneti kao trošak.",
    "Proknjižen dokument se ne briše. Ispravka je storno uz razlog.",
  ],
  primer: {
    kljuc: "2026-09-30-paket",
    artikli: [{ naziv: "Meso", jedinica: "g", vrsta: "sirovina" }],
    proizvodi: [{ naziv: "Burger", cena: "450" }],
    recepture: [{ proizvod: "Burger", stavke: [{ artikal: "Meso", kolicina: "150", jedinica: "g" }] }],
    racuni: [{
      dobavljac: "Mesara",
      broj: "12",
      datum: "2026-09-30",
      ukupno: "3000",
      stavke: [{ artikal: "Meso", kolicina: "2", jedinica: "kg", iznos: "3000" }],
    }],
    rashodi: [{ artikal: "Meso", kolicina: "200", jedinica: "g", razlog: "Prosipanje" }],
    zatvaranje: { izbrojano: "12500.00" },
  },
};

function scopesOf(raw: unknown): Record<string, boolean> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, boolean>;
    } catch {
      return {};
    }
  }
  if (typeof raw === "object") return raw as Record<string, boolean>;
  return {};
}

async function tokenOf(request: Request) {
  const token = tokenFromAuthHeader(request.headers.get("authorization") ?? "");
  if (!token) return { error: Response.json({ greska: "Nedostaje ključ." }, { status: 401 }) };
  const [hash, lower] = tokenHashes(token);
  const sql = await getSql();
  const rows = await sql.query<{ org_id: string; scopes: unknown; created_by: string | null; name: string }>(
    `select org_id, scopes, created_by, name from api_tokens
     where revoked_at is null and (token_hash = $1 or token_hash = $2)`,
    [hash, lower],
  );
  const row = rows[0];
  if (!row) {
    const counted = await sql.query<{ n: number }>(`select count(*)::int as n from api_tokens where revoked_at is null`);
    const n = Number(counted[0]?.n ?? 0);
    const greska = n === 0
      ? "Na ovoj adresi nema sačuvanog ključa. Napravite ga ovde, na stranici Povezivanje. Ključ iz pregleda u četu ovde ne važi."
      : "Ključ nije važeći. Pošaljite ga u jednom redu, bez razmaka, sa ove iste adrese.";
    return { error: Response.json({ greska, baza: dbSource, kljuceva: n }, { status: 401 }) };
  }
  if (!row.created_by) return { error: Response.json({ greska: "Ključ nema vlasnika." }, { status: 403 }) };
  return { row, scopes: scopesOf(row.scopes) };
}

export const Route = createFileRoute("/api/dpu/v1/radnja")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = await tokenOf(request);
        if ("error" in auth && auth.error) return auth.error;
        return Response.json({
          upis: Boolean(auth.scopes.upis),
          ukljuceno: auth.scopes,
          ...UPUTSTVO,
          napomena: auth.scopes.upis
            ? "Upis je uključen. Radi se u ime osobe koja je napravila ključ i ostaje u istoriji."
            : "Upis nije uključen. Vlasnik ga uključuje na stranici Povezivanje, pa pravi novi ključ.",
        });
      },
      POST: async ({ request }) => {
        const auth = await tokenOf(request);
        if ("error" in auth && auth.error) return auth.error;
        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return Response.json({ greska: "Telo nije JSON." }, { status: 400 });
        }
        let actions;
        try {
          actions = expandPacket(payload);
        } catch (err) {
          return Response.json({ greska: err instanceof Error ? err.message : "Poruka nije razumljiva." }, { status: 400 });
        }
        const writes = actions.some((action) => action.op !== "katalog");
        if (writes && !auth.scopes.upis) {
          return Response.json(
            { greska: "Upis nije uključen za ovaj ključ. Vlasnik ga uključuje na stranici Povezivanje i pravi novi ključ." },
            { status: 403 },
          );
        }
        if (!writes && !auth.scopes.upis && !auth.scopes.zalihe && !auth.scopes.promet && !auth.scopes.dokumenti) {
          return Response.json({ greska: "Nijedan opseg nije uključen za ovaj ključ." }, { status: 403 });
        }
        const nastavi = Boolean(payload && typeof payload === "object" && (payload as { nastavi?: boolean }).nastavi === true);
        const stavke: Record<string, unknown>[] = [];
        let stop = false;
        for (const action of actions) {
          if (stop) {
            stavke.push({ op: action.op, ok: false, greska: "Nije pokrenuto jer prethodna radnja nije uspela." });
            continue;
          }
          try {
            const rezultat = await withTransaction(async (sql) => {
              const actor = await loadActor(sql, auth.row.created_by as string);
              if (!actor || actor.orgId !== auth.row.org_id) throw new Error("Nalog koji je napravio ključ više nije u objektu.");
              return runBotAction(sql, actor, action, auth.row.name);
            });
            stavke.push({ op: action.op, ok: true, ...rezultat });
          } catch (err) {
            stavke.push({ op: action.op, ok: false, greska: err instanceof Error ? err.message : "Greška" });
            if (!nastavi) stop = true;
          }
        }
        return Response.json({
          obradjeno: stavke.filter((row) => row.ok).length,
          greske: stavke.filter((row) => !row.ok).length,
          stavke,
        });
      },
    },
  },
});
