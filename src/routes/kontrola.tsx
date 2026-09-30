import { createFileRoute } from "@tanstack/react-router";
import { ControlPage } from "@/components/screens-admin";
import { Shell } from "@/components/shell";

export const Route = createFileRoute("/kontrola")({
  component: () => (
    <Shell>
      <ControlPage />
    </Shell>
  ),
});
