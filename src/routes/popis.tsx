import { createFileRoute } from "@tanstack/react-router";
import { CountPage } from "@/components/screens-rest";
import { Shell } from "@/components/shell";

export const Route = createFileRoute("/popis")({
  component: () => (
    <Shell>
      <CountPage />
    </Shell>
  ),
});
