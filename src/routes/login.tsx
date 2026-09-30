import { createFileRoute, Link } from "@tanstack/react-router";
import { Shell } from "@/components/shell";

export const Route = createFileRoute("/login")({
  component: () => (
    <Shell>
      <p className="card">
        Prijavljeni ste. <Link className="underline" to="/">Nastavite na početnu tablu.</Link>
      </p>
    </Shell>
  ),
});
