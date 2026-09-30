import { createFileRoute } from "@tanstack/react-router";
import { InvoicesPage } from "@/components/screens";
import { Shell } from "@/components/shell";

export const Route = createFileRoute("/racuni")({
  component: () => (
    <Shell>
      <InvoicesPage />
    </Shell>
  ),
});
