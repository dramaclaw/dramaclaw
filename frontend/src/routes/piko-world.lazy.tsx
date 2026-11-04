// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Install PixiJS's CSP-safe sync generators before any Piko module evaluates PixiJS.
import "pixi.js/unsafe-eval";

import { createLazyFileRoute } from "@tanstack/react-router";

import { PikoWorldExperience } from "@/features/piko-world/PikoWorldExperience";

function PikoWorldPage() {
  return <PikoWorldExperience />;
}

export const Route = createLazyFileRoute("/piko-world")({
  component: PikoWorldPage,
});
