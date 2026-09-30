import { useState } from "react";
import { toast } from "sonner";
import { formatRsd, m, mStr, q, c, valuePara } from "@/lib/h/money";
import { commit, useBoot, useRead, useRefresh } from "./data";
import { GateNote } from "./shell";

function err(e: unknown) {
  toast.error(e instanceof Error ? e.message : "Greška");
}
function Field(props: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return <label className="field"><span>{props.label}</span><input type={props.type ?? "text"} value={props.value} onChange={(e) => props.onChange(e.target.value)} /></label>;
}

type Art = { id: string; name: string; base_unit: string };
type Prod = { id: string; name: string; code?: string | null; pos_code?: string | null; sell_price: string; consume_mode: string; is_demo: boolean; output_article_id: string | null };

export function RecipesPage() {
  const boot = useBoot();
  const refresh = useRefresh();
  const arts = useRead<{ articles: Art[] }>("articles");
  const products = useRead<{ products: Prod[]; versions: { id: string; product_id: string; valid_from: string }[]; lines: { version_id: string; article: string; qty: string; role: string; base_unit: string; addon_code: string | null }[] }>("products");
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [saleUnit, setSaleUnit] = useState("");
  const [mode, setMode] = useState("recept");
  const [output, setOutput] = useState("");
  const [productId, setProduct] = useState("");
  const [articleId, setArt] = useState("");
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState("");
  const [role, setRole] = useState("sastojak");
  const [addon, setAddon] = useState("");
  const [yieldRatio, setYield] = useState("");
  const [lines, setLines] = useState<{ articleId: string; qty: string; unit: string; role: string; addonCode?: string; yieldRatio?: string }[]>([]);
  return (
    <GateNote boot={boot.data} perm="recepture">
      <div className="space-y-4">
        <h1 className="text-3xl">Proizvodi i recepture</h1>
        <p className="text-sm text-muted">Normativ ostaje dok ne snimite novu verziju. Stari obračuni se ne diraju. Prinos posle pečenja nije dodatni rashod.</p>
        <form className="card grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
          e.preventDefault();
          try {
            if (!price.trim()) throw new Error("Unesite prodajnu cenu. Nula nije upisana.");
            if (!saleUnit.trim()) throw new Error("Unesite jedinicu prodaje. Komad nije pretpostavljen.");
            const res = await commit("saveProduct", { name, sellPrice: price, saleUnit, consumeMode: mode, outputArticleId: output || null, idempotencyKey: crypto.randomUUID() }) as { id: string };
            setProduct(res.id); toast.success("Proizvod je sačuvan"); refresh();
          } catch (error) { err(error); }
        }}>
          <Field label="Naziv" value={name} onChange={setName} />
          <Field label="Prodajna cena" value={price} onChange={setPrice} />
          <Field label="Jedinica prodaje (kom, kg…)" value={saleUnit} onChange={setSaleUnit} />
          <label className="field"><span>Način</span>
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="recept">Skida sastojke pri prodaji</option>
              <option value="zaliha">Skida već proizvedene porcije</option>
            </select>
          </label>
          <label className="field"><span>Artikal porcija (za pripremu unapred)</span>
            <select value={output} onChange={(e) => setOutput(e.target.value)}><option value="">—</option>{(arts.data?.articles ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
          </label>
          <button className="btn btn-primary" type="submit">Sačuvaj proizvod</button>
        </form>
        <div className="card space-y-3">
          <label className="field"><span>Receptura za</span>
            <select value={productId} onChange={(e) => setProduct(e.target.value)}>
              <option value="">Izaberite</option>
              {(products.data?.products ?? []).map((p) => <option key={p.id} value={p.id}>{p.name} · {formatRsd(p.sell_price)}</option>)}
            </select>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="field"><span>Sastojak</span>
              <select value={articleId} onChange={(e) => {
                const id = e.target.value;
                setArt(id);
                const art = arts.data?.articles.find((a) => a.id === id);
                if (art) setUnit(art.base_unit);
              }}>
                <option value="">Izaberite</option>
                {(arts.data?.articles ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            <Field label="Količina po komadu" value={qty} onChange={setQty} />
            <Field label="Jedinica" value={unit} onChange={setUnit} />
            <label className="field"><span>Uloga</span>
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="sastojak">Sastojak</option>
                <option value="dodatak">Dodatak</option>
                <option value="ambalaza">Ambalaža</option>
                <option value="ambalaza_lokal">Ambalaža lokal</option>
                <option value="ambalaza_preuzimanje">Preuzimanje</option>
                <option value="ambalaza_dostava">Dostava</option>
              </select>
            </label>
            <Field label="Šifra dodatka (npr. sir)" value={addon} onChange={setAddon} />
            <Field label="Prinos (info, npr. 0.8)" value={yieldRatio} onChange={setYield} />
          </div>
          <button className="btn" type="button" onClick={() => setLines([...lines, { articleId, qty, unit, role, addonCode: addon || undefined, yieldRatio: yieldRatio || undefined }])}>Dodaj u verziju</button>
          <ul className="text-sm">{lines.map((l, i) => <li key={i}>{l.role}: {l.qty} {l.unit}</li>)}</ul>
          <button className="btn btn-primary" type="button" onClick={async () => {
            try {
              await commit("saveRecipe", { productId, lines, idempotencyKey: crypto.randomUUID() });
              setLines([]); toast.success("Nova verzija recepture važi od sada"); refresh();
            } catch (error) { err(error); }
          }}>Sačuvaj novu verziju</button>
        </div>
        {(products.data?.products ?? []).map((p) => {
          const version = products.data?.versions.find((v) => v.product_id === p.id);
          const rows = products.data?.lines.filter((l) => l.version_id === version?.id) ?? [];
          return (
            <div key={p.id} className="card">
              <p className="font-semibold">{p.name} {p.is_demo && <span className="text-copper">proba</span>}</p>
              <p className="text-sm text-muted">{p.consume_mode === "zaliha" ? "Skida gotove porcije" : version ? `Normativ od ${version.valid_from}` : "Nema recepture — utrošak je nepoznat"}</p>
              {rows.map((l) => <p key={l.article + l.role} className="text-sm">{l.article}: {l.qty} {l.base_unit} · {l.role} {l.addon_code ?? ""}</p>)}
            </div>
          );
        })}
      </div>
    </GateNote>
  );
}

export function ProductionPage() {
  const boot = useBoot();
  const refresh = useRefresh();
  const arts = useRead<{ articles: Art[] }>("articles");
  const [outputArticleId, setOut] = useState("");
  const [planned, setPlanned] = useState("");
  const [actual, setActual] = useState("");
  const [articleId, setArt] = useState("");
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState("");
  const [lines, setLines] = useState<{ articleId: string; qty: string; unit: string }[]>([]);
  return (
    <GateNote boot={boot.data} perm="proizvodnja">
      <div className="card space-y-3">
        <h1 className="text-3xl">Proizvodnja unapred</h1>
        <p className="text-sm text-muted">Sirovine se skidaju sada. Kasnija prodaja skida samo porcije, ne sirovine ponovo. Razlika plana i prinosa ostaje u ceni porcije.</p>
        <label className="field"><span>Šta nastaje</span>
          <select value={outputArticleId} onChange={(e) => setOut(e.target.value)}>
            <option value="">Izaberite</option>
            {(arts.data?.articles ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Planirano" value={planned} onChange={setPlanned} />
          <Field label="Stvarno dobijeno" value={actual} onChange={setActual} />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="field"><span>Sirovina</span><select value={articleId} onChange={(e) => {
            const id = e.target.value;
            setArt(id);
            const art = arts.data?.articles.find((a) => a.id === id);
            if (art) setUnit(art.base_unit);
          }}><option value="">Izaberite</option>{(arts.data?.articles ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <Field label="Utrošeno" value={qty} onChange={setQty} />
          <Field label="Jedinica" value={unit} onChange={setUnit} />
        </div>
        <button className="btn" type="button" onClick={() => setLines([...lines, { articleId, qty, unit }])}>Dodaj sirovinu</button>
        <button className="btn btn-primary" type="button" onClick={async () => {
          try {
            const res = await commit("postProduction", { outputArticleId, plannedQty: planned, actualQty: actual, lines, idempotencyKey: crypto.randomUUID() }) as { warnings: string[] };
            res.warnings?.forEach((w) => toast.message(w));
            toast.success("Proizvodnja je proknjižena"); refresh();
          } catch (error) { err(error); }
        }}>Knjiži proizvodnju</button>
      </div>
    </GateNote>
  );
}

export function SalesPage() {
  const boot = useBoot();
  const refresh = useRefresh();
  const products = useRead<{ products: Prod[] }>("products");
  const sales = useRead<{ sales: { id: string; business_date: string; net: string; status: string; tender_cash: string; tender_card: string; cost_value: string | null; cost_complete: boolean; is_refund: boolean; basic_normative: boolean; source: string }[] }>("sales");
  const [productId, setProduct] = useState("");
  const [qty, setQty] = useState("");
  const [price, setPrice] = useState("");
  const [cash, setCash] = useState("");
  const [card, setCard] = useState("");
  const [channel, setChannel] = useState("lokal");
  const [addon, setAddon] = useState("");
  const [when, setWhen] = useState("");
  const [sumCash, setSumCash] = useState("");
  const [sumCard, setSumCard] = useState("");
  return (
    <GateNote boot={boot.data} perm="prodaja">
      <div className="space-y-4">
        <h1 className="text-3xl">Prodaja</h1>
        <form className="card grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
          e.preventDefault();
          const product = products.data?.products.find((p) => p.id === productId);
          if (!product) { toast.error("Izaberite proizvod. Padajući meni nije izabran dok ga ne dodirnete."); return; }
          if (!qty.trim()) { toast.error("Unesite količinu. Jedan komad nije pretpostavljen."); return; }
          const unitPrice = price.trim() || (m(product.sell_price) > 0n ? product.sell_price : "");
          if (!unitPrice) { toast.error("Nema naplaćene cene. Nula nije upisana."); return; }
          if (!cash.trim() || !card.trim()) { toast.error("Unesite gotovinu i karticu. Ako je jedna nula, upišite 0."); return; }
          let lineNet = "";
          try { lineNet = mStr(valuePara(q(qty), c(unitPrice))); } catch (error) { err(error); return; }
          if (m(cash) + m(card) !== m(lineNet)) { toast.error("Gotovina i kartica se ne slažu sa iznosom. Nije knjiženo."); return; }
          try {
            const res = await commit("postSale", {
              channel, tenderCash: cash, tenderCard: card, occurredAt: when || null, idempotencyKey: crypto.randomUUID(), source: "rucno",
              lines: [{ productId, name: product.name, qty, unitPrice, lineNet, addons: addon ? [addon] : [], omitted: [] }],
            }) as { warnings?: string[]; duplicate?: boolean };
            if (res.duplicate) toast.message("Ta prodaja je već knjižena.");
            res.warnings?.forEach((w) => toast.message(w));
            toast.success("Prodaja je knjižena"); refresh();
          } catch (error) { err(error); }
        }}>
          <label className="field"><span>Proizvod</span>
            <select value={productId} onChange={(e) => {
              const id = e.target.value;
              setProduct(id);
              const picked = products.data?.products.find((p) => p.id === id);
              setPrice(picked && m(picked.sell_price) > 0n ? picked.sell_price : "");
            }}>
              <option value="">Izaberite</option>
              {(products.data?.products ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <Field label="Količina" value={qty} onChange={setQty} />
          <Field label="Cena (prazno = sačuvana cena proizvoda, ako postoji)" value={price} onChange={setPrice} />
          <Field label="Gotovina" value={cash} onChange={setCash} />
          <Field label="Kartica" value={card} onChange={setCard} />
          <label className="field"><span>Kanal</span>
            <select value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="lokal">Lokal</option><option value="preuzimanje">Preuzimanje</option><option value="dostava">Dostava</option>
            </select>
          </label>
          <Field label="Dodatak (šifra, prazno = osnovni normativ)" value={addon} onChange={setAddon} />
          <Field label="Vreme (prazno = sada)" value={when} onChange={setWhen} type="datetime-local" />
          <button className="btn btn-primary sm:col-span-2" type="submit">Knjiži prodaju</button>
        </form>
        <form className="card space-y-2" onSubmit={async (e) => {
          e.preventDefault();
          if (!sumCash.trim() || !sumCard.trim()) { toast.error("Unesite gotovinu i karticu. Ceo promet nije upisan kao keš."); return; }
          try {
            const summaryNet = mStr(m(sumCash) + m(sumCard));
            const res = await commit("postSale", { isSummary: true, summaryNet, tenderCash: sumCash, tenderCard: sumCard, lines: [], idempotencyKey: crypto.randomUUID(), source: "zbir" }) as { warnings?: string[]; reconcileOnly?: boolean };
            toast.success(res.reconcileOnly ? "Zbir je samo za usaglašavanje" : "Zbirni promet je sačuvan, bez utroška namirnica");
            res.warnings?.forEach((w) => toast.message(w)); refresh();
          } catch (error) { err(error); }
        }}>
          <h2 className="text-xl">Samo ukupan promet</h2>
          <p className="text-sm text-muted">Bez stavki nema utroška namirnica. Keš i kartica se unose posebno.</p>
          <Field label="Gotovina" value={sumCash} onChange={setSumCash} />
          <Field label="Kartica" value={sumCard} onChange={setSumCard} />
          <button className="btn" type="submit">Sačuvaj zbir</button>
        </form>
        <label className="card block text-sm">Uvoz CSV (tačka-zarez ili zarez): datum;vreme;sifra;naziv;kolicina;iznos;placanje
          <input className="mt-2 block" type="file" accept=".csv,text/csv,.txt" onChange={async (e) => {
            const file = e.target.files?.[0]; if (!file) return;
            const text = await file.text();
            const rows = text.split(/\r?\n/).slice(1).filter(Boolean);
            let posted = 0;
            const skipped: string[] = [];
            for (const row of rows) {
              const [date, time, code, name, qtyCell, amount, pay] = row.split(/[;,]/).map((cell) => cell.trim());
              const label = name || code || "red";
              if (!qtyCell || !amount || !pay) { skipped.push(`${label}: nema količine, iznosa ili načina plaćanja`); continue; }
              const payKey = pay.toLowerCase();
              const cashPay = payKey === "kes" || payKey === "gotovina";
              const cardPay = payKey === "kartica";
              if (!cashPay && !cardPay) { skipped.push(`${label}: plaćanje „${pay}“ nije keš ni kartica`); continue; }
              const product = products.data?.products.find((p) => (code && (p.code === code || p.pos_code === code)) || (name && p.name === name));
              if (!product) { skipped.push(`${label}: šifra nije povezana, red nije knjižen`); continue; }
              try {
                await commit("postSale", {
                  source: "csv",
                  occurredAt: date && time ? `${date}T${time}` : null,
                  tenderCash: cashPay ? amount : "0",
                  tenderCard: cardPay ? amount : "0",
                  idempotencyKey: `csv-${file.name}-${date}-${code}-${qtyCell}-${amount}`,
                  lines: [{ productId: product.id, name: product.name, qty: qtyCell, unitPrice: null, lineNet: amount }],
                });
                posted += 1;
              } catch (error) { err(error); break; }
            }
            if (skipped.length) toast.message(skipped.slice(0, 4).join(" · "));
            toast.success(`Knjiženo redova: ${posted}. Preskočeno: ${skipped.length}. Količina i iznos nisu dopunjeni. CSV nema kanal, posebna ambalaža nije uračunata.`);
            refresh();
          }} />
        </label>
        {(sales.data?.sales ?? []).map((s) => (
          <div key={s.id} className="card text-sm">
            <p>{s.business_date} · {formatRsd(s.net)} · {s.status} {s.is_refund ? "· povraćaj" : ""}</p>
            <p className="text-muted">Keš {formatRsd(s.tender_cash)} · kartica {formatRsd(s.tender_card)} · trošak {s.cost_complete ? formatRsd(s.cost_value) : "nepotpun"} {s.basic_normative ? "· osnovni normativ" : ""}</p>
            {s.status === "proknjizen" && !s.is_refund && <SaleFix id={s.id} net={s.net} onDone={refresh} />}
          </div>
        ))}
      </div>
    </GateNote>
  );
}

function SaleFix({ id, net, onDone }: { id: string; net: string; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState(net);
  const [method, setMethod] = useState("");
  return (
    <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_8rem_8rem_auto_auto]">
      <input className="min-h-11 rounded-xl border border-line px-2" aria-label="Razlog" placeholder="Razlog" value={reason} onChange={(e) => setReason(e.target.value)} />
      <input className="min-h-11 rounded-xl border border-line px-2" aria-label="Iznos povraćaja" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <select className="min-h-11 rounded-xl border border-line px-2" aria-label="Način povraćaja" value={method} onChange={(e) => setMethod(e.target.value)}>
        <option value="">Način</option>
        <option value="kes">Keš</option>
        <option value="kartica">Kartica</option>
        <option value="prenos">Prenos</option>
      </select>
      <button className="btn" type="button" onClick={async () => {
        if (!reason.trim()) { toast.error("Storno traži razlog."); return; }
        try {
          await commit("voidSale", { saleId: id, reason, idempotencyKey: crypto.randomUUID() });
          toast.success("Prodaja je stornirana. Nije obrisana."); onDone();
        } catch (error) { err(error); }
      }}>Storniraj</button>
      <button className="btn" type="button" onClick={async () => {
        if (!method) { toast.error("Izaberite način povraćaja. Keš nije pretpostavljen."); return; }
        if (!reason.trim()) { toast.error("Povraćaj traži razlog."); return; }
        try {
          await commit("postRefund", { saleId: id, amount, method, restoresStock: false, reason, idempotencyKey: crypto.randomUUID() });
          toast.success("Novac je vraćen. Sirovine nisu vraćene na zalihu."); onDone();
        } catch (error) { err(error); }
      }}>Povraćaj</button>
    </div>
  );
}

export function ShiftPage() {
  const boot = useBoot();
  const refresh = useRefresh();
  const q = useRead<{ open: { id: string } | null; expected: string | null; history: { id: string; business_date: string; status: string; expected_cash: string | null; counted_cash: string | null; variance: string | null; variance_note: string | null; corrected: boolean }[]; events: { kind: string; amount: string; note: string | null }[] }>("shift");
  const [opening, setOpening] = useState(boot.data?.org?.initial_cash ?? "");
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState("");
  const [kind, setKind] = useState("polog");
  return (
    <GateNote boot={boot.data} perm="smene">
      <div className="space-y-4">
        <h1 className="text-3xl">Smene i kasa</h1>
        <p className="text-sm text-muted">Očekivano = početak + gotovina + ulazi − povraćaji − isplate − polog. Kartica ne ulazi u kasu. Polog ne umanjuje promet.</p>
        {!q.data?.open && (
          <form className="card space-y-2" onSubmit={async (e) => {
            e.preventDefault();
            try { await commit("openShift", { openingCash: opening, idempotencyKey: crypto.randomUUID() }); toast.success("Smena je otvorena"); refresh(); }
            catch (error) { err(error); }
          }}>
            <Field label="Početni novac" value={opening} onChange={setOpening} />
            <button className="btn btn-primary" type="submit">Otvori smenu</button>
          </form>
        )}
        {q.data?.open && (
          <div className="card space-y-3">
            <p className="text-2xl num">Očekivano {formatRsd(q.data.expected)}</p>
            {(q.data.events ?? []).map((ev, i) => <p key={i} className="text-sm">{ev.kind}: {formatRsd(ev.amount)} {ev.note ?? ""}</p>)}
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="field"><span>Vrsta</span>
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="polog">Polog</option><option value="isplata">Isplata iz kase</option><option value="ulaz">Gotovinski ulaz</option>
                </select>
              </label>
              <Field label="Iznos" value={amount} onChange={setAmount} />
              <button className="btn" type="button" onClick={async () => {
                try { await commit("addCash", { kind, amount, idempotencyKey: crypto.randomUUID() }); toast.success("Kasa je ažurirana"); refresh(); }
                catch (error) { err(error); }
              }}>Unesi</button>
            </div>
            <Field label="Prebrojano" value={counted} onChange={setCounted} />
            <Field label="Objašnjenje razlike" value={note} onChange={setNote} />
            <button className="btn btn-primary" type="button" onClick={async () => {
              try {
                const res = await commit("closeShift", { counted, note, idempotencyKey: crypto.randomUUID() }) as { variance: string };
                toast.success(`Smena je zatvorena. Razlika ${formatRsd(res.variance)}`); refresh();
              } catch (error) { err(error); }
            }}>Zatvori smenu</button>
          </div>
        )}
        {(q.data?.history ?? []).map((s) => (
          <p key={s.id} className="card text-sm">{s.business_date} · {s.status} · očekivano {formatRsd(s.expected_cash)} · prebrojano {formatRsd(s.counted_cash)} · razlika {formatRsd(s.variance)} {s.corrected ? "· korigovano" : ""} {s.variance_note ?? ""}</p>
        ))}
      </div>
    </GateNote>
  );
}

export function WastePage() {
  const boot = useBoot();
  const refresh = useRefresh();
  const arts = useRead<{ articles: Art[] }>("articles");
  const list = useRead<{ wastes: { id: string; reason: string; qty: string; unit_name: string; value: string | null; article: string | null; business_date: string; cost_complete: boolean }[] }>("wastes");
  const [articleId, setArt] = useState("");
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState("");
  const [reason, setReason] = useState("kvarenje");
  const [note, setNote] = useState("");
  const [allow, setAllow] = useState(false);
  return (
    <GateNote boot={boot.data} perm="rashod">
      <div className="space-y-4">
        <h1 className="text-3xl">Rashod</h1>
        <p className="text-sm text-muted">Rashod nije isto što i utrošak prodaje niti popisni manjak. Gubitak koji je već u normativu ne unosite ovde.</p>
        <form className="card grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
          e.preventDefault();
          try {
            const res = await commit("postWaste", { articleId, qty, unit, reason, note, allowOver: allow, idempotencyKey: crypto.randomUUID() }) as { value: string | null; warnings: string[] };
            toast.success(res.value ? `Rashodovano, vrednost ${formatRsd(res.value)}` : "Rashod je knjižen, vrednost je nepoznata");
            res.warnings?.forEach((w) => toast.message(w)); refresh();
          } catch (error) { err(error); }
        }}>
          <label className="field"><span>Artikal</span>
            <select value={articleId} onChange={(e) => {
              const id = e.target.value;
              setArt(id);
              const art = arts.data?.articles.find((a) => a.id === id);
              if (art) setUnit(art.base_unit);
            }}>
              <option value="">Izaberite</option>
              {(arts.data?.articles ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <Field label="Količina" value={qty} onChange={setQty} />
          <Field label="Jedinica" value={unit} onChange={setUnit} />
          <label className="field"><span>Razlog</span>
            <select value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="kvarenje">Kvarenje</option><option value="istekao_rok">Istekao rok</option><option value="prosipanje">Prosipanje</option>
              <option value="greska">Greška u pripremi</option><option value="ostecenje">Oštećenje</option>
              <option value="obrok">Obrok zaposlenih</option><option value="degustacija">Degustacija</option><option value="poklon">Poklon</option>
            </select>
          </label>
          <Field label="Napomena" value={note} onChange={setNote} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={allow} onChange={(e) => setAllow(e.target.checked)} /> Količina je veća od zalihe, ipak knjiži</label>
          <button className="btn btn-copper sm:col-span-2" type="submit">Rashoduj</button>
        </form>
        {(list.data?.wastes ?? []).map((w) => (
          <p key={w.id} className="card text-sm">{w.business_date} · {w.article} · {w.qty} {w.unit_name} · {w.reason} · {w.cost_complete ? formatRsd(w.value) : "vrednost nepoznata"}</p>
        ))}
      </div>
    </GateNote>
  );
}

export function CountPage() {
  const boot = useBoot();
  const refresh = useRefresh();
  const [countId, setCount] = useState("");
  const lines = useRead<{ lines: { article_id: string; name: string; base_unit: string; expected_qty: string; counted_qty: string | null; diff_qty: string | null; value: string | null }[] }>(countId ? "count" : "counts", countId ? { id: countId } : undefined);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const items = (lines.data as { lines?: { article_id: string; name: string; base_unit: string; expected_qty: string; counted_qty: string | null; diff_qty: string | null; value: string | null }[] })?.lines ?? [];
  const readyToPost = items.length > 0 && items.every((line) => {
    const value = draft[line.article_id] ?? line.counted_qty ?? "";
    return value !== "" && (draft[line.article_id] === undefined || draft[line.article_id] === line.counted_qty || saved[line.article_id] === true);
  });
  return (
    <GateNote boot={boot.data} perm="popis">
      <div className="space-y-4">
        <h1 className="text-3xl">Popis</h1>
        <p className="text-sm text-muted">Očekivano stanje je presek na početku popisa. Izbroj artikle redom i odmah sačuvaj svaku stavku. Promene zalihe pre njenog čuvanja ulaze u osnovu poređenja; prodaje i rashodi posle čuvanja ostaju uračunati u završnu zalihu.</p>
        {!countId && <button className="btn btn-primary" type="button" onClick={async () => {
          try { const res = await commit("startCount", { scope: "sve", idempotencyKey: crypto.randomUUID() }) as { id: string }; setCount(res.id); refresh(); }
          catch (error) { err(error); }
        }}>Započni popis svega</button>}
        {countId && (
          <div className="space-y-2">
            {items.map((line) => {
              const value = draft[line.article_id] ?? line.counted_qty ?? "";
              const isSaved = saved[line.article_id] === true || (draft[line.article_id] === undefined && line.counted_qty !== null);
              return (
                <div key={line.article_id} className="card grid gap-2 sm:grid-cols-[1fr_8rem_auto]">
                  <p>{line.name}<br /><span className="text-sm text-muted">presek na početku: {line.expected_qty} {line.base_unit}{line.counted_qty !== null ? <><br />sačuvano kao prebrojano: {line.counted_qty} {line.base_unit}</> : null}</span></p>
                  <input
                    className="min-h-11 rounded-xl border border-line px-2"
                    type="number"
                    min="0"
                    step="any"
                    placeholder="Prebrojano"
                    aria-label={`Prebrojana količina: ${line.name}`}
                    value={value}
                    onChange={(event) => {
                      setDraft({ ...draft, [line.article_id]: event.target.value });
                      setSaved({ ...saved, [line.article_id]: false });
                    }}
                  />
                  <button className="btn" type="button" disabled={value.trim() === "" || isSaved} onClick={async () => {
                    try {
                      await commit("setCountQty", { countId, articleId: line.article_id, counted: value, idempotencyKey: crypto.randomUUID() });
                      setSaved({ ...saved, [line.article_id]: true });
                      toast.success(`Sačuvano: ${line.name}`);
                      refresh();
                    } catch (error) { err(error); }
                  }}>{isSaved ? "Sačuvano" : "Sačuvaj stavku"}</button>
                </div>
              );
            })}
            <button className="btn btn-primary" type="button" disabled={!readyToPost} onClick={async () => {
              try {
                await commit("postCount", { countId, idempotencyKey: `post-${countId}` });
                toast.success("Popis je proknjižen"); refresh();
              } catch (error) { err(error); }
            }}>Knjiži razlike</button>
            {!readyToPost && <p className="text-sm text-muted">Pre knjiženja sačuvaj prebrojanu količinu za svaku stavku.</p>}
          </div>
        )}
      </div>
    </GateNote>
  );
}
