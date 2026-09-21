// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createFileRoute } from "@tanstack/react-router";

import { BlenderPairingPage } from "@/features/blender/BlenderPairingPage";

export const Route = createFileRoute("/_app/blender-pairing")({
  component: BlenderPairingPage,
});
