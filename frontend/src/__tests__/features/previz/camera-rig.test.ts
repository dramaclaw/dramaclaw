// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from "vitest";

import { createPrevizObject } from "@/features/previz/domain/objects";
import type { PrevizCamera } from "@/features/previz/domain/scene";
import { monitorViewportRect, syncMonitorCamera } from "@/features/previz/engine/cameraRig";

function camera(overrides: Partial<PrevizCamera> = {}): PrevizCamera {
  return { ...(createPrevizObject("camera", []) as PrevizCamera), ...overrides };
}

function fakeMonitor() {
  return {
    fov: 0,
    aspect: 0,
    updateProjectionMatrix: vi.fn(),
    position: { setFromMatrixPosition: vi.fn() },
    quaternion: { setFromRotationMatrix: vi.fn() },
    matrixWorld: {},
  };
}

function fakeNode() {
  return { matrixWorld: { elements: [] }, updateWorldMatrix: vi.fn() };
}

describe("syncMonitorCamera", () => {
  it("sets the vertical fov from focal length, sensor and output aspect", () => {
    const monitor = fakeMonitor();

    syncMonitorCamera(
      monitor as never,
      fakeNode() as never,
      camera({ focalMm: 50, sensor: "ff" }),
      "16:9",
    );

    expect(monitor.fov).toBeCloseTo(22.8952, 3);
    expect(monitor.aspect).toBeCloseTo(16 / 9, 6);
    expect(monitor.updateProjectionMatrix).toHaveBeenCalled();
  });

  it("re-derives the vertical fov when the output aspect changes", () => {
    const monitor = fakeMonitor();

    syncMonitorCamera(
      monitor as never,
      fakeNode() as never,
      camera({ focalMm: 50, sensor: "ff" }),
      "9:16",
    );

    // 同一支 50 mm 镜头，竖幅下垂直视场角要大得多——监看框必须跟着变，
    // 不然用户看到的取景和实际出片对不上。
    expect(monitor.fov).toBeCloseTo(65.2385, 3);
    expect(monitor.aspect).toBeCloseTo(9 / 16, 6);
  });

  it("copies the node's world transform instead of its local one", () => {
    const monitor = fakeMonitor();
    const node = fakeNode();

    syncMonitorCamera(monitor as never, node as never, camera(), "1:1");

    // 机位节点将来可能挂在别的父节点下（P4 的特写 rig），只读 position
    // 会在那一刻悄悄错位。
    expect(node.updateWorldMatrix).toHaveBeenCalled();
    expect(monitor.position.setFromMatrixPosition).toHaveBeenCalledWith(node.matrixWorld);
    expect(monitor.quaternion.setFromRotationMatrix).toHaveBeenCalledWith(node.matrixWorld);
  });
});

describe("monitorViewportRect", () => {
  it("puts the monitor in the bottom-right corner at the output aspect", () => {
    const rect = monitorViewportRect(1600, 900, "16:9");

    expect(rect.width).toBe(Math.round(1600 * 0.26));
    expect(rect.height).toBe(Math.round(rect.width / (16 / 9)));
    // WebGL 的视口原点在左下角，不是左上角。
    expect(rect.x).toBe(1600 - rect.width - 16);
    expect(rect.y).toBe(16);
  });

  it("keeps a tall monitor inside the canvas", () => {
    const rect = monitorViewportRect(400, 300, "9:16");

    // 竖幅监看在小画布上按宽度算会比画布还高，必须按高度回推宽度。
    expect(rect.height).toBeLessThanOrEqual(300 - 32);
    expect(rect.width / rect.height).toBeCloseTo(9 / 16, 2);
  });

  // 画布还没布局完（clientWidth 为 0）或者被拖到极窄时，按比例算出来的宽高会是 0
  // 甚至负数。`setViewport(…, 0, 0)` 在部分驱动上是 GL_INVALID_VALUE，而 three 不报错。
  it("never hands back a degenerate rect on a tiny canvas", () => {
    for (const [width, height] of [
      [0, 0],
      [10, 10],
      [1, 200],
    ] as const) {
      const rect = monitorViewportRect(width, height, "16:9");
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.height).toBeGreaterThan(0);
    }
  });
});
