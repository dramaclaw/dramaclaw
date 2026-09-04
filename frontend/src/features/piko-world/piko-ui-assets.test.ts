// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PIKO_UI_ASSETS = [
  "public/piko/world/ui/piko-world-return-icon-v2.png",
  "public/piko/world/ui/piko-world-chat-icon-v2.png",
  "public/piko/world/ui/piko-world-settings-icon-v1.png",
  "public/piko/world/ui/piko-world-close-icon-v1.png",
  "public/piko/world/ui/control-labels/piko-world-control-label-return-v1.png",
  "public/piko/world/ui/control-labels/piko-world-control-label-chat-v1.png",
  "public/piko/world/ui/control-labels/piko-world-control-label-settings-v1.png",
  "public/piko/world/ui/backgrounds/piko-world-page-background-day-v1.png",
  "public/piko/world/ui/backgrounds/piko-world-page-background-dusk-v1.png",
  "public/piko/world/ui/backgrounds/piko-world-page-background-night-v1.png",
  "public/piko/world/ui/chat/piko-world-chat-panel-top-v1.png",
  "public/piko/world/ui/chat/piko-world-chat-panel-middle-v1.png",
  "public/piko/world/ui/chat/piko-world-chat-panel-bottom-v1.png",
  "public/piko/world/ui/resident-selector/piko-world-resident-selector-panel-top-v1.png",
  "public/piko/world/ui/resident-selector/piko-world-resident-selector-panel-middle-v1.png",
  "public/piko/world/ui/resident-selector/piko-world-resident-selector-panel-bottom-v1.png",
] as const;

describe("Piko world UI assets", () => {
  it("keeps every referenced runtime asset in the public bundle", () => {
    for (const asset of PIKO_UI_ASSETS) {
      expect(existsSync(asset), asset).toBe(true);
    }
  });
});
