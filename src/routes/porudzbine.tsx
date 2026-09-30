import { createFileRoute } from "@tanstack/react-router";
import { OrdersPage } from "@/components/screens-admin";
import { Shell } from "@/components/shell";

export const Route = createFileRoute("/porudzbine")({
  component: () => (
    <Shell>
      <OrdersPage />
    </Shell>
  ),
});
