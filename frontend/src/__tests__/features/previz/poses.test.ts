// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

// 这几个 import 只存在于测试里。运行时代码绝不能引用 viewer-kit —— 那边是 PlayCanvas 栈，
// 一旦被预演台的 chunk 引到，打开预演台就要顺带下载整个 PlayCanvas 引擎。
// `engine/poses.ts` 本身是零 import 的纯数据模块，引它不会把 playcanvas 求值起来。
import {
  POSES,
  POSE_LABELS,
  QUATERNIUS_POSE_CLIPS,
} from "@/features/viewer-kit/three-d/engine/poses";

import {
  PREVIZ_POSES,
  PREVIZ_POSE_CLIPS,
  PREVIZ_POSE_LABEL,
  isPrevizPoseId,
  resolvePoseClipName,
} from "@/features/previz/domain/poses";

describe("previz pose catalogue", () => {
  // 两套表分别喂给 three 和 PlayCanvas，用的却是同一份 GLB。漂移的后果是「同一个
  // 姿势在预演台和 3D 导演里长得不一样」，而这种错没有任何运行时信号。
  it("covers exactly the same pose set as the viewer-kit catalogue", () => {
    expect([...PREVIZ_POSES].sort()).toEqual([...POSES].sort());
  });

  it("gives every pose a clip candidate list and a label", () => {
    for (const pose of PREVIZ_POSES) {
      expect(PREVIZ_POSE_CLIPS[pose].names.length).toBeGreaterThan(0);
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
      expect(sampleTime).toBeGreaterThan(0);
      // 上界只抓数量级错误，不卡精确时长。库里的 clip 长 0.17–5.2 秒，所以 2 秒并不是
      // 「一定在 clip 里」的保证（现表最大值也才 0.75）；它的作用是让毫秒/秒混淆——把
      // 0.25 写成 250——露头，同时不会因为哪条采样点往后挪了 0.1 秒就误报。
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
  //
  // 这两条和上面三条属性测试不重复，分工是：棘轮保证「两边一样」，属性测试保证「这个值
  // 本身讲得通」。viewer-kit 那边要是把 250 毫秒写进 `sampleTime`，同步过来之后棘轮就绿了，
  // 只有属性测试还会红。别因为「看着像重复」把它们删掉。
  it("matches the viewer-kit clip table verbatim", () => {
    expect(PREVIZ_POSE_CLIPS).toEqual(QUATERNIUS_POSE_CLIPS);
  });

  it("matches the viewer-kit pose labels verbatim", () => {
    expect(PREVIZ_POSE_LABEL).toEqual(POSE_LABELS);
  });

  it("picks the first candidate the model actually carries", () => {
    // standing 的候选顺序是 Idle_Loop > Idle_No_Loop > Idle_FoldArms_Loop > A_TPose。
    // 这里刻意让**两条**候选同时可用（第 2、第 3 顺位），少了这一点，「取第一个命中」和
    // 「取最后一个命中」给出的答案一样，测试就锁不住优先级、只锁住「命中了某条」。
    const available = new Set(["Idle_No_Loop", "Idle_FoldArms_Loop", "Walk_Loop"]);

    // 首选 Idle_Loop 模型里没有，顺位到 Idle_No_Loop——而不是更靠后的 Idle_FoldArms_Loop。
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
    expect(resolvePoseClipName("moonwalk", new Set(["Idle_Loop"]))).toBeNull();
  });

  it("recognises only known pose ids", () => {
    expect(isPrevizPoseId("standing")).toBe(true);
    expect(isPrevizPoseId("moonwalk")).toBe(false);
  });
});
