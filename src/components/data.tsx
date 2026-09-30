import { useQuery, useQueryClient } from "@tanstack/react-query";
import { act, read } from "@/lib/h/api";

export type Boot = {
  mode: "setup" | "wait" | "app";
  email: string | null;
  name: string | null;
  role?: string;
  perms?: Record<string, boolean>;
  org?: {
    name: string;
    legal_name: string | null;
    pib: string | null;
    address: string | null;
    city: string | null;
    phone: string | null;
    business_day_end_hour: number;
    tax_mode: string;
    auto_post_invoices: boolean;
    locked_through: string | null;
    initial_cash: string;
    valuation_method: string;
    timezone: string;
    currency: string;
  };
  shift?: { id: string; business_date: string; opening_cash: string } | null;
  businessDate?: string;
  ai?: boolean;
  hasDemo?: boolean;
};

export function useBoot() {
  return useQuery({ queryKey: ["bootstrap"], queryFn: () => read({ data: { op: "bootstrap" } }) as Promise<Boot> });
}

export function useRead<T>(op: string, body?: Record<string, unknown>) {
  return useQuery({
    queryKey: [op, body ?? {}],
    queryFn: () => read({ data: { op, body } }) as Promise<T>,
  });
}

export async function commit(op: string, body: Record<string, unknown>) {
  const key = String(body.idempotencyKey ?? crypto.randomUUID());
  const payload = { op, body: { ...body, idempotencyKey: key } };
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    const queued = JSON.parse(localStorage.getItem("dpu-outbox") || "[]") as unknown[];
    queued.push(payload);
    localStorage.setItem("dpu-outbox", JSON.stringify(queued));
    window.dispatchEvent(new Event("dpu-outbox"));
    throw new Error("Nema mreže. Unos čeka na ovom uređaju i neće se knjižiti dvaput kad se veza vrati.");
  }
  return act({ data: payload });
}

export function useRefresh() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
}

export function roleLabel(role?: string) {
  if (role === "super_admin") return "Vlasnik";
  if (role === "knjigovodja") return "Knjigovođa";
  if (role === "admin") return "Admin";
  return "";
}

export function can(boot: Boot | undefined, key: string) {
  if (!boot || boot.mode !== "app") return false;
  if (boot.role === "super_admin") return true;
  return Boolean(boot.perms?.[key]);
}
