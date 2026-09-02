// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  PREVIZ_CAMERA_LEAD_RATIO,
  PREVIZ_PITCH_RANGE,
  PREVIZ_ROLL_RANGE,
  cameraDraftForward,
  cameraDraftOverrides,
  clampCameraDraft,
  createCameraDraft,
  normalizeYawDeg,
} from "@/features/previz/domain/cameraDraft";
import { PREVIZ_DEFAULT_VIEW } from "@/features/previz/domain/view";

describe("createCameraDraft", () => {
  it("aims the draft along the director view's line of sight", () => {
    // 正对 -Z 站着往前看：偏航 0、俯仰 0。
    const draft = createCameraDraft({ position: [0, 1.6, 4], target: [0, 1.6, 0] });

    expect(draft.yawDeg).toBeCloseTo(0, 6);
    expect(draft.pitchDeg).toBeCloseTo(0, 6);
    // 横滚不从视口带：OrbitControls 永远保持 up 朝天，读回来的只会是 0。
    expect(draft.rollDeg).toBe(0);
    expect(draft.focalMm).toBe(50);
    expect(draft.aperture).toBe(2.8);
    expect(draft.sensor).toBe("ff");
    expect(draft.cameraBody).toBe("cine");
    expect(draft.lensSeries).toBe("prime");
  });

  it("reads yaw counter-clockwise from -Z and pitch up from the horizon", () => {
    // 站在 +X 往原点看，视线沿 -X。three 里绕 +Y 转 90° 把 -Z 转到 -X，所以偏航是 90。
    const west = createCameraDraft({ position: [4, 0, 0], target: [0, 0, 0] });
    expect(west.yawDeg).toBeCloseTo(90, 6);
    expect(west.pitchDeg).toBeCloseTo(0, 6);

    // 站高往下看：俯仰为负。45° 是因为水平退了 4、垂直高了 4。
    const high = createCameraDraft({ position: [0, 4, 4], target: [0, 0, 0] });
    expect(high.pitchDeg).toBeCloseTo(-45, 6);
    expect(high.yawDeg).toBeCloseTo(0, 6);
  });

  it("keeps a degenerate view from producing NaN angles", () => {
    // 站位与注视点重合（轨道中心被拖到眼位上）：方向向量是零向量。
    const draft = createCameraDraft({ position: [1, 2, 3], target: [1, 2, 3] });

    expect(draft.yawDeg).toBe(0);
    expect(draft.pitchDeg).toBe(0);
    expect(draft.position).toEqual([1, 2, 3]);
  });

  /**
   * 建在眼位上的机位，机身盒体正好糊在视口相机脸上——新建完什么都看不见，只有一片
   * 蓝。沿视线往前挪一小段，机身就落在画面里了。upstream 实测也是这么干的：视角
   * 6.0/5.0/8.0（轨道中心 0/0.5/0）建出来的机位在 4.8/4.1/6.4，恰好是 20%。
   */
  it("leads the new camera forward so it is not created inside the viewport eye", () => {
    const draft = createCameraDraft({ position: [6, 5, 8], target: [0, 0.5, 0] });

    expect(PREVIZ_CAMERA_LEAD_RATIO).toBe(0.2);
    expect(draft.position[0]).toBeCloseTo(4.8, 6);
    expect(draft.position[1]).toBeCloseTo(4.1, 6);
    expect(draft.position[2]).toBeCloseTo(6.4, 6);
  });

  it("defaults to the shared viewport placement", () => {
    const draft = createCameraDraft(PREVIZ_DEFAULT_VIEW);

    // 默认视角 [6,4,8] 看向 [0,1,0]：往前挪 20% 之后仍在同一条视线上。
    expect(draft.position[0]).toBeCloseTo(4.8, 6);
    expect(draft.position[1]).toBeCloseTo(3.4, 6);
    expect(draft.position[2]).toBeCloseTo(6.4, 6);
    expect(draft.yawDeg).toBeGreaterThan(0);
    expect(draft.yawDeg).toBeLessThan(90);
  });
});

describe("draft angle ranges", () => {
  it("wraps yaw into [0, 360)", () => {
    expect(normalizeYawDeg(0)).toBe(0);
    expect(normalizeYawDeg(360)).toBe(0);
    expect(normalizeYawDeg(-90)).toBe(270);
    expect(normalizeYawDeg(450)).toBe(90);
    // 滑杆到头再按一下「+」不该跳到 NaN 或停在边界上。
    expect(normalizeYawDeg(-720.5)).toBeCloseTo(359.5, 6);
    expect(normalizeYawDeg(Number.NaN)).toBe(0);
  });

  it("pins the slider ranges the create dialog uses", () => {
    expect(PREVIZ_PITCH_RANGE).toEqual({ min: -90, max: 90, default: 0 });
    expect(PREVIZ_ROLL_RANGE).toEqual({ min: -180, max: 180, default: 0 });
  });
});

describe("cameraDraftForward", () => {
  it("matches the -Z convention three uses for object rotation", () => {
    const [x, y, z] = cameraDraftForward({ yawDeg: 0, pitchDeg: 0 });
    expect([x, y, z].map((value) => Number(value.toFixed(6)))).toEqual([0, 0, -1]);

    const [ex, ey, ez] = cameraDraftForward({ yawDeg: 90, pitchDeg: 0 });
    expect([ex, ey, ez].map((value) => Number(value.toFixed(6)))).toEqual([-1, 0, -0]);

    const [ux, uy, uz] = cameraDraftForward({ yawDeg: 0, pitchDeg: 90 });
    expect([ux, uy, uz].map((value) => Number(value.toFixed(6)))).toEqual([0, 1, -0]);
  });

  it("round-trips through createCameraDraft", () => {
    const draft = createCameraDraft({ position: [3, 5, -2], target: [-1, 1, 4] });
    const [fx, fy, fz] = cameraDraftForward(draft);
    // 视线方向（归一化后）应当与 draft 的朝向一致。
    const length = Math.sqrt(4 * 4 + 4 * 4 + 6 * 6);
    expect(fx).toBeCloseTo(-4 / length, 6);
    expect(fy).toBeCloseTo(-4 / length, 6);
    expect(fz).toBeCloseTo(6 / length, 6);
  });
});

describe("cameraDraftOverrides", () => {
  it("lays the draft out the way createPrevizObject expects", () => {
    const overrides = cameraDraftOverrides({
      cameraBody: "handheld",
      lensSeries: "zoom",
      focalMm: 85,
      aperture: 4,
      sensor: "s35",
      position: [1, 2, 3],
      yawDeg: 30,
      pitchDeg: -10,
      rollDeg: 5,
    });

    // rotation 是 [x, y, z] = [俯仰, 偏航, 横滚]，与 sceneGraph 钉死的 YXZ 次序对应。
    expect(overrides).toEqual({
      transform: { position: [1, 2, 3], rotation: [-10, 30, 5], scale: [1, 1, 1] },
      focalMm: 85,
      aperture: 4,
      sensor: "s35",
      cameraBody: "handheld",
      lensSeries: "zoom",
    });
  });

  it("clamps the draft the same way the schema would", () => {
    const overrides = cameraDraftOverrides({
      ...createCameraDraft(PREVIZ_DEFAULT_VIEW),
      focalMm: 900,
      aperture: 0.1,
      yawDeg: -30,
      pitchDeg: 200,
      rollDeg: -900,
    });

    expect(overrides.focalMm).toBe(200);
    expect(overrides.aperture).toBe(1.2);
    expect(overrides.transform?.rotation).toEqual([90, 330, -180]);
  });
});

describe("clampCameraDraft", () => {
  // 对话框上的数字输入框存的是用户敲的原样，收敛推迟到这里；水平角循环、其余夹取。
  it("wraps yaw and clamps the rest", () => {
    const clamped = clampCameraDraft({
      ...createCameraDraft(PREVIZ_DEFAULT_VIEW),
      focalMm: 0,
      aperture: 99,
      yawDeg: 400,
      pitchDeg: -200,
      rollDeg: 500,
    });

    expect(clamped).toMatchObject({
      focalMm: 12,
      aperture: 22,
      yawDeg: 40,
      pitchDeg: -90,
      rollDeg: 180,
    });
  });
});
