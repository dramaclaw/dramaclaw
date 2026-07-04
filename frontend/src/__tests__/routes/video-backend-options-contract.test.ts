// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("video backend options alignment", () => {
  it("does not hardcode the VideoPane backend list", () => {
    const videoPane = read("src/components/episode/beat-workbench/video-pane.tsx");

    expect(videoPane).not.toContain("const VIDEO_BACKENDS");
    expect(videoPane).toContain("useVideoBackends");
  });

  it("uses the backend capabilities for dialogue-only blocking", () => {
    const videoPane = read("src/components/episode/beat-workbench/video-pane.tsx");

    expect(videoPane).toContain("dialogue_only");
  });

  it("supports the Grok Video inspector from backend capabilities", () => {
    const videoPane = read("src/components/episode/beat-workbench/video-pane.tsx");
    const videoQueries = read("src/lib/queries/video.ts");

    expect(videoQueries).toContain("is_grok_video");
    expect(videoPane).toContain("showGrokVideoConfig");
    expect(videoPane).toContain("Grok Video 检视器");
    expect(videoPane).toContain("3:2");
  });

  it("defaults to the ST2 canonical video backend instead of legacy comfyui", () => {
    const beatsRoute = read("src/routes/_app/projects.$project/episodes.$episode/beats.lazy.tsx");
    const videoQueries = read("src/lib/queries/video.ts");

    expect(beatsRoute).toContain("DEFAULT_VIDEO_BACKEND");
    expect(videoQueries).toContain("huimeng_seedance-1.0-pro-fast");
    expect(videoQueries).not.toContain('videoBackend ?? "comfyui"');
  });
});
