// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  formatReferenceMediaCompilerLabel,
  type ReferenceMediaCapEntry,
} from "./videoFormOptions";

describe("formatReferenceMediaCompilerLabel", () => {
  it("uses the visible media index and display name for Recipe compiler labels", () => {
    const entry: ReferenceMediaCapEntry = {
      item: {
        kind: "image",
        nodeId: "node-1",
        imageUrl: "https://example.test/scene.png",
        displayName: "上一镜尾帧",
      },
      typeIndex: 4,
      withinCap: true,
    };

    expect(formatReferenceMediaCompilerLabel(entry)).toBe("图片4：上一镜尾帧");
  });

  it("falls back to node id when the media has no display name", () => {
    const entry: ReferenceMediaCapEntry = {
      item: {
        kind: "audio",
        nodeId: "audio-node",
        audioUrl: "https://example.test/audio.mp3",
      },
      typeIndex: 2,
      withinCap: true,
    };

    expect(formatReferenceMediaCompilerLabel(entry)).toBe("音频2：audio-node");
  });
});
