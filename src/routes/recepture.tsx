import { createFileRoute } from "@tanstack/react-router";
import { RecipesPage } from "@/components/screens-rest";
import { Shell } from "@/components/shell";

export const Route = createFileRoute("/recepture")({
  component: () => (
    <Shell>
      <RecipesPage />
    </Shell>
  ),
});
