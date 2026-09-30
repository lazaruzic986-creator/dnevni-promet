import { createFileRoute } from "@tanstack/react-router";
import { SalesPage } from "@/components/screens-rest";
import { Shell } from "@/components/shell";

export const Route = createFileRoute("/prodaja")({
  component: () => (
    <Shell>
      <SalesPage />
    </Shell>
  ),
});
