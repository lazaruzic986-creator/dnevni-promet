import { Link, useRouterState } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import {
  BookOpen,
  ChefHat,
  ClipboardList,
  FileBarChart,
  FolderOpen,
  Landmark,
  LayoutDashboard,
  Link2,
  Package,
  Receipt,
  Settings,
  ShieldAlert,
  ShoppingBag,
  Trash2,
  UtensilsCrossed,
  Wallet,
} from "lucide-react";
import { UserButton } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { authEnabled } from "@/lib/auth/client";
import { act } from "@/lib/h/api";
import { can, roleLabel, useBoot, type Boot } from "./data";

const NAV: { to: string; label: string; perm: string; icon: typeof Receipt }[] = [
  { to: "/", label: "Početna", perm: "izvestaji", icon: LayoutDashboard },
  { to: "/racuni", label: "Računi", perm: "racuni", icon: Receipt },
  { to: "/artikli", label: "Artikli", perm: "artikli", icon: Package },
  { to: "/recepture", label: "Recepture", perm: "recepture", icon: UtensilsCrossed },
  { to: "/proizvodnja", label: "Proizvodnja", perm: "proizvodnja", icon: ChefHat },
  { to: "/prodaja", label: "Prodaja", perm: "prodaja", icon: ShoppingBag },
  { to: "/smene", label: "Smene", perm: "smene", icon: Wallet },
  { to: "/rashod", label: "Rashod", perm: "rashod", icon: Trash2 },
  { to: "/popis", label: "Popis", perm: "popis", icon: ClipboardList },
  { to: "/porudzbine", label: "Porudžbine", perm: "porudzbine", icon: BookOpen },
  { to: "/troskovi", label: "Troškovi", perm: "troskovi", icon: Landmark },
  { to: "/izvestaji", label: "Izveštaji", perm: "izvestaji", icon: FileBarChart },
  { to: "/knjigovodja", label: "Knjigovođa", perm: "knjigovodja", icon: FolderOpen },
  { to: "/kontrola", label: "Kontrola", perm: "kontrola", icon: ShieldAlert },
  { to: "/podesavanja", label: "Podešavanja", perm: "podesavanja", icon: Settings },
  { to: "/grok", label: "Grok", perm: "podesavanja", icon: Link2 },
];

function Outbox() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const count = () => setN(JSON.parse(localStorage.getItem("dpu-outbox") || "[]").length);
    count();
    const flush = async () => {
      if (!navigator.onLine) return;
      const items = JSON.parse(localStorage.getItem("dpu-outbox") || "[]") as { op: string; body: Record<string, unknown> }[];
      const left = [];
      for (const item of items) {
        try { await act({ data: item }); } catch { left.push(item); }
      }
      localStorage.setItem("dpu-outbox", JSON.stringify(left));
      count();
    };
    window.addEventListener("online", flush);
    window.addEventListener("dpu-outbox", count);
    flush();
    return () => {
      window.removeEventListener("online", flush);
      window.removeEventListener("dpu-outbox", count);
    };
  }, []);
  if (!n) return null;
  return <p className="bg-copper px-4 py-2 text-sm text-paper">Nije sačuvano: {n}. Ostaje na uređaju dok se veza ne vrati. Isti unos se ne knjiži dvaput.</p>;
}

export function Shell({ children }: { children: ReactNode }) {
  const { isPending } = useCurrentUserState();
  const [mounted, setMounted] = useState(false);
  const boot = useBoot();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [more, setMore] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || isPending) {
    return <main className="grid min-h-screen place-items-center"><p className="text-lg">Učitavanje evidencije…</p></main>;
  }
  if (boot.isLoading) {
    return <main className="grid min-h-screen place-items-center"><p>Pripremam objekat…</p></main>;
  }
  if (boot.isError) {
    return <main className="mx-auto max-w-lg p-6"><p className="text-bad">{(boot.error as Error).message}</p></main>;
  }
  const data = boot.data;
  if (!data || data.mode !== "app") return <main className="mx-auto max-w-lg p-4">{children}</main>;
  const items = NAV.filter((item) => can(data, item.perm) || (item.to === "/" && can(data, "izvestaji")));
  return (
    <div className="min-h-screen md:grid md:grid-cols-[240px_1fr]">
      <aside className="hidden border-r border-line bg-forest text-paper md:flex md:flex-col md:gap-1 md:p-4">
        <p className="px-2 pt-2 font-display text-2xl">Dnevni promet</p>
        <p className="px-2 pb-3 text-sm text-paper/80">{data.org?.name}</p>
        {items.map((item) => {
          const Icon = item.icon;
          const active = path === item.to;
          return (
            <Link key={item.to} to={item.to} className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm ${active ? "bg-paper text-forest" : "text-paper/90"}`}>
              <Icon size={18} /> {item.label}
            </Link>
          );
        })}
      </aside>
      <div className="pb-24 md:pb-0">
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            <p className="font-display text-xl text-forest">{data.org?.name}</p>
            <p className="text-sm text-muted">Poslovni dan {data.businessDate} · {roleLabel(data.role)} · {data.shift ? "smena otvorena" : "smena nije otvorena"}</p>
          </div>
          {authEnabled ? <UserButton /> : null}
        </header>
        <Outbox />
        <div className="mx-auto max-w-5xl p-4">{children}</div>
      </div>
      <nav className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-4 border-t border-line bg-card md:hidden">
        {items.slice(0, 3).map((item) => (
          <Link key={item.to} to={item.to} className="grid min-h-14 place-items-center text-xs">{item.label}</Link>
        ))}
        <button type="button" className="min-h-14 text-xs" onClick={() => setMore(true)}>Još</button>
      </nav>
      {more && (
        <div className="fixed inset-0 z-30 bg-ink/40 md:hidden" onClick={() => setMore(false)}>
          <div className="absolute inset-x-0 bottom-0 max-h-[80vh] overflow-auto rounded-t-2xl bg-card p-4" onClick={(e) => e.stopPropagation()}>
            {items.map((item) => (
              <Link key={item.to} to={item.to} onClick={() => setMore(false)} className="block min-h-11 py-2">{item.label}</Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function GateNote({ boot, perm, children }: { boot?: Boot; perm: string; children: ReactNode }) {
  if (boot?.mode === "app" && !can(boot, perm) && boot.role !== "super_admin") {
    return <p className="card">Nemate dozvolu za ovaj pregled. Vlasnik je podešava u korisnicima.</p>;
  }
  return <>{children}</>;
}
