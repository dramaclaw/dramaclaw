// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from "vitest";

import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { resolveAbsolutePosition, useCanvasStore } from "@/stores/canvasStore";

/** 用当前 store 的节点算某节点的绝对坐标（走父链累加，对新建的素材组同样成立）。 */
function absolutePositionOf(nodeId: string) {
  const nodes = useCanvasStore.getState().nodes;
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`节点不存在：${nodeId}`);
  return resolveAbsolutePosition(node, new Map(nodes.map((n) => [n.id, n] as const)));
}

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

  it("受保护投影组：源不入组，但把派生素材平移回绝对坐标后另编成一个根层素材组", () => {
    // user_spawned 不为 true + 有 projection_key → 受保护投影组。
    const { videoId, groupId, orphanIds } = seedGroupedVideoWithOrphans({
      projection_key: "proj-a",
    });

    const result = useCanvasStore.getState().autoGroupSpawn(videoId, orphanIds, {
      label: "外部素材组",
    });

    // 无法把源挪出受保护组，但素材（≥2 个）会另成一个新的根层素材组。
    expect(result).not.toBeNull();
    expect(result).not.toBe(groupId); // 不是原受保护投影组

    const state = useCanvasStore.getState();
    const assetGroup = state.nodes.find((n) => n.id === result);
    expect(assetGroup?.type).toBe(CANVAS_NODE_TYPES.group);
    // 新素材组是根层节点（没有被塞进受保护投影组）。
    expect(assetGroup?.parentId).toBeUndefined();

    orphanIds.forEach((orphanId, idx) => {
      const node = state.nodes.find((n) => n.id === orphanId);
      expect(node).toBeDefined();
      // 素材被收进新的根层素材组。
      expect(node?.parentId).toBe(result);
      // 关键回归：绝对坐标落在视频身边（组绝对位移已补偿），而不是「相对值当绝对
      // 坐标」的画布左上角。组内相对坐标随新组原点变化，所以只断言绝对坐标。
      expect(absolutePositionOf(orphanId)).toEqual({
        x: baseX + GROUP_ABS.x, // -300 + 1000 = 700
        y: VIDEO_REL.y + idx * ORPHAN_GAP_Y + GROUP_ABS.y, // 540 / 800
      });
    });
  });

  it("分镜组：源同样不入组，派生素材修正到绝对坐标后另编成根层素材组", () => {
    const { videoId, groupId, orphanIds } = seedGroupedVideoWithOrphans({
      storyboardGroup: true,
    });

    const result = useCanvasStore.getState().autoGroupSpawn(videoId, orphanIds, {
      label: "外部素材组",
    });

    expect(result).not.toBeNull();
    expect(result).not.toBe(groupId);
    const first = useCanvasStore.getState().nodes.find((n) => n.id === orphanIds[0]);
    expect(first?.parentId).toBe(result);
    expect(absolutePositionOf(orphanIds[0])).toEqual({
      x: baseX + GROUP_ABS.x,
      y: VIDEO_REL.y + GROUP_ABS.y,
    });
  });

  it("受保护投影组 + 只有一个派生素材：成不了组（<2 成员），素材保持独立根节点但坐标已修正", () => {
    const { videoId, orphanIds } = seedGroupedVideoWithOrphans({
      projection_key: "proj-a",
    });
    const singleOrphan = orphanIds[0];

    const result = useCanvasStore.getState().autoGroupSpawn(videoId, [singleOrphan], {
      label: "外部素材组",
    });

    // groupNodes 要求 ≥2 个成员，单个素材成不了组 → 返回 null，保持独立根节点。
    expect(result).toBeNull();
    const node = useCanvasStore.getState().nodes.find((n) => n.id === singleOrphan);
    expect(node?.parentId).toBeUndefined();
    // 但坐标仍被修正到绝对坐标，不会落到画布左上角。
    expect(absolutePositionOf(singleOrphan)).toEqual({
      x: baseX + GROUP_ABS.x,
      y: VIDEO_REL.y + GROUP_ABS.y,
    });
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
