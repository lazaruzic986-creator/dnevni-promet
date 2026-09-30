import { createFileRoute } from "@tanstack/react-router";
import { AccountantPage } from "@/components/screens-admin";
import { Shell } from "@/components/shell";

export const Route = createFileRoute("/knjigovodja")({
  component: () => (
    <Shell>
      <AccountantPage />
    </Shell>
  ),
});
