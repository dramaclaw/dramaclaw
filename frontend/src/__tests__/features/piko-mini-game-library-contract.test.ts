// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  "src/features/piko-mini-game/PikoInspirationStation.tsx",
  "utf8",
);
const librarySource = source.slice(
  source.indexOf("const PIKO_GAME_LIBRARY"),
  source.indexOf("const KIND_LABEL"),
);
const posterCardSource = source.slice(
  source.indexOf("function PikoGamePosterCard"),
  source.indexOf("const KIND_LABEL"),
);
const zh = JSON.parse(
  readFileSync("public/locales/zh/translation.json", "utf8"),
);
const en = JSON.parse(
  readFileSync("public/locales/en/translation.json", "utf8"),
);

describe("Piko 游戏中心", () => {
  it("只保留六款确认上线的小游戏", () => {
    expect(librarySource.match(/\bid:/g)).toHaveLength(6);
    expect(librarySource).not.toContain('id: "catch"');
    expect(source).not.toContain("PikoCatchGame");
    expect(
      existsSync("src/features/piko-mini-game/PikoCatchGame.tsx"),
    ).toBe(false);
  });

  it("使用确认后的简短中文名称，并保持英文标题齐全", () => {
    expect([
      zh.pikoMiniGame.title,
      zh.pikoMiniGame.memory.title,
      zh.pikoMiniGame.breakout.title,
      zh.pikoMiniGame.stackGame.title,
      zh.pikoMiniGame.flying.title,
      zh.pikoMiniGame.leap.title,
    ]).toEqual([
      "灵感咻咻",
      "翻到一对",
      "砖块退散",
      "叠住别慌",
      "千万别撞",
      "跳准一点",
    ]);
    expect(en.pikoMiniGame.catch).toBeUndefined();
    expect(zh.pikoMiniGame.catch).toBeUndefined();
    expect([
      en.pikoMiniGame.title,
      en.pikoMiniGame.memory.title,
      en.pikoMiniGame.breakout.title,
      en.pikoMiniGame.stackGame.title,
      en.pikoMiniGame.flying.title,
      en.pikoMiniGame.leap.title,
    ]).toEqual([
      "Spark Shots",
      "Find a Pair",
      "Bricks Begone",
      "Stack, Don't Panic",
      "Don't Crash",
      "Stick the Landing",
    ]);
  });

  it("使用原生四比三海报入口，并为六个游戏提供 hover 视频", () => {
    expect(source).toContain("aspect-[4/3]");
    expect(source).not.toContain("aspect-[3/2]");
    expect(source).not.toContain("aspect-square");
    expect(librarySource.match(/posterSrc:/g)).toHaveLength(6);
    expect(librarySource.match(/videoSrc:/g)).toHaveLength(6);
    const hoverAssets = [
      "spark-shots",
      "find-a-pair",
      "bricks-begone",
      "stack-dont-panic",
      "dont-crash",
      "stick-the-landing",
    ];
    hoverAssets.forEach((assetName) => {
      expect(librarySource).toContain(
        `videoSrc: "/piko/games/previews/${assetName}-hover.mp4"`,
      );
      expect(librarySource).toContain(
        `posterSrc: "/piko/games/posters/${assetName}-hover-frame.jpg"`,
      );
      expect(existsSync(`public/piko/games/previews/${assetName}-hover.mp4`)).toBe(true);
      expect(existsSync(`public/piko/games/posters/${assetName}-hover-frame.jpg`)).toBe(true);
    });
    expect(posterCardSource.match(/<video/g)).toHaveLength(1);
    expect(posterCardSource).not.toContain("<img");
    expect(posterCardSource).not.toContain("will-change-opacity");
    expect(posterCardSource).not.toContain("duration-[80ms]");
    expect(posterCardSource).not.toContain("setTimeout");
    expect(posterCardSource).not.toContain("hoverVideoVisible");
    expect(posterCardSource).toContain("onPointerEnter={playHoverPreview}");
    expect(posterCardSource).toContain("onPointerLeave={stopHoverPreview}");
    expect(posterCardSource).toContain('preload="auto"');
    expect(posterCardSource).toContain("video.currentTime = HOVER_VIDEO_FIRST_FRAME");
    expect(posterCardSource).not.toContain("group-hover:scale");
    expect(posterCardSource).not.toContain("group-focus-visible:scale");
    expect(posterCardSource).not.toContain("transform-gpu");
    expect(posterCardSource).not.toContain("will-change-transform");
    expect(posterCardSource).toContain('video.removeAttribute("poster")');
    expect(posterCardSource).toContain("onSeeked={(event) =>");
    expect(posterCardSource).toContain("transition-[filter] duration-300 ease-out");
    expect(posterCardSource).toContain("group-hover:brightness-[1.04]");
    expect(posterCardSource).toContain("group-hover:saturate-[1.04]");
    expect(source).not.toContain("hover:-translate-y-1");
    expect(source).not.toContain("group-hover:translate-y-0");
    expect(source).toContain("aria-label={title}");
    expect(source).not.toContain("border-b border-white/[0.07]");
  });

  it("海报入口按窗口宽度保留递进式卡片间距", () => {
    expect(source).toContain(
      "grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3 lg:gap-6",
    );
  });

  it("进入任意小游戏时共享灵感咻咻的背景音乐", () => {
    expect(source).toContain('const BGM_SOUND_SRC = "/piko/sounds/bgm.mp3"');
    expect(source).toContain('if (!open || stationView !== "game" || isAudioMuted)');
    expect(source).not.toContain('activeGameId !== "inspiration-station"');
  });
});
