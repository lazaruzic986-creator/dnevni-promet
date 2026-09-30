import { createFileRoute } from "@tanstack/react-router";
import { WastePage } from "@/components/screens-rest";
import { Shell } from "@/components/shell";

export const Route = createFileRoute("/rashod")({
  component: () => (
    <Shell>
      <WastePage />
    </Shell>
  ),
});
