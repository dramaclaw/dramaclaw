// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";

import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";

// 与 spawnExternalAssets / spawnCharacterLibraryReferences 的落位口径一致：派生节点
// 按「源节点坐标系」摆放（baseX = source.position.x - 宽 - 间距），先建成根层节点，
// 再交给 autoGroupSpawn 收编。源在组内时 source.position 是组内相对坐标。
const UPLOAD_WIDTH = 320;
const GAP_X = 40;

const GROUP_ABS = { x: 1000, y: 500 };
const VIDEO_REL = { x: 60, y: 40 };
const ORPHAN_GAP_Y = 260;
const baseX = VIDEO_REL.x - UPLOAD_WIDTH - GAP_X; // -300（组内相对坐标系）

/**
 * 构造「视频节点位于组内 + 两个刚建好的根层派生节点」的初始画布。
 * 派生节点故意用组内相对坐标摆放（模拟调用方按 source.position 落位），
 * 若 autoGroupSpawn 不做绝对坐标修正，它们就会被当成绝对坐标落到画布左上角。
 *
 * 注意：受保护投影组会被 setCanvasData 改写节点 id（projection_<key>__<id>），
 * 所以 seed 后必须从 store 按类型回读真实 id，不能沿用字面量 id。
 */
function seedGroupedVideoWithOrphans(groupData: Record<string, unknown>) {
  const group = {
    id: "g1",
    type: CANVAS_NODE_TYPES.group,
    position: { ...GROUP_ABS },
    style: { width: 900, height: 700 },
    data: groupData,
  };
  const video = {
    id: "v1",
    type: CANVAS_NODE_TYPES.video,
    parentId: "g1",
    position: { ...VIDEO_REL },
    style: { width: 480, height: 380 },
    data: {},
  };
  // 两个派生 upload 节点，摆在视频左侧（组内相对坐标系）。
  const orphans = [0, 1].map((idx) => ({
    id: `s${idx}`,
    type: CANVAS_NODE_TYPES.upload,
    position: { x: baseX, y: VIDEO_REL.y + idx * ORPHAN_GAP_Y },
    style: { width: UPLOAD_WIDTH, height: 240 },
    data: { user_spawned: true },
  }));
  useCanvasStore.getState().setCanvasData([group, video, ...orphans], []);

  const nodes = useCanvasStore.getState().nodes;
  const videoId = nodes.find((n) => n.type === CANVAS_NODE_TYPES.video)?.id;
  const groupId = nodes.find((n) => n.type === CANVAS_NODE_TYPES.group)?.id;
  // upload 节点没有 projection_key，不会被改写；按数组顺序即 s0、s1。
  const orphanIds = nodes
    .filter((n) => n.type === CANVAS_NODE_TYPES.upload)
    .map((n) => n.id);
  if (!videoId || !groupId || orphanIds.length !== 2) {
    throw new Error("seed 失败：未能从 store 回读到视频/组/派生节点");
  }
  return { videoId, groupId, orphanIds };
}

describe("canvasStore autoGroupSpawn — 组内派生节点的坐标语义", () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  it("受保护投影组：收不了成员，但把派生节点平移回绝对坐标（不再落到画布原点）", () => {
    // user_spawned 不为 true + 有 projection_key → 受保护投影组。
    const { videoId, orphanIds } = seedGroupedVideoWithOrphans({
      projection_key: "proj-a",
    });

    const result = useCanvasStore.getState().autoGroupSpawn(videoId, orphanIds, {
      label: "外部素材组",
    });

    // 受保护组不接收成员，明确返回 null。
    expect(result).toBeNull();

    const state = useCanvasStore.getState();
    orphanIds.forEach((orphanId, idx) => {
      const node = state.nodes.find((n) => n.id === orphanId);
      expect(node).toBeDefined();
      // 仍是根层节点（没被塞进受保护组）。
      expect(node?.parentId).toBeUndefined();
      // 坐标被平移 +组绝对位移，落到视频身边的绝对坐标，而不是原来的相对值。
      expect(node?.position).toEqual({
        x: baseX + GROUP_ABS.x, // -300 + 1000 = 700
        y: VIDEO_REL.y + idx * ORPHAN_GAP_Y + GROUP_ABS.y, // 540 / 800
      });
      // 回归护栏：绝不再停在「相对值当绝对坐标」的画布左上角。
      expect(node?.position.x).not.toBe(baseX);
    });
  });

  it("分镜组：同样收不了成员，也把派生节点修正到绝对坐标", () => {
    const { videoId, orphanIds } = seedGroupedVideoWithOrphans({
      storyboardGroup: true,
    });

    const result = useCanvasStore.getState().autoGroupSpawn(videoId, orphanIds, {
      label: "外部素材组",
    });

    expect(result).toBeNull();
    const first = useCanvasStore.getState().nodes.find((n) => n.id === orphanIds[0]);
    expect(first?.parentId).toBeUndefined();
    expect(first?.position.x).toBe(baseX + GROUP_ABS.x);
  });

  it("普通组：仍把派生节点收编为成员，且不加组绝对位移（保持组内相对坐标语义）", () => {
    // 普通组：user_spawned:true 且无 projection_key、非分镜组。
    const { videoId, groupId, orphanIds } = seedGroupedVideoWithOrphans({
      user_spawned: true,
    });

    const result = useCanvasStore.getState().autoGroupSpawn(videoId, orphanIds, {
      label: "外部素材组",
    });

    // 普通组正常收编，返回组 id。
    expect(result).toBe(groupId);
    const first = useCanvasStore.getState().nodes.find((n) => n.id === orphanIds[0]);
    expect(first?.parentId).toBe(groupId);
    // 收进同一父组后坐标本就是组内相对坐标：绝不像受保护/分镜分支那样加上组绝对
    // 位移（否则会落到 baseX + 1000 附近）。fitGroupToChildren 可能把成员向内推，
    // 所以只断言仍是「小的相对坐标」，而非精确值。
    expect(first?.position.x).toBeLessThan(GROUP_ABS.x);
  });
});
