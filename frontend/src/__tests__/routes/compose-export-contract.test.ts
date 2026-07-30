// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("compose export API alignment", () => {
  it("uses /export/video for final video and POST /export/zip for zip export", () => {
    const compose = read(
      "src/routes/_app/projects.$project/episodes.$episode/compose.lazy.tsx",
    );

    expect(compose).toContain("/export/video");
    expect(compose).toContain("api.post");
    expect(compose).toContain("/export/zip");
    expect(compose).not.toContain("export/${suffix}");
  });

  it("wires the BGM toggle into the /videos/compose payload", () => {
    const compose = read(
      "src/routes/_app/projects.$project/episodes.$episode/compose.lazy.tsx",
    );

    // The 背景音乐 toggle is the supported caller: when on it names an explicit
    // provider so the provider-neutral backend contract is reachable; when off
    // the payload keeps add_bgm driven by state (default false).
    expect(compose).toContain("add_bgm: addBgm");
    expect(compose).toContain("setAddBgm");
    expect(compose).toContain('bgm_source: "artlist"');
    expect(compose).toContain("bgm_query:");
    expect(compose).toContain('t("video.addBgm")');
  });

  it("hydrates and persists NiceGUI compose preferences from project config", () => {
    const compose = read(
      "src/routes/_app/projects.$project/episodes.$episode/compose.lazy.tsx",
    );

    expect(compose).toContain("useProject(project)");
    expect(compose).toContain("useUpdateProject(project)");
    expect(compose).toContain("projectConfig?.video_resolution");
    expect(compose).toContain("projectConfig?.add_subtitles");
    expect(compose).toContain("video_resolution: next");
    expect(compose).toContain("add_subtitles: next");
  });

  it("keeps compose blocker copy fully localized", () => {
    const compose = read(
      "src/routes/_app/projects.$project/episodes.$episode/compose.lazy.tsx",
    );
    const zh = read("public/locales/zh/translation.json");
    const en = read("public/locales/en/translation.json");

    expect(compose).toContain('t("episode.compose.blockerCount"');
    expect(compose).toContain('t("episode.compose.blockerSubtitle"');
    expect(compose).toContain('t("episode.compose.missingItems"');
    expect(compose).toContain('t("episode.compose.beatLabel")');
    expect(compose).not.toContain(">Beat<");

    for (const locale of [zh, en]) {
      expect(locale).toContain('"blockerCount"');
      expect(locale).toContain('"blockerSubtitle"');
      expect(locale).toContain('"missingItemSeparator"');
      expect(locale).toContain('"missingItems"');
      expect(locale).toContain('"beatLabel"');
    }
  });
});
