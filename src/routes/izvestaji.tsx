import { createFileRoute } from "@tanstack/react-router";
import { ReportsPage } from "@/components/screens-admin";
import { Shell } from "@/components/shell";

export const Route = createFileRoute("/izvestaji")({
  component: () => (
    <Shell>
      <ReportsPage />
    </Shell>
  ),
});
