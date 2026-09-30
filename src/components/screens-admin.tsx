import { useState } from "react";
import { toast } from "sonner";
import { formatRsd, c, m, mStr, q, valuePara } from "@/lib/h/money";
import { commit, useBoot, useRead, useRefresh } from "./data";
import { GateNote } from "./shell";

function err(e: unknown) {
  toast.error(e instanceof Error ? e.message : "Greška");
}
function Field(props: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return <label className="field"><span>{props.label}</span><input type={props.type ?? "text"} value={props.value} onChange={(e) => props.onChange(e.target.value)} /></label>;
}

function Realize({ orderId, advance, rows, onDone }: { orderId: string; advance: string; rows: { qty: string; unit_price: string }[]; onDone: () => void }) {
  const [cash, setCash] = useState("");
  const [card, setCard] = useState("");
  const [unpaid, setUnpaid] = useState("");
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Field label="Keš pri realizaciji" value={cash} onChange={setCash} />
      <Field label="Kartica" value={card} onChange={setCard} />
      <Field label="Neplaćeno" value={unpaid} onChange={setUnpaid} />
      <button className="btn" type="button" onClick={async () => {
        const amount = window.prompt("Iznos avansa") ?? "";
        if (!amount.trim()) return;
        try { await commit("takeAdvance", { orderId, amount, idempotencyKey: crypto.randomUUID() }); toast.success("Avans je u kasi, nije u prometu"); onDone(); }
        catch (error) { err(error); }
      }}>Avans</button>
      <button className="btn btn-primary" type="button" onClick={async () => {
        if (!cash.trim() || !card.trim() || !unpaid.trim()) {
          toast.error("Unesite keš, karticu i neplaćeno. Ako je nula, upišite 0. Ostatak nije sam označen kao neplaćen.");
          return;
        }
        try {
          let total = 0n;
          for (const line of rows) total += valuePara(q(line.qty), c(line.unit_price));
          const covered = m(cash) + m(card) + m(unpaid) + m(advance || "0");
          const diff = covered > total ? covered - total : total - covered;
          if (diff > m("1")) { toast.error("Naplata i avans se ne slažu sa stavkama. Nije realizovano."); return; }
          const res = await commit("realizeOrder", {
            orderId,
            tenderCash: cash,
            tenderCard: card,
            tenderUnpaid: unpaid,
            idempotencyKey: `rel-${orderId}`,
          }) as { warnings?: string[] };
          res.warnings?.forEach((w) => toast.message(w));
          toast.success("Porudžbina je realizovana jednom. Avans nije uračunat dvaput.");
          onDone();
        } catch (error) { err(error); }
      }}>Realizuj</button>
    </div>
  );
}

export function OrdersPage() {
  const boot = useBoot();
  const refresh = useRefresh();
  const products = useRead<{ products: { id: string; name: string; sell_price: string }[] }>("products");
  const q = useRead<{
    orders: { id: string; customer_name: string; company: string | null; due_at: string | null; place: string | null; status: string; advance: string; sale_id: string | null; note: string | null }[];
    lines: { order_id: string; name: string; qty: string; unit_price: string }[];
  }>("orders");
  const [customer, setCustomer] = useState("");
  const [company, setCompany] = useState("");
  const [due, setDue] = useState("");
  const [place, setPlace] = useState("");
  const [productId, setProduct] = useState("");
  const [qty, setQty] = useState("");
  const [price, setPrice] = useState("");
  return (
    <GateNote boot={boot.data} perm="porudzbine">
      <div className="space-y-4">
        <h1 className="text-3xl">Porudžbine i ketering</h1>
        <p className="text-sm text-muted">Najava nije promet i ne skida robu. Avans nije prihod dok se porudžbina ne realizuje, i tada se ne računa dvaput.</p>
        <form className="card grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
          e.preventDefault();
          const product = products.data?.products.find((p) => p.id === productId);
          if (!product) { toast.error("Izaberite artikal."); return; }
          if (!qty.trim()) { toast.error("Unesite količinu."); return; }
          const unitPrice = price.trim();
          if (!unitPrice) { toast.error("Nema cene. Nula nije upisana."); return; }
          try {
            await commit("saveOrder", {
              customerName: customer, company, dueAt: due || null, place, status: "potvrdjeno", idempotencyKey: crypto.randomUUID(),
              lines: [{ productId, name: product.name, qty, unitPrice }],
            });
            toast.success("Porudžbina je sačuvana"); refresh();
          } catch (error) { err(error); }
        }}>
          <Field label="Kupac" value={customer} onChange={setCustomer} />
          <Field label="Firma" value={company} onChange={setCompany} />
          <Field label="Vreme" value={due} onChange={setDue} type="datetime-local" />
          <Field label="Mesto" value={place} onChange={setPlace} />
          <label className="field"><span>Artikal</span>
            <select value={productId} onChange={(e) => {
              const id = e.target.value;
              setProduct(id);
              const picked = products.data?.products.find((p) => p.id === id);
              setPrice(picked && m(picked.sell_price) > 0n ? picked.sell_price : "");
            }}><option value="">Izaberite</option>{(products.data?.products ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </label>
          <Field label="Količina" value={qty} onChange={setQty} />
          <Field label="Cena" value={price} onChange={setPrice} />
          <button className="btn btn-primary" type="submit">Sačuvaj najavu</button>
        </form>
        {(q.data?.orders ?? []).map((o) => (
          <div key={o.id} className="card space-y-2 text-sm">
            <p className="font-semibold">{o.customer_name} {o.company ? `· ${o.company}` : ""} · {o.status}</p>
            <p className="text-muted">{o.due_at ?? "bez termina"} · {o.place ?? ""} · avans {formatRsd(o.advance)}</p>
            {(q.data?.lines ?? []).filter((l) => l.order_id === o.id).map((l) => (
              <p key={l.name + l.qty}>{l.name}: {l.qty} × {formatRsd(l.unit_price)}</p>
            ))}
            {!o.sale_id && (
              <Realize orderId={o.id} advance={o.advance} rows={(q.data?.lines ?? []).filter((l) => l.order_id === o.id)} onDone={refresh} />
            )}
          </div>
        ))}
      </div>
    </GateNote>
  );
}

export function ExpensesPage() {
  const boot = useBoot();
  const refresh = useRefresh();
  const q = useRead<{ expenses: { id: string; title: string; amount: string; business_date: string; source: string }[]; payables: { id: string; doc_number: string | null; supplier: string | null; total: string | null; paid: string; due_date: string | null }[] }>("expenses");
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [fromCash, setCash] = useState(false);
  return (
    <GateNote boot={boot.data} perm="troskovi">
      <div className="space-y-4">
        <h1 className="text-3xl">Troškovi i obaveze</h1>
        <p className="text-sm text-muted">Plaćanje računa ne pravi novi trošak. Struja i kirija ne ulaze u robnu zalihu.</p>
        <form className="card grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
          e.preventDefault();
          try { await commit("saveExpense", { title, amount, fromCash, idempotencyKey: crypto.randomUUID() }); toast.success("Trošak je sačuvan"); refresh(); }
          catch (error) { err(error); }
        }}>
          <Field label="Naziv" value={title} onChange={setTitle} />
          <Field label="Iznos" value={amount} onChange={setAmount} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={fromCash} onChange={(e) => setCash(e.target.checked)} /> isplaćeno iz kase</label>
          <button className="btn btn-primary" type="submit">Sačuvaj trošak</button>
        </form>
        <h2 className="text-xl">Obaveze prema dobavljačima</h2>
        {(q.data?.payables ?? []).map((p) => (
          <p key={p.id} className="card text-sm">{p.supplier} · {p.doc_number} · račun {formatRsd(p.total)} · plaćeno {formatRsd(p.paid)} · dospeće {p.due_date ?? "nije uneto"}</p>
        ))}
        {(q.data?.expenses ?? []).map((ex) => <p key={ex.id} className="text-sm">{ex.business_date} · {ex.title} · {formatRsd(ex.amount)} · {ex.source}</p>)}
      </div>
    </GateNote>
  );
}

export function ReportsPage() {
  const boot = useBoot();
  const [from, setFrom] = useState(boot.data?.businessDate ?? "");
  const [to, setTo] = useState(boot.data?.businessDate ?? "");
  const [go, setGo] = useState(false);
  const q = useRead<{
    snap: { revenue: string; costKnown: string | null; incomplete: number; purchases: string; expenses: string; waste: string | null; card: string; cashSales: string; drops: string };
    byProduct: { name: string; qty: string; net: string; complete: boolean; cost: string | null }[];
    byPay: { kes: string; kartica: string; ostalo: string; neplaceno: string; povracaj: string };
    stock: { name: string; base_unit: string; on_hand: string; value: string | null }[];
  }>(go ? "report" : "home", go ? { from, to } : { day: boot.data?.businessDate });
  const report = go ? q.data as { snap: { revenue: string; costKnown: string | null; incomplete: number; purchases: string; expenses: string; waste: string | null; drops: string }; byProduct: { name: string; qty: string; net: string; complete: boolean; cost: string | null }[]; byPay: { kes: string; kartica: string; ostalo: string; povracaj: string }; stock: { name: string; on_hand: string; base_unit: string; value: string | null }[] } : null;
  return (
    <GateNote boot={boot.data} perm="izvestaji">
      <div className="space-y-4">
        <h1 className="text-3xl">Izveštaji</h1>
        <div className="flex flex-wrap gap-2">
          <Field label="Od" value={from} onChange={setFrom} type="date" />
          <Field label="Do" value={to} onChange={setTo} type="date" />
          <button className="btn btn-primary" type="button" onClick={() => setGo(true)}>Prikaži</button>
          <button className="btn" type="button" onClick={() => window.print()}>PDF (štampa)</button>
          <button className="btn" type="button" onClick={async () => {
            try {
              const res = await (await import("@/lib/h/api")).read({ data: { op: "export", body: { from, to } } }) as { base64: string; filename: string };
              const a = document.createElement("a");
              a.href = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${res.base64}`;
              a.download = res.filename;
              a.click();
            } catch (error) { err(error); }
          }}>Excel</button>
        </div>
        {report?.snap && (
          <div className="card space-y-2">
            <p>Promet {formatRsd(report.snap.revenue)}</p>
            <p>Poznati trošak sastojaka {report.snap.incomplete ? "nepotpun obračun" : formatRsd(report.snap.costKnown)}</p>
            <p>Nabavka robe {formatRsd(report.snap.purchases)} · ostali troškovi {formatRsd(report.snap.expenses)} · rashod {report.snap.waste == null ? "nepotpun" : formatRsd(report.snap.waste)} · polog {formatRsd(report.snap.drops)}</p>
            <p className="text-sm text-muted">Razlika prometa i troška sastojaka nije čista zarada. Nisu uključeni plate, kirija, energija, amortizacija i porez, osim ako su posebno uneti. Poreski tretman: cene su kako su unete ({boot.data?.org?.tax_mode}). Ovo nije zvanični poreski obrazac.</p>
            <p>Keš {formatRsd(report.byPay?.kes)} · kartica {formatRsd(report.byPay?.kartica)} · ostalo {formatRsd(report.byPay?.ostalo)} · povraćaj {formatRsd(report.byPay?.povracaj)}</p>
            <h2 className="text-xl">Po proizvodu</h2>
            {(report.byProduct ?? []).map((p) => <p key={p.name} className="text-sm">{p.name}: {p.qty} kom · {formatRsd(p.net)} · trošak {p.complete ? formatRsd(p.cost) : "nepotpun"}</p>)}
            <h2 className="text-xl">Zalihe</h2>
            {(report.stock ?? []).slice(0, 30).map((s) => <p key={s.name} className="text-sm">{s.name}: {s.on_hand} {s.base_unit} · vrednost {s.value ? formatRsd(s.value) : "nepoznata"}</p>)}
          </div>
        )}
      </div>
    </GateNote>
  );
}

export function AccountantPage() {
  const boot = useBoot();
  const [from, setFrom] = useState(boot.data?.businessDate ?? "");
  const [to, setTo] = useState(boot.data?.businessDate ?? "");
  const [on, setOn] = useState(false);
  const q = useRead<{ missing: string[]; note: string; invoices: { n: number; drafts: number }; sales: { n: number; incomplete: number } }>(on ? "accountant" : "home", on ? { from, to } : undefined);
  const pack = on ? q.data as { missing: string[]; note: string } : null;
  return (
    <GateNote boot={boot.data} perm="knjigovodja">
      <div className="space-y-3">
        <h1 className="text-3xl">Dokumentacija za knjigovođu</h1>
        <div className="flex gap-2"><Field label="Od" value={from} onChange={setFrom} type="date" /><Field label="Do" value={to} onChange={setTo} type="date" />
          <button className="btn btn-primary" type="button" onClick={() => setOn(true)}>Proveri kompletnost</button>
        </div>
        {pack && (
          <div className="card space-y-2">
            <p>{pack.note}</p>
            {pack.missing.length === 0 && <p>Nema označenih rupa u ovom preseku.</p>}
            {pack.missing.map((m) => <p key={m}>{m}</p>)}
            <p className="text-sm text-muted">Preuzmite Excel na izveštajima i originale računa iz ekrana Računi. Format može da se prilagodi onome što knjigovođa traži.</p>
          </div>
        )}
      </div>
    </GateNote>
  );
}

export function ControlPage() {
  const boot = useBoot();
  const q = useRead<{ warnings: { title: string; detail: string; tone: string }[]; audit: { at: string; action: string; entity: string; reason: string | null; user_id: string | null }[] }>("control");
  return (
    <GateNote boot={boot.data} perm="kontrola">
      <div className="space-y-3">
        <h1 className="text-3xl">Kontrola vlasnika</h1>
        <p className="text-sm text-muted">Svaka stavka pokazuje podatak na kome stoji. Manjak može biti loš normativ, neunet rashod, greška popisa ili neunešena prodaja. Aplikacija to ne proglašava krađom.</p>
        {(q.data?.warnings ?? []).map((w) => <p key={w.detail} className="card"><strong>{w.title}.</strong> {w.detail}</p>)}
        {(q.data?.warnings ?? []).length === 0 && <p className="card">Nema stavki za ovaj presek.</p>}
        <h2 className="text-xl">Istorija</h2>
        {(q.data?.audit ?? []).map((a, i) => <p key={i} className="text-sm">{a.at} · {a.action} · {a.entity} · {a.reason ?? ""}</p>)}
      </div>
    </GateNote>
  );
}

export function SettingsPage() {
  const boot = useBoot();
  const refresh = useRefresh();
  const people = useRead<{ members: { user_id: string; email: string | null; display_name: string | null; role: string }[]; requests: { user_id: string; email: string | null; name: string | null }[]; invites: { email: string; role: string }[] }>("people");
  const [endHour, setEnd] = useState(String(boot.data?.org?.business_day_end_hour ?? 4));
  const [tax, setTax] = useState(boot.data?.org?.tax_mode ?? "ukljucen");
  const [auto, setAuto] = useState(Boolean(boot.data?.org?.auto_post_invoices));
  const [locked, setLocked] = useState(boot.data?.org?.locked_through ?? "");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("admin");
  const [checks, setChecks] = useState<{ name: string; ok: boolean; detail: string }[] | null>(null);
  return (
    <GateNote boot={boot.data} perm="podesavanja">
      <div className="space-y-4">
        <h1 className="text-3xl">Podešavanja</h1>
        <form className="card space-y-3" onSubmit={async (e) => {
          e.preventDefault();
          try {
            await commit("saveSettings", { name: boot.data?.org?.name, endHour, taxMode: tax, autoPost: auto, lockedThrough: locked || null, idempotencyKey: crypto.randomUUID() });
            toast.success("Sačuvano"); refresh();
          } catch (error) { err(error); }
        }}>
          <Field label="Kraj poslovnog dana (čas)" value={endHour} onChange={setEnd} />
          <label className="field"><span>Porez u cenama</span>
            <select value={tax} onChange={(e) => setTax(e.target.value)}>
              <option value="ukljucen">Cene su sa porezom, kako su unete</option>
              <option value="dodat">Porez se vodi odvojeno ako je na stavci</option>
              <option value="iskljucen">Porez se ne obračunava ovde</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Pouzdane račune knjiži odmah posle provere zbira, jedinice i duplikata</label>
          <Field label="Zaključano zaključno sa datumom" value={locked} onChange={setLocked} type="date" />
          <button className="btn btn-primary" type="submit">Sačuvaj</button>
        </form>
        <div className="card space-y-2">
          <h2 className="text-xl">Korisnici</h2>
          <p className="text-sm text-muted">Knjigovođa podrazumevano samo gleda i preuzima. Admin radi svakodnevni unos. Vlasnik vidi sve.</p>
          {(people.data?.members ?? []).map((m) => <p key={m.user_id} className="text-sm">{m.display_name ?? m.email} · {m.role}</p>)}
          {(people.data?.requests ?? []).map((r) => (
            <p key={r.user_id} className="text-sm">{r.email} čeka
              <button className="btn ml-2" type="button" onClick={async () => {
                try { await commit("approve", { userId: r.user_id, role: "admin", idempotencyKey: crypto.randomUUID() }); refresh(); }
                catch (error) { err(error); }
              }}>Odobri kao admin</button>
            </p>
          ))}
          <Field label="Pozovi e-poštu" value={email} onChange={setEmail} />
          <label className="field"><span>Uloga</span>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="admin">Admin</option><option value="knjigovodja">Knjigovođa</option>
            </select>
          </label>
          <button className="btn" type="button" onClick={async () => {
            try { await commit("invite", { email, role, idempotencyKey: crypto.randomUUID() }); toast.success("Pozivnica je sačuvana"); refresh(); }
            catch (error) { err(error); }
          }}>Pozovi</button>
        </div>
        <div className="card space-y-2">
          <h2 className="text-xl">Probni podaci</h2>
          <p className="text-sm text-muted">Proba je označena i ne ulazi u prave izveštaje. Može da se obriše.</p>
          <button className="btn" type="button" onClick={async () => { try { await commit("seedDemo", { idempotencyKey: "demo-seed" }); toast.success("Probni dan je učitan"); refresh(); } catch (error) { err(error); } }}>Učitaj probni dan</button>
          <button className="btn" type="button" onClick={async () => { try { await commit("wipeDemo", { idempotencyKey: crypto.randomUUID() }); toast.success("Proba je obrisana"); refresh(); } catch (error) { err(error); } }}>Obriši probu</button>
        </div>
        <div className="card space-y-2">
          <h2 className="text-xl">Provera obračuna</h2>
          <p className="text-sm text-muted">Pokreće kontrolni primer u prolaznoj transakciji. Vaši podaci se ne menjaju.</p>
          <button className="btn btn-primary" type="button" onClick={async () => {
            try { setChecks(await commit("proof", { idempotencyKey: crypto.randomUUID() }) as { name: string; ok: boolean; detail: string }[]); }
            catch (error) { err(error); }
          }}>Pokreni proveru</button>
          {checks?.map((c) => <p key={c.name} className={c.ok ? "text-ok" : "text-bad"}>{c.ok ? "U redu" : "Nije"} · {c.name}. {c.detail}</p>)}
        </div>
        <div className="card space-y-2 text-sm">
          <h2 className="text-xl">Prvi dan</h2>
          <p>1. Sačuvajte objekat i kraj poslovnog dana (podrazumevano 4 ujutru).</p>
          <p>2. Unesite artikle, pakovanja (karton nije komad) i početno stanje sa datumom.</p>
          <p>3. Jednom unesite recepture. Burger od 150 g mesa, 1 zemičke, 20 g sira, 15 g sosa i 1 ambalaže ostaje sačuvan.</p>
          <p>4. Otvorite smenu sa početnim novcem. Fotografišite ili unesite račun i knjižite ga. Arhivski stari račun ne dira zalihu.</p>
          <p>5. Unesite prodaju. Ako kasa ne šalje dodatke, utrošak je po osnovnom normativu i to piše uz stavku.</p>
          <p>6. Rashod, popis i zatvaranje kase rade se posebno. Povraćaj novca ne vraća sirovine.</p>
          <p>7. Izveštaj i paket za knjigovođu preuzmite za izabrani period.</p>
        </div>
      </div>
    </GateNote>
  );
}

export function GrokPage() {
  const boot = useBoot();
  const refresh = useRefresh();
  const tokens = useRead<{ tokens: { id: string; name: string; scopes: { upis?: boolean; promet?: boolean; zalihe?: boolean; dokumenti?: boolean } | null; created_at: string; revoked_at: string | null }[] }>("tokens");
  const [name, setName] = useState("Rad aplikacije");
  const [promet, setP] = useState(false);
  const [zalihe, setZ] = useState(false);
  const [dokumenti, setD] = useState(false);
  const [upozorenja, setU] = useState(false);
  const [upis, setUpis] = useState(false);
  const [token, setToken] = useState("");
  return (
    <GateNote boot={boot.data} perm="podesavanja">
      <div className="card space-y-3 text-sm">
        <h1 className="text-3xl">Povezivanje</h1>
        <p>Grok nije ugrađen kao čet. Ovde pravite ključ. Bota hranite spiskom proizvoda, računima nabavke, rashodom i izbrojanim novcem. On to šalje ovamo i knjiži. Podrazumevano ništa ne sme da menja.</p>
        <p>Prepoznavanje fotografije računa {boot.data?.ai ? "jeste povezano i troši kvotu samo kad pritisnete dugme." : "nije povezano jer na serveru nema ključa. Unos ostaje ručan ili preko bota koji već ima pročitane stavke."}</p>
        <p>Ključ važi samo na adresi na kojoj je napravljen. Pregled u ovom četu i objavljena aplikacija nisu ista baza. Bot zove https://acre-island-glow-stone.grok.me, pa ključ napravite tamo, na ovoj stranici, sa uključenim Upisom.</p>
        <p><strong>Upis.</strong> POST /api/dpu/v1/radnja</p>
        <p className="break-all rounded-xl bg-paper p-3">Authorization: Bearer vaš-ključ</p>
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl bg-paper p-3 text-xs">{`{
  "kljuc": "2026-09-30-paket",
  "artikli": [{ "naziv": "Meso", "jedinica": "g" }],
  "proizvodi": [{ "naziv": "Burger", "cena": "450" }],
  "recepture": [{ "proizvod": "Burger", "stavke": [{ "artikal": "Meso", "kolicina": "150", "jedinica": "g" }] }],
  "racuni": [{ "dobavljac": "Mesara", "broj": "12", "datum": "2026-09-30", "ukupno": "3000", "stavke": [{ "artikal": "Meso", "kolicina": "2", "jedinica": "kg", "iznos": "3000" }] }],
  "rashodi": [{ "artikal": "Meso", "kolicina": "200", "jedinica": "g", "razlog": "Prosipanje" }],
  "zatvaranje": { "izbrojano": "12500.00" }
}`}</pre>
        <ul className="list-disc space-y-1 pl-5">
          <li>Isti ključ ponovo ne pravi dupli račun, rashod ni prodaju. Nova poruka dobija novi ključ.</li>
          <li>Ako je rashod veći od zalihe, nije knjižen dok se izričito ne pošalje prekoZalihe. Nula se ne upisuje umesto nepoznate cene.</li>
          <li>Ako podatak nije naveden, nije nula, komad, gram ni keš. Nejasan račun ostaje na proveri i ne dira zalihu.</li>
          <li>Polog ne smanjuje promet. Kartica nije keš. Povraćaj novca ne vraća zalihu osim ako to izričito tražite.</li>
          <li>Zatvaranje poredi izbrojan keš sa očekivanim. Razlika nije dobit. Plate, kirija, energija, amortizacija i porez nisu u marži.</li>
          <li>Proknjižen dokument se ne briše. Ispravka je storno uz razlog. Ključ radi u ime onoga ko ga je napravio i to ostaje u istoriji.</li>
        </ul>
        <Field label="Naziv ključa" value={name} onChange={setName} />
        <label className="flex gap-2"><input type="checkbox" checked={promet} onChange={(e) => setP(e.target.checked)} /> Promet, čitanje</label>
        <label className="flex gap-2"><input type="checkbox" checked={zalihe} onChange={(e) => setZ(e.target.checked)} /> Zalihe, čitanje</label>
        <label className="flex gap-2"><input type="checkbox" checked={dokumenti} onChange={(e) => setD(e.target.checked)} /> Dokumenti, čitanje</label>
        <label className="flex gap-2"><input type="checkbox" checked={upozorenja} onChange={(e) => setU(e.target.checked)} /> Napomena o upozorenjima</label>
        <label className="flex gap-2"><input type="checkbox" checked={upis} onChange={(e) => setUpis(e.target.checked)} /> Upis: spisak, računi nabavke, rashod, prodaja i zatvaranje dana</label>
        <button className="btn btn-primary" type="button" onClick={async () => {
          try {
            const res = await commit("createToken", { name, promet, zalihe, dokumenti, upozorenja, upis, idempotencyKey: crypto.randomUUID() }) as { token: string };
            setToken(res.token); refresh();
          } catch (error) { err(error); }
        }}>Napravi ključ</button>
        {token && <p className="break-all">Ključ se vidi samo sada. Pošaljite ga u jednom redu: {token}</p>}
        <div className="space-y-2">
          {(tokens.data?.tokens ?? []).filter((row) => !row.revoked_at).map((row) => (
            <div key={row.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-paper px-3 py-2">
              <span>{row.name}{row.scopes?.upis ? " · upis uključen" : " · samo čitanje"}</span>
              <button className="btn" type="button" onClick={async () => {
                  try {
                    await commit("revokeToken", { id: row.id, idempotencyKey: crypto.randomUUID() });
                    refresh();
                  } catch (error) { err(error); }
                }}>Povuci</button>
            </div>
          ))}
        </div>
      </div>
    </GateNote>
  );
}
