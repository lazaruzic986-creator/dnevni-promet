import { createFileRoute } from "@tanstack/react-router";
import { ArticlesPage } from "@/components/screens";
import { Shell } from "@/components/shell";

export const Route = createFileRoute("/artikli")({
  component: () => (
    <Shell>
      <ArticlesPage />
    </Shell>
  ),
});
