// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";

import { useCanvasStore } from "@/stores/canvasStore";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { projectionScopedId } from "@/features/freezone/projectionGraphIds";

/**
 * 拖动组内成员松手后的收尾 fitGroupToChildren（libtv 式：按成员最终落点重新包住）。
 * 重点回归断言：组尺寸必须同时更新显式 width/height 与 style —— React Flow 渲染时
 * 显式 width 优先于 style.width，只改 style 视觉上不生效（框线不动的根因）。
 */
describe("fitGroupToChildren (drop-position refit)", () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  function makePlainGroup(): string {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: "a",
          type: CANVAS_NODE_TYPES.imageEdit,
          position: { x: 100, y: 100 },
          width: 260,
          height: 160,
          style: { width: 260, height: 160 },
          data: { imageUrl: "a.png" },
        },
        {
          id: "b",
          type: CANVAS_NODE_TYPES.imageEdit,
          position: { x: 420, y: 130 },
          width: 240,
          height: 180,
          style: { width: 240, height: 180 },
          data: { imageUrl: "b.png" },
        },
      ],
      [],
    );
    const groupId = useCanvasStore.getState().groupNodes(["a", "b"]);
    expect(groupId).not.toBeNull();
    return groupId as string;
  }

  function group(groupId: string) {
    return useCanvasStore.getState().nodes.find((n) => n.id === groupId)!;
  }

  function groupSize(groupId: string): { width: number; height: number } {
    const g = group(groupId);
    return {
      width: (g.style?.width as number) ?? 0,
      height: (g.style?.height as number) ?? 0,
    };
  }

  function moveMember(id: string, dx: number, dy: number) {
    useCanvasStore.setState({
      nodes: useCanvasStore
        .getState()
        .nodes.map((n) =>
          n.id === id
            ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
            : n,
        ),
    });
  }

  it("members are free to move (no extent clamp on plain-group members)", () => {
    const groupId = makePlainGroup();
    const members = useCanvasStore
      .getState()
      .nodes.filter((n) => n.parentId === groupId);
    expect(members.length).toBe(2);
    expect(members.every((n) => n.extent === undefined)).toBe(true);
  });

  it("re-encloses a member dropped past the bottom/right, syncing width/height with style", () => {
    const groupId = makePlainGroup();
    const before = groupSize(groupId);

    // Simulate a drop far beyond the bottom/right edge, then the drag-stop refit.
    moveMember("b", 800, 600);
    useCanvasStore.getState().fitGroupToChildren(groupId);

    const after = groupSize(groupId);
    expect(after.width).toBeGreaterThan(before.width);
    expect(after.height).toBeGreaterThan(before.height);
    // The enclosed member must sit inside the new box (right/bottom + padding).
    const b = useCanvasStore.getState().nodes.find((n) => n.id === "b")!;
    expect(b.position.x + 240).toBeLessThanOrEqual(after.width);
    expect(b.position.y + 180).toBeLessThanOrEqual(after.height);
    // Regression guard: explicit width/height must follow style, or React Flow
    // keeps rendering the old size (explicit width wins over style.width).
    expect(group(groupId).width).toBe(after.width);
    expect(group(groupId).height).toBe(after.height);
  });

  it("re-encloses a member dropped past the top/left by shifting the origin", () => {
    const groupId = makePlainGroup();
    const originBefore = { ...group(groupId).position };

    moveMember("a", -300, -200);
    useCanvasStore.getState().fitGroupToChildren(groupId);

    // Origin shifts up/left so the runaway member is back inside.
    const originAfter = group(groupId).position;
    expect(originAfter.x).toBeLessThan(originBefore.x);
    expect(originAfter.y).toBeLessThan(originBefore.y);
    const a = useCanvasStore.getState().nodes.find((n) => n.id === "a")!;
    expect(a.position.x).toBeGreaterThanOrEqual(0);
    expect(a.position.y).toBeGreaterThanOrEqual(0);
    const size = groupSize(groupId);
    expect(group(groupId).width).toBe(size.width);
    expect(group(groupId).height).toBe(size.height);
  });

  /**
   * 主线投影组同样要贴合成员：组框由后端按估算尺寸算出，成员实际渲染尺寸（图片
   * 加载后、文本换行后）只有前端知道。不贴合的话成员带 extent:"parent" 会被
   * React Flow 夹回小框里叠成一堆，用户又没法手动救——组框是只读的。
   * 只放开「几何贴合」，拓扑保护（不能解组）仍由 ungroupNode 拦住。
   */
  it("also re-encloses members of a backend-managed projection group", () => {
    const groupId = "projection_group_asset_character_x";
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: groupId,
          type: CANVAS_NODE_TYPES.group,
          position: { x: 0, y: 0 },
          width: 360,
          height: 240,
          style: { width: 360, height: 240 },
          data: {
            label: "林小满",
            preset_managed: true,
            projection_key: "asset:character:x",
          },
        },
        {
          id: "profile",
          type: CANVAS_NODE_TYPES.textAnnotation,
          position: { x: 20, y: 34 },
          parentId: groupId,
          extent: "parent",
          // 实际测得的渲染尺寸远大于后端估算，组框包不住。
          measured: { width: 440, height: 320 },
          data: {
            content: "profile",
            preset_managed: true,
            projection_key: "asset:character:x",
          },
        },
      ],
      [],
    );

    // setCanvasData 会把投影节点 id 重写成 projectionScopedId(...)，用原始 id 调不到。
    const scopedGroupId = projectionScopedId("asset:character:x", groupId);
    useCanvasStore.getState().fitGroupToChildren(scopedGroupId);

    const g = useCanvasStore.getState().nodes.find((n) => n.id === scopedGroupId)!;
    const child = useCanvasStore.getState().nodes.find((n) => n.id.endsWith("profile"))!;
    expect(child.position.x + 440).toBeLessThanOrEqual(g.width as number);
    expect(child.position.y + 320).toBeLessThanOrEqual(g.height as number);
    // 与普通组一致：显式 width/height 必须与 style 同步，否则 React Flow 不重绘。
    expect(g.style?.width).toBe(g.width);
    expect(g.style?.height).toBe(g.height);
  });

  it("never shrinks below a manual enlarge (grow-only)", () => {
    const groupId = makePlainGroup();
    useCanvasStore.setState({
      nodes: useCanvasStore
        .getState()
        .nodes.map((n) =>
          n.id === groupId
            ? {
                ...n,
                width: 2000,
                height: 1500,
                style: { ...(n.style ?? {}), width: 2000, height: 1500 },
              }
            : n,
        ),
    });
    useCanvasStore.getState().fitGroupToChildren(groupId);
    expect(groupSize(groupId)).toEqual({ width: 2000, height: 1500 });
  });
});
