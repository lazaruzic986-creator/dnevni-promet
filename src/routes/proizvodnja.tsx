import { createFileRoute } from "@tanstack/react-router";
import { ProductionPage } from "@/components/screens-rest";
import { Shell } from "@/components/shell";

export const Route = createFileRoute("/proizvodnja")({
  component: () => (
    <Shell>
      <ProductionPage />
    </Shell>
  ),
});
