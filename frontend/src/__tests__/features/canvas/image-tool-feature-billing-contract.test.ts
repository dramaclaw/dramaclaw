// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readCanvasSource = (name: string) =>
  readFileSync(
    resolve(process.cwd(), `src/features/canvas/ui/${name}.tsx`),
    "utf8",
  );

const sources = {
  panorama: readCanvasSource("Scene360Overlay"),
  multiView: readCanvasSource("MultiAngleEditorPanel"),
  relight: readCanvasSource("LightEditorPanel"),
  grid: readCanvasSource("GridActionConfirmOverlay"),
  redraw: readCanvasSource("RedrawOverlay"),
  erase: readCanvasSource("EraseOverlay"),
  upscale: readCanvasSource("UpscaleEditorOverlay"),
  outpaint: readCanvasSource("OutpaintEditorOverlay"),
};

describe("canvas image tool feature billing contract", () => {
  it("quotes the five product features instead of raw image models", () => {
    expect(sources.panorama).toContain("FREEZONE_IMAGE_FEATURES.panorama");
    expect(sources.multiView).toContain("FREEZONE_IMAGE_FEATURES.multiView");
    expect(sources.relight).toContain("FREEZONE_IMAGE_FEATURES.relight");
    expect(sources.grid).toContain("FREEZONE_IMAGE_FEATURES.grid");

    for (const source of [
      sources.redraw,
      sources.erase,
      sources.upscale,
      sources.outpaint,
    ]) {
      expect(source).toContain("FREEZONE_IMAGE_FEATURES.edit");
    }

    for (const source of Object.values(sources)) {
      expect(source).toContain("useGenerationCreditCost(");
      expect(source).toContain("BillingRuleNotConfiguredError");
      expect(source).not.toContain("useGenerationCreditCost('image_selection'");
      expect(source).not.toContain('useGenerationCreditCost("image_selection"');
    }
  });

  it("passes the concrete edit or grid operation into pricing", () => {
    expect(sources.multiView).toContain("operation: 'multi_view'");
    expect(sources.relight).toContain('operation: "relight"');
    expect(sources.grid).toContain("mode: gridMode");
    expect(sources.redraw).toContain("operation: 'redraw'");
    expect(sources.erase).toContain("operation: 'erase'");
    expect(sources.upscale).toContain("operation: 'upscale'");
    expect(sources.outpaint).toContain("operation: 'outpaint'");
  });
});
