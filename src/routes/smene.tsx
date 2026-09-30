import { createFileRoute } from "@tanstack/react-router";
import { ShiftPage } from "@/components/screens-rest";
import { Shell } from "@/components/shell";

export const Route = createFileRoute("/smene")({
  component: () => (
    <Shell>
      <ShiftPage />
    </Shell>
  ),
});
