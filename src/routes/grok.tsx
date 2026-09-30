import { createFileRoute } from "@tanstack/react-router";
import { GrokPage } from "@/components/screens-admin";
import { Shell } from "@/components/shell";

export const Route = createFileRoute("/grok")({
  component: () => (
    <Shell>
      <GrokPage />
    </Shell>
  ),
});
