// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// 这两个 import 只存在于测试里。运行时代码绝不能引用 viewer-kit —— 那边是 PlayCanvas 栈，
// 一旦被预演台的 chunk 引到，打开预演台就要顺带下载整个 PlayCanvas 引擎。
import { POSES, POSE_LABELS } from "@/features/viewer-kit/three-d/engine/poses";

import {
  PREVIZ_POSES,
  PREVIZ_POSE_CLIPS,
  PREVIZ_POSE_LABEL,
  isPrevizPoseId,
  resolvePoseClipName,
} from "@/features/previz/domain/poses";

// 用 `path` 拼而不是 `new URL(..., import.meta.url)`：后者会被 Vite 改写成它自己的
// 静态资源解析，在 jsdom 下拿到的是 http:// 地址，fs 读不了。
const VIEWER_APP_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../features/viewer-kit/three-d/engine/viewerApp.ts",
);

/**
 * `QUATERNIUS_POSE_CLIPS` 是 PlayCanvas 模块里的局部 const，import 不到——连测试都不行，
 * 因为求值 `viewerApp.ts` 就会把 playcanvas 拉起来。改成读源码文本再按结构比：这样
 * 重新格式化不会误报，而任何一边真改了表都会红。
 */
function readViewerKitPoseClips(): unknown {
  const source = readFileSync(VIEWER_APP_PATH, "utf8");
  const anchor = "const QUATERNIUS_POSE_CLIPS";
  const anchorAt = source.indexOf(anchor);
  expect(anchorAt, `${anchor} 在 viewerApp.ts 里找不到——是不是改名了？`).toBeGreaterThan(-1);

  const openAt = source.indexOf("= {", anchorAt);
  expect(openAt, "QUATERNIUS_POSE_CLIPS 没有对象字面量").toBeGreaterThan(-1);
  const closeAt = source.indexOf("\n  };", openAt);
  expect(closeAt, "QUATERNIUS_POSE_CLIPS 的字面量没有在同缩进层收口").toBeGreaterThan(openAt);

  const literal = source.slice(openAt + "= ".length, closeAt + "\n  }".length);
  const json = literal
    .replace(/'/g, '"')
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(json) as unknown;
}

describe("previz pose catalogue", () => {
  // 两套表分别喂给 three 和 PlayCanvas，用的却是同一份 GLB。漂移的后果是「同一个
  // 姿势在预演台和 3D 导演里长得不一样」，而这种错没有任何运行时信号。
  it("covers exactly the same pose set as the viewer-kit catalogue", () => {
    expect([...PREVIZ_POSES].sort()).toEqual([...POSES].sort());
  });

  it("gives every pose a clip candidate list and a label", () => {
    for (const pose of PREVIZ_POSES) {
      expect(PREVIZ_POSE_CLIPS[pose].names.length).toBeGreaterThan(0);
      expect(PREVIZ_POSE_CLIPS[pose].sampleTime).toBeGreaterThan(0);
      expect(PREVIZ_POSE_LABEL[pose]).toBeTruthy();
    }
  });

  // `sampleTime` 是往 clip 里数的秒数，而这些 clip 本身只有几秒长。非有限值或者超界会
  // 让骨架静默定格在末帧而不是想要的姿势上，所以要卡范围而不只是卡符号——现实中最容易
  // 犯的错是把毫秒（250）写进本该是秒（0.25）的位置。
  it("keeps every sample time inside a plausible clip duration", () => {
    for (const pose of PREVIZ_POSES) {
      const { sampleTime } = PREVIZ_POSE_CLIPS[pose];
      expect(Number.isFinite(sampleTime)).toBe(true);
      expect(sampleTime).toBeLessThan(2);
    }
  });

  // 候选表是按优先级顺序找的，同一条 clip 名出现两次意味着第二次永远轮不到，
  // 十有八九是复制粘贴时漏改了。
  it("carries no duplicate clip candidates within a pose", () => {
    for (const pose of PREVIZ_POSES) {
      const names = PREVIZ_POSE_CLIPS[pose].names;
      expect(new Set(names).size).toBe(names.length);
    }
  });

  // clip 表和标签表都是 viewer-kit 那份的逐字副本——上面那条「运行时不许 import」逼出来的。
  // 除了这两条棘轮，没有任何东西拦得住它们各改各的。
  it("matches the viewer-kit clip table verbatim", () => {
    expect(readViewerKitPoseClips()).toEqual(PREVIZ_POSE_CLIPS);
  });

  it("matches the viewer-kit pose labels verbatim", () => {
    expect(PREVIZ_POSE_LABEL).toEqual(POSE_LABELS);
  });

  it("picks the first candidate the model actually carries", () => {
    const available = new Set(["Idle_No_Loop", "Walk_Loop"]);

    // standing 的首选是 Idle_Loop，模型里没有就顺位到 Idle_No_Loop。
    expect(resolvePoseClipName("standing", available)).toBe("Idle_No_Loop");
    expect(resolvePoseClipName("walking", available)).toBe("Walk_Loop");
  });

  // 模型换版本、clip 被改名时，这里返回 null 让调用方回落到占位而不是抛异常炸掉整个场景。
  it("returns null when the model carries none of the candidates", () => {
    expect(resolvePoseClipName("sword", new Set(["Walk_Loop"]))).toBeNull();
  });

  // 姿势 id 来自落盘的场景，旧文件可能带着已经删掉的 id，类型拦不住它走到这里。
  // 这种情况要走同一条 null 回落，而不是在缺失的表项上抛 TypeError。
  it("returns null for a pose id that is not in the catalogue", () => {
    const unknown = "moonwalk" as unknown as (typeof PREVIZ_POSES)[number];
    expect(resolvePoseClipName(unknown, new Set(["Idle_Loop"]))).toBeNull();
  });

  it("recognises only known pose ids", () => {
    expect(isPrevizPoseId("standing")).toBe(true);
    expect(isPrevizPoseId("moonwalk")).toBe(false);
  });
});
