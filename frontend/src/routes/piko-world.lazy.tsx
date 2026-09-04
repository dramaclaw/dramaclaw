// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createLazyFileRoute } from "@tanstack/react-router";

import { PikoWorldShell } from "@/features/piko-world/PikoWorldShell";

function PikoWorldPage() {
  return <PikoWorldShell />;
}

export const Route = createLazyFileRoute("/piko-world")({
  component: PikoWorldPage,
});
