// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createLazyFileRoute } from "@tanstack/react-router";

import { PikoWorldExperience } from "@/features/piko-world/PikoWorldExperience";

function PikoWorldPage() {
  return <PikoWorldExperience />;
}

export const Route = createLazyFileRoute("/piko-world")({
  component: PikoWorldPage,
});
