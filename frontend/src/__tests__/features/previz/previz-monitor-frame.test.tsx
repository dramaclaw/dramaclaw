// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createPrevizObject } from "@/features/previz/domain/objects";
import type { OutputAspect, PrevizCamera } from "@/features/previz/domain/scene";
import { PrevizMonitorFrame } from "@/features/previz/ui/PrevizMonitorFrame";

// 16:9 常规档的监看：右下角锚在 (x + width, y)，260 × 146。
const RECT = { x: 500, y: 16, width: 260, height: 146 };

function setup(outputAspect: OutputAspect = "16:9") {
  const onOutputAspect = vi.fn();
  const camera = createPrevizObject("camera", []) as PrevizCamera;
  render(
    <PrevizMonitorFrame
      rect={RECT}
      camera={camera}
      outputAspect={outputAspect}
      size="normal"
      showOutline={false}
      showNamePlate={false}
      onOutputAspect={onOutputAspect}
      onSize={vi.fn()}
      onShowOutline={vi.fn()}
      onShowNamePlate={vi.fn()}
      following={false}
      onFollow={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  return { onOutputAspect };
}

function drag(handle: HTMLElement, from: [number, number], to: [number, number]) {
  fireEvent.pointerDown(handle, { clientX: from[0], clientY: from[1], pointerId: 1, button: 0 });
  fireEvent.pointerMove(handle, { clientX: to[0], clientY: to[1], pointerId: 1 });
}

describe("PrevizMonitorFrame aspect dragging", () => {
  it("previews the snapped aspect while dragging the left edge and commits on release", () => {
    const { onOutputAspect } = setup();
    const handle = screen.getByTestId("previz-monitor-resize-left");

    // 左边往右收 114px：宽 146 等于高，吸到 1:1。
    drag(handle, [500, 80], [614, 80]);
    const preview = screen.getByTestId("previz-monitor-resize-preview");
    expect(preview).toHaveTextContent("1:1");
    expect(preview).toHaveStyle({ width: "146px", height: "146px" });
    // 拖动中不写场景：每写一次就是一条撤销记录。
    expect(onOutputAspect).not.toHaveBeenCalled();

    fireEvent.pointerUp(handle, { clientX: 614, clientY: 80, pointerId: 1 });
    expect(onOutputAspect).toHaveBeenCalledExactlyOnceWith("1:1");
    expect(screen.queryByTestId("previz-monitor-resize-preview")).toBeNull();
  });

  it("writes a free ratio against the long side when nothing is close enough to snap", () => {
    const { onOutputAspect } = setup();
    const handle = screen.getByTestId("previz-monitor-resize-left");

    // 宽拉到 380：380 / 146 ≈ 2.60，离 2.39:1 和 21:9 都远。
    drag(handle, [500, 80], [380, 80]);
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(onOutputAspect).toHaveBeenCalledExactlyOnceWith("2.6:1");
  });

  it("changes the height from the top edge and both sides from the corner", () => {
    const { onOutputAspect } = setup();

    // 上边往上拉到 462：260 / 462 ≈ 9:16。
    const top = screen.getByTestId("previz-monitor-resize-top");
    drag(top, [600, 300], [600, -16]);
    expect(screen.getByTestId("previz-monitor-resize-preview")).toHaveTextContent("9:16");
    fireEvent.pointerUp(top, { pointerId: 1 });
    expect(onOutputAspect).toHaveBeenLastCalledWith("9:16");

    // 左上角：宽 200、高 300，吸到 2:3。
    const corner = screen.getByTestId("previz-monitor-resize-corner");
    drag(corner, [500, 300], [560, 146]);
    expect(screen.getByTestId("previz-monitor-resize-preview")).toHaveTextContent("2:3");
    fireEvent.pointerUp(corner, { pointerId: 1 });
    expect(onOutputAspect).toHaveBeenLastCalledWith("2:3");
  });

  it("does not write when the drag is cancelled or ends on the current aspect", () => {
    const { onOutputAspect } = setup();
    const handle = screen.getByTestId("previz-monitor-resize-left");

    drag(handle, [500, 80], [614, 80]);
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    expect(screen.queryByTestId("previz-monitor-resize-preview")).toBeNull();

    // 抖了几个像素仍吸回 16:9，等于没改。
    drag(handle, [500, 80], [503, 80]);
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(onOutputAspect).not.toHaveBeenCalled();
  });
});
