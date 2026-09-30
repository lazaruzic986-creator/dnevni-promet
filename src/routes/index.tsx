import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "@/components/screens";
import { Shell } from "@/components/shell";

export const Route = createFileRoute("/")({
  component: () => (
    <Shell>
      <HomePage />
    </Shell>
  ),
});
