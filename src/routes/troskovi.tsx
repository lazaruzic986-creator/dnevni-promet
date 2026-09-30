import { createFileRoute } from "@tanstack/react-router";
import { ExpensesPage } from "@/components/screens-admin";
import { Shell } from "@/components/shell";

export const Route = createFileRoute("/troskovi")({
  component: () => (
    <Shell>
      <ExpensesPage />
    </Shell>
  ),
});
