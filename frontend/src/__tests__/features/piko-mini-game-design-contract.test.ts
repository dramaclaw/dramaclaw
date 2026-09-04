// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const station = readFileSync("src/features/piko-mini-game/PikoInspirationStation.tsx", "utf8");
const breakout = readFileSync("src/features/piko-mini-game/PikoBreakoutGame.tsx", "utf8");
const flying = readFileSync("src/features/piko-mini-game/PikoFlyingGame.tsx", "utf8");
const leap = readFileSync("src/features/piko-mini-game/PikoLeapGame.tsx", "utf8");
const stackGame = readFileSync("src/features/piko-mini-game/PikoStackGame.tsx", "utf8");
const chrome = readFileSync("src/features/piko-mini-game/PikoGameChrome.tsx", "utf8");

describe("Piko 五款小游戏设计升级", () => {
  it("共享统一 HUD 与结果层", () => {
    expect(chrome).toContain("function PikoGameHud");
    expect(chrome).toContain("function PikoGameOverlay");
    expect([breakout, flying, leap, stackGame].every((source) => source.includes("PikoGameHud"))).toBe(true);
    expect([breakout, flying, leap, stackGame].every((source) => source.includes("PikoGameOverlay"))).toBe(true);
  });

  it("翻牌游戏具备渐进轮次、连对计分与扫描道具", () => {
    expect(station).toContain("MEMORY_ROUND_PAIR_COUNTS = [4, 6, 8]");
    expect(station).toContain("scanCards");
    expect(station).toContain("nextStreak * 25");
  });

  it("打砖块具备三波结构、装甲砖与爆破砖", () => {
    expect(breakout).toContain('type BrickKind = "normal" | "armored" | "blast"');
    expect(breakout).toContain("waveRef.current < 3");
    expect(breakout).toContain('brick.kind === "blast"');
  });

  it("飞行游戏具备固定障碍模板、精准奖励与可恢复护盾", () => {
    expect(flying).toContain("GATE_PATTERNS");
    expect(flying).toContain("precisionStreakRef");
    expect(flying).toContain("hasShield");
  });

  it("跳跃游戏具备平台变化、完美落点与一次救援", () => {
    expect(leap).toContain('type PlatformKind = "normal" | "bonus" | "spring" | "fragile"');
    expect(leap).toContain("rescueAvailableRef");
    expect(leap).toContain('showLandingFeedback("perfect")');
  });

  it("叠住别慌使用三关物理堆叠玩法并移除滚珠实现", () => {
    expect(stackGame).toContain('type PropKind = "jelly" | "bulb" | "gear" | "bottle" | "spring" | "critter"');
    expect(stackGame).toContain("const STACK_LEVELS");
    expect(stackGame).toContain("towerBalance");
    expect(stackGame).toContain("rescueOrLose");
    expect(station).toContain('PikoStackGame');
    expect(existsSync("src/features/piko-mini-game/PikoTrackBallGame.tsx")).toBe(false);
    expect(existsSync("src/features/piko-mini-game/PikoRollingBallGame.tsx")).toBe(false);
  });
});
