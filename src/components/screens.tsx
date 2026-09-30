import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { formatQty, formatRsd } from "@/lib/h/money";
import { recognizeReceipt } from "@/lib/h/api";
import { can, commit, useBoot, useRead, useRefresh, type Boot } from "./data";
import { GateNote } from "./shell";

function err(e: unknown) {
  toast.error(e instanceof Error ? e.message : "Greška");
}

function Field(props: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input type={props.type ?? "text"} value={props.value} onChange={(e) => props.onChange(e.target.value)} />
    </label>
  );
}

export function HomePage() {
  const boot = useBoot();
  if (boot.data?.mode === "setup") return <Setup />;
  if (boot.data?.mode === "wait") {
    return (
      <div className="card space-y-2">
        <h1 className="text-3xl">Čeka se odobrenje</h1>
        <p>Nalog {boot.data.email ?? ""} još nema ulogu. Vlasnik vas dodeljuje u podešavanjima.</p>
      </div>
    );
  }
  return <Dash boot={boot.data} />;
}

function Setup() {
  const refresh = useRefresh();
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [endHour, setEndHour] = useState("4");
  const [cash, setCash] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  return (
    <form
      className="card space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await commit("setup", { name, city, endHour, initialCash: cash, openingDate: date, idempotencyKey: crypto.randomUUID() });
          toast.success("Objekat je sačuvan");
          refresh();
        } catch (error) { err(error); }
      }}
    >
      <p className="text-sm text-muted">Prvo podešavanje</p>
      <h1 className="text-3xl text-forest">Dnevni promet</h1>
      <p className="text-muted">Valuta je RSD, zona Europe/Belgrade. Posle ponoći, do časa koji unesete, promet ide na prethodni poslovni dan.</p>
      <Field label="Naziv objekta" value={name} onChange={setName} />
      <Field label="Grad" value={city} onChange={setCity} />
      <Field label="Poslovni dan traje do (čas)" value={endHour} onChange={setEndHour} />
      <Field label="Početni novac u kasi (RSD)" value={cash} onChange={setCash} />
      <Field label="Datum početka praćenja" value={date} onChange={setDate} type="date" />
      <button className="btn btn-primary" type="submit">Sačuvaj objekat</button>
    </form>
  );
}

function Dash({ boot }: { boot?: Boot }) {
  const day = boot?.businessDate ?? "";
  const q = useRead<{
    day: string;
    snap: { revenue: string; costKnown: string | null; incomplete: number; waste: string | null };
    low: { name: string; on_hand: string; base_unit: string }[];
    pending: number;
    warnings: { title: string; detail: string }[];
  }>("home", { day });
  const s = q.data;
  return (
    <div className="space-y-4">
      <h1 className="text-3xl text-forest">Današnji sto</h1>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="card"><p className="text-sm text-muted">Promet</p><p className="num text-2xl">{formatRsd(s?.snap.revenue)}</p></div>
        <div className="card">
          <p className="text-sm text-muted">Trošak prodatih sastojaka</p>
          <p className="num text-2xl">{s?.snap.incomplete ? "nepotpun obračun" : formatRsd(s?.snap.costKnown)}</p>
          <p className="text-xs text-muted">Nije čista zarada. Nisu uračunate plate, kirija i energija osim ako su uneti kao trošak.</p>
        </div>
        <div className="card"><p className="text-sm text-muted">Računi na čekanju</p><p className="num text-2xl">{s?.pending ?? "…"}</p></div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Link className="btn btn-primary" to="/racuni">Fotografiši račun</Link>
        <Link className="btn" to="/prodaja">Unesi prodaju</Link>
        <Link className="btn" to="/rashod">Rashoduj</Link>
        <Link className="btn" to="/popis">Popis</Link>
        <Link className="btn" to="/smene">Zatvori smenu</Link>
        <Link className="btn" to="/izvestaji">Dnevni izveštaj</Link>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="card space-y-2">
          <h2 className="text-xl">Upozorenja</h2>
          {(s?.warnings ?? []).length === 0 && <p className="text-muted">Nema otvorenih stavki za ovaj presek.</p>}
          {s?.warnings.map((w) => <p key={w.detail}><strong>{w.title}.</strong> {w.detail}</p>)}
        </div>
        <div className="card space-y-2">
          <h2 className="text-xl">Niska zaliha</h2>
          {(s?.low ?? []).map((a) => <p key={a.name}>{a.name}: {formatQty(a.on_hand, a.base_unit)}</p>)}
          {(s?.low ?? []).length === 0 && <p className="text-muted">Nijedan artikal nije ispod minimuma.</p>}
        </div>
      </div>
    </div>
  );
}

type Art = { id: string; name: string; kind: string; base_unit: string; on_hand: string; avg_cost: string | null; min_qty: string; tracks_stock: boolean; is_demo: boolean };

export function ArticlesPage() {
  const boot = useBoot();
  const refresh = useRefresh();
  const q = useRead<{ articles: Art[]; categories: { id: string; name: string }[]; packs: { article_id: string; name: string; qty_in_base: string }[] }>("articles");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("sirovina");
  const [unit, setUnit] = useState("g");
  const [minQty, setMin] = useState("0");
  const [find, setFind] = useState("");
  const [openArt, setOpen] = useState("");
  const [qty, setQty] = useState("");
  const [packUnit, setPackUnit] = useState("g");
  const [cost, setCost] = useState("");
  const [date, setDate] = useState(boot.data?.businessDate ?? "");
  const [packName, setPackName] = useState("karton");
  const [packQty, setPackQty] = useState("1");
  const rows = (q.data?.articles ?? []).filter((a) => a.name.toLowerCase().includes(find.toLowerCase()));
  return (
    <GateNote boot={boot.data} perm="artikli">
      <div className="space-y-4">
        <h1 className="text-3xl">Artikli i zalihe</h1>
        <p className="text-sm text-muted">Vrednovanje je pokretni ponderisani prosek. Trošak (struja, kirija) ne pravi zalihu.</p>
        <form className="card grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
          e.preventDefault();
          try {
            await commit("saveArticle", { name, kind, baseUnit: unit, minQty, tracksStock: kind !== "trosak", idempotencyKey: crypto.randomUUID() });
            setName(""); toast.success("Artikal je sačuvan"); refresh();
          } catch (error) { err(error); }
        }}>
          <Field label="Naziv" value={name} onChange={setName} />
          <label className="field"><span>Vrsta</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="sirovina">Sirovina</option><option value="pice">Piće</option><option value="ambalaza">Ambalaža</option>
              <option value="poluproizvod">Poluproizvod</option><option value="gotov">Gotov proizvod</option><option value="higijena">Higijena</option><option value="trosak">Trošak</option>
            </select>
          </label>
          <label className="field"><span>Osnovna jedinica</span>
            <select value={unit} onChange={(e) => setUnit(e.target.value)}><option value="g">gram</option><option value="ml">mililitar</option><option value="kom">komad</option></select>
          </label>
          <Field label="Minimalna zaliha" value={minQty} onChange={setMin} />
          <button className="btn btn-primary sm:col-span-2" type="submit">Dodaj artikal</button>
        </form>
        <Field label="Pretraga" value={find} onChange={setFind} />
        <div className="space-y-2">
          {rows.map((a) => (
            <div key={a.id} className="card">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">{a.name} {a.is_demo && <span className="text-copper">proba</span>}</p>
                  <p className="num text-sm text-muted">{a.tracks_stock ? formatQty(a.on_hand, a.base_unit) : "ne vodi zalihu"} · prosečna {a.avg_cost ? formatRsd(a.avg_cost) : "nepoznata"} / {a.base_unit}</p>
                </div>
                <button className="btn" type="button" onClick={() => setOpen(openArt === a.id ? "" : a.id)}>Početno / pakovanje</button>
              </div>
              {openArt === a.id && (
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Field label="Količina početnog stanja" value={qty} onChange={setQty} />
                  <Field label="Jedinica (g, kg, kom, karton…)" value={packUnit} onChange={setPackUnit} />
                  <Field label="Cena po toj jedinici" value={cost} onChange={setCost} />
                  <Field label="Datum preseka" value={date} onChange={setDate} type="date" />
                  <button className="btn btn-primary" type="button" onClick={async () => {
                    try {
                      await commit("postOpening", { articleId: a.id, qty, unit: packUnit, unitCost: cost, date, idempotencyKey: `op-${a.id}-${date}` });
                      toast.success("Početno stanje je knjiženo"); refresh();
                    } catch (error) { err(error); }
                  }}>Knjiži početno stanje</button>
                  <Field label="Naziv pakovanja" value={packName} onChange={setPackName} />
                  <Field label="Koliko osnovnih jedinica ima u 1 pakovanju" value={packQty} onChange={setPackQty} />
                  <button className="btn" type="button" onClick={async () => {
                    try { await commit("savePack", { articleId: a.id, name: packName, qtyInBase: packQty, idempotencyKey: crypto.randomUUID() }); toast.success("Pakovanje je sačuvano"); refresh(); }
                    catch (error) { err(error); }
                  }}>Sačuvaj pakovanje</button>
                  <p className="text-xs text-muted sm:col-span-2">{(q.data?.packs ?? []).filter((p) => p.article_id === a.id).map((p) => `${p.name} = ${p.qty_in_base} ${a.base_unit}`).join(" · ") || "Nema pakovanja."}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </GateNote>
  );
}

export function InvoicesPage() {
  const boot = useBoot();
  const refresh = useRefresh();
  const list = useRead<{ invoices: { id: string; doc_number: string | null; status: string; total: string | null; supplier: string | null; paid: string; kind: string; doc_date: string | null }[] }>("invoices");
  const suppliers = useRead<{ suppliers: { id: string; name: string }[] }>("suppliers");
  const arts = useRead<{ articles: Art[] }>("articles");
  const [supplierId, setSupplier] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [docNumber, setDoc] = useState("");
  const [docDate, setDocDate] = useState("");
  const [total, setTotal] = useState("");
  const [kind, setKind] = useState("nabavka");
  const [dueDate, setDue] = useState("");
  const [acceptDiff, setAccept] = useState(false);
  const [photo, setPhoto] = useState<{ name: string; dataUrl: string } | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<{ rawName: string; articleId: string; qty: string; unitName: string; lineTotal: string }[]>([
    { rawName: "", articleId: "", qty: "", unitName: "", lineTotal: "" },
  ]);
  function patchLine(i: number, patch: Partial<(typeof lines)[number]>) {
    setLines((prev) => prev.map((line, idx) => (idx === i ? { ...line, ...patch } : line)));
  }
  async function ensureSupplier() {
    if (supplierId) return supplierId;
    if (!supplierName.trim()) return null;
    const res = await commit("saveSupplier", { name: supplierName, idempotencyKey: crypto.randomUUID() }) as { id: string };
    setSupplier(res.id);
    return res.id;
  }
  return (
    <GateNote boot={boot.data} perm="racuni">
      <div className="space-y-4">
        <h1 className="text-3xl">Računi i nabavka</h1>
        <p className="text-sm text-muted">{boot.data?.ai ? "Prepoznavanje fotografije je povezano. Predlog uvek proverite pre knjiženja." : "Prepoznavanje nije povezano (nema serverskog ključa). Unos je ručan, fotografija se čuva uz račun."}</p>
        <form className="card grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const sid = await ensureSupplier();
            const filled = lines.filter((l) => l.rawName.trim() || l.articleId);
            if (!filled.length) throw new Error("Dodajte bar jednu stavku.");
            for (const l of filled) {
              if (!l.rawName.trim() && !l.articleId) throw new Error("Stavka nema naziv.");
              if (!l.qty.trim()) throw new Error(`„${l.rawName || "stavka"}“ nema količinu. Nula nije upisana.`);
              if (!l.unitName.trim()) throw new Error(`„${l.rawName || "stavka"}“ nema jedinicu. Komad nije pretpostavljen.`);
              if ((kind === "nabavka" || kind === "trosak") && !l.lineTotal.trim()) {
                throw new Error(`„${l.rawName || "stavka"}“ nema iznos. Cena nije upisana kao nula.`);
              }
            }
            const saved = await commit("upsertInvoice", {
              supplierId: sid, docNumber, docDate, receivedDate: docDate, dueDate: dueDate || null, kind, total, idempotencyKey: key,
              files: photo ? [{ name: photo.name, mime: "image/jpeg", dataUrl: photo.dataUrl }] : [],
              lines: filled.map((l) => ({
                rawName: l.rawName.trim(),
                articleId: l.articleId || null,
                qty: l.qty,
                unitName: l.unitName,
                unitPrice: null,
                discount: "0",
                lineTotal: l.lineTotal,
                needsReview: !l.articleId && kind !== "arhiva",
                taxRate: null,
                expiry: null,
              })),
            }) as { id: string; warnings: string[] };
            const posted = await commit("postInvoice", { invoiceId: saved.id, acceptMismatch: acceptDiff, allowDuplicate: false, idempotencyKey: crypto.randomUUID() }) as { status: string; warnings?: string[] };
            toast.success(posted.status === "proknjizen" ? "Račun je proknjižen" : `Status: ${posted.status}`);
            (saved.warnings ?? []).concat(posted.warnings ?? []).forEach((w) => toast.message(w));
            setKey(crypto.randomUUID());
            setLines([{ rawName: "", articleId: "", qty: "", unitName: "", lineTotal: "" }]);
            setDoc(""); setTotal(""); setPhoto(null); setAccept(false);
            refresh();
          } catch (error) { err(error); } finally { setBusy(false); }
        }}>
          <label className="field sm:col-span-2"><span>Fotografija računa</span>
            <input type="file" accept="image/*" capture="environment" onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const dataUrl = await shrink(file);
              setPhoto({ name: file.name || "racun.jpg", dataUrl });
              try {
                const rec = await recognizeReceipt({ data: { dataUrl } });
                if (!rec.ok) { toast.message(rec.error); return; }
                if (rec.parsed.supplier) setSupplierName(rec.parsed.supplier);
                if (rec.parsed.docNumber) setDoc(rec.parsed.docNumber);
                if (rec.parsed.docDate) setDocDate(rec.parsed.docDate);
                if (rec.parsed.total) setTotal(rec.parsed.total);
                const mapped = (rec.parsed.lines ?? []).filter((line) => line.name && String(line.name).trim()).map((line) => {
                  const unclear = Boolean(line.unclear);
                  const text = (value: string | null | undefined) => (unclear || value == null ? "" : String(value).trim());
                  return {
                    rawName: String(line.name).trim(),
                    articleId: "",
                    qty: text(line.qty),
                    unitName: text(line.unit),
                    lineTotal: text(line.lineTotal),
                  };
                });
                if (mapped.length) setLines(mapped);
                toast.success("Ubačeno je samo ono što je pročitano. Prazna količina, jedinica ili iznos nisu dopunjeni.");
              } catch (error) { err(error); }
            }} />
          </label>
          <Field label="Novi dobavljač" value={supplierName} onChange={setSupplierName} />
          <label className="field"><span>Ili postojeći</span>
            <select value={supplierId} onChange={(e) => setSupplier(e.target.value)}>
              <option value="">—</option>
              {(suppliers.data?.suppliers ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <Field label="Broj dokumenta" value={docNumber} onChange={setDoc} />
          <Field label="Datum" value={docDate} onChange={setDocDate} type="date" />
          <Field label="Ukupan iznos" value={total} onChange={setTotal} />
          <Field label="Dospeće" value={dueDate} onChange={setDue} type="date" />
          <label className="field"><span>Vrsta</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="nabavka">Nabavka robe</option>
              <option value="povracaj">Povraćaj dobavljaču</option>
              <option value="trosak">Trošak (bez zalihe)</option>
              <option value="arhiva">Samo arhiva, ne dira zalihu</option>
            </select>
          </label>
          {lines.map((line, i) => (
            <div key={i} className="grid gap-3 rounded-xl border border-line p-3 sm:col-span-2 sm:grid-cols-2">
              <Field label={`Stavka ${i + 1}`} value={line.rawName} onChange={(v) => patchLine(i, { rawName: v })} />
              <label className="field"><span>Artikal</span>
                <select value={line.articleId} onChange={(e) => patchLine(i, { articleId: e.target.value })}>
                  <option value="">Poveži kasnije</option>
                  {(arts.data?.articles ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
              <Field label="Količina" value={line.qty} onChange={(v) => patchLine(i, { qty: v })} />
              <Field label="Jedinica (kom, kg, karton…)" value={line.unitName} onChange={(v) => patchLine(i, { unitName: v })} />
              <Field label="Iznos stavke" value={line.lineTotal} onChange={(v) => patchLine(i, { lineTotal: v })} />
              {lines.length > 1 && <button className="btn" type="button" onClick={() => setLines(lines.filter((_, idx) => idx !== i))}>Ukloni stavku</button>}
            </div>
          ))}
          <button className="btn" type="button" onClick={() => setLines([...lines, { rawName: "", articleId: "", qty: "", unitName: "", lineTotal: "" }])}>Još jedna stavka</button>
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={acceptDiff} onChange={(e) => setAccept(e.target.checked)} /> Zbir se ne slaže, ipak knjiži</label>
          {photo && <p className="text-sm text-muted sm:col-span-2">Fotografija je sačuvana uz račun.</p>}
          <button className="btn btn-primary sm:col-span-2" disabled={busy} type="submit">{busy ? "Knjižim…" : "Sačuvaj i knjiži"}</button>
        </form>
        <div className="space-y-2">
          {(list.data?.invoices ?? []).map((inv) => (
            <div key={inv.id} className="card flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-semibold">{inv.supplier ?? "Bez dobavljača"} · {inv.doc_number ?? "bez broja"}</p>
                <p className="text-sm text-muted">{inv.doc_date} · {inv.status} · {inv.kind} · {formatRsd(inv.total)} · plaćeno {formatRsd(inv.paid)}</p>
              </div>
              {inv.status === "proknjizen" && can(boot.data, "racuni") && (
                <div className="flex flex-col items-end gap-2">
                  <Pay id={inv.id} onDone={refresh} />
                  <button className="btn" type="button" onClick={async () => {
                    const reason = window.prompt("Razlog storna") ?? "";
                    if (!reason.trim()) return;
                    try {
                      await commit("voidInvoice", { invoiceId: inv.id, reason, idempotencyKey: crypto.randomUUID() });
                      toast.success("Račun je storniran. Zaliha je vraćena kroz protivstavku.");
                      refresh();
                    } catch (error) { err(error); }
                  }}>Storno</button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </GateNote>
  );
}

function Pay({ id, onDone }: { id: string; onDone: () => void }) {
  const [amount, setAmount] = useState("");
  const [fromCash, setCash] = useState(false);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Uplata" value={amount} onChange={setAmount} />
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={fromCash} onChange={(e) => setCash(e.target.checked)} /> iz kase</label>
      <button className="btn" type="button" onClick={async () => {
        try {
          await commit("payInvoice", { invoiceId: id, amount, method: fromCash ? "kes" : "prenos", fromCash, idempotencyKey: crypto.randomUUID() });
          toast.success("Uplata je evidentirana. Nabavka se ne povećava ponovo.");
          onDone();
        } catch (error) { err(error); }
      }}>Plaćanje</button>
    </div>
  );
}

async function shrink(file: File): Promise<string> {
  const data = await file.arrayBuffer();
  const blob = new Blob([data], { type: file.type || "image/jpeg" });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Slika nije učitana"));
      el.src = url;
    });
    const scale = Math.min(1, 1400 / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.7);
  } finally {
    URL.revokeObjectURL(url);
  }
}
