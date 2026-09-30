import { createFileRoute } from "@tanstack/react-router";
import { SettingsPage } from "@/components/screens-admin";
import { Shell } from "@/components/shell";

export const Route = createFileRoute("/podesavanja")({
  component: () => (
    <Shell>
      <SettingsPage />
    </Shell>
  ),
});
