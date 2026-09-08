// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from "vitest";

import { createPrevizObject } from "@/features/previz/domain/objects";
import type { PrevizCamera } from "@/features/previz/domain/scene";
import {
  monitorViewportRect,
  PREVIZ_MONITOR_TOP_RESERVE,
  syncMonitorCamera,
} from "@/features/previz/engine/cameraRig";

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

/**
 * 右上角那排视口控件的底边离画布顶边多远，CSS 像素。这里自己按
 * `PrevizViewportControls` 的类名重算一遍，而不是从实现里 import：外层 `top-4` 是 16，
 * 一簇控件是 `p-1`（4）加 1 px 边框裹着 `h-7`（28）的按钮，纵向 38。这样改坏实现里
 * 那个常量时这条断言才会响。
 */
const CONTROLS_BOTTOM_PX = 16 + (28 + 4 * 2 + 1 * 2);

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

  it("leaves room for the viewport controls in the top-right corner", () => {
    // 竖幅出片 + 矮视口（时间轴拉高时就是这样）：按宽度算出来的高会超出可用高度，
    // 走「按高度回推宽度」那条分支，正是把监看顶到右上角那排控件背后的那组参数。
    // 两档都试：放大档更宽，只会更早撞上同一条上限。
    for (const size of ["normal", "large"] as const) {
      const rect = monitorViewportRect(1840, 560, "9:16", size);

      // 原点在左下角，所以顶边是 y + height。准绳取独立推出来的控件底边，不取
      // PREVIZ_MONITOR_TOP_RESERVE：拿常量自己比是恒真的，把它改成 0 也照样绿。
      expect(rect.y + rect.height).toBeLessThanOrEqual(560 - CONTROLS_BOTTOM_PX);
      // 而且要正好长到那条线为止。只写「不超过」的话，顺手多扣一份留白也是绿的，
      // 监看白缩一圈——缩掉的是画面，屏幕上看不出是谁干的。
      expect(rect.y + rect.height).toBe(560 - PREVIZ_MONITOR_TOP_RESERVE);
    }

    // 光是不重叠还不够，得留一道看得见的缝——两排控件贴着脸也算「被遮挡了」。
    expect(PREVIZ_MONITOR_TOP_RESERVE).toBeGreaterThan(CONTROLS_BOTTOM_PX);
  });

  it("still fills the height it is given when the controls are not in the way", () => {
    // 同一块画布上 16:9 本来就够矮，顶边够不到那排控件——给控件让位这件事在这里
    // 必须一个像素都不生效。写成逐字比对而不是「小于等于」：后者对缩水是恒真的，
    // 把上限调狠一倍也照样绿。
    expect(monitorViewportRect(1840, 560, "16:9")).toEqual({
      x: 1346,
      y: 16,
      width: 478,
      height: 269,
    });
  });

  it("grows the monitor on the enlarged step", () => {
    const normal = monitorViewportRect(1600, 900, "16:9");
    const large = monitorViewportRect(1600, 900, "16:9", "large");

    expect(large.width).toBeGreaterThan(normal.width);
    // 放大档也贴右下角，两档之间只有大小变了——放大再还原不该让画面换个地方待着。
    expect(large.x).toBe(1600 - large.width - 16);
    expect(large.y).toBe(16);
    expect(large.width / large.height).toBeCloseTo(16 / 9, 2);
  });

  it("fits the enlarged monitor inside a short canvas", () => {
    // 又矮又宽：按 55% 宽度算出来的高会顶出画布，得按高度回推宽度。
    const rect = monitorViewportRect(1600, 260, "16:9", "large");

    expect(rect.height).toBeLessThanOrEqual(260 - 32);
    expect(rect.width).toBeLessThanOrEqual(1600 - 32);
    expect(rect.width / rect.height).toBeCloseTo(16 / 9, 2);
  });

  it("fits the enlarged monitor inside a narrow canvas", () => {
    // 反过来：画布比放大档还窄时，宽度也得夹住，否则视口整个横着跑到画布外。
    const rect = monitorViewportRect(200, 1200, "16:9", "large");

    expect(rect.width).toBeLessThanOrEqual(200 - 32);
    expect(rect.x).toBeGreaterThanOrEqual(0);
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
