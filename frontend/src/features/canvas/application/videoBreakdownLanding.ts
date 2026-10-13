// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 逐帧拉片的两处「跨节点写入」：拾取素材、落地产出。
//
// 都从组件里搬出来，因为两处都要在 await 之后动别人的节点 —— 这类写入的正确性
// 取决于「此刻画布长什么样」，而不是组件闭包捕获的那一瞬间，放在组件里既难测也
// 容易漏掉节点已被删除的情况。

import { useCanvasStore } from '@/stores/canvasStore';
import type {
  PlanVideoBreakdownGroupsOptions,
  VideoBreakdownResultLike,
} from '@/features/canvas/application/videoBreakdownGroups';

/**
 * 把画布上选中的视频接到拉片节点上。
 *
 * 素材来源的唯一事实是那根上游边 —— 拉片节点取值时上游边优先、`data.sourceVideoUrl`
 * 兜底，所以连上边之后必须把兜底字段清干净：留着旧值，用户断开边想换源时节点还捏着
 * 上一份 URL 照跑不误，「断开边退回空态」就成了空话。
 *
 * 只有建边被收口规则拒掉（返回 null）时才退而求其次抄一份 URL —— 那种情况下不抄，
 * 用户点完「从画布选择」会什么都没发生。
 *
 * @returns 是否连上了边（false = 走了抄 URL 的兜底路径）
 */
export function commitVideoPickToNode({
  sourceNodeId,
  requesterNodeId,
  videoUrl,
  label,
}: {
  sourceNodeId: string;
  requesterNodeId: string;
  videoUrl: string;
  label: string | null;
}): boolean {
  const store = useCanvasStore.getState();
  const edgeId = store.addEdge(sourceNodeId, requesterNodeId);

  store.updateNodeData(
    requesterNodeId,
    edgeId
      ? { sourceVideoUrl: null, sourceFileName: null, sourceNodeId: null }
      : { sourceVideoUrl: videoUrl, sourceFileName: label, sourceNodeId },
  );

  return edgeId !== null;
}

export type VideoBreakdownLandingOutcome = 'ok' | 'node-gone' | 'empty';

/**
 * 把一次拉片的产出落到画布上。
 *
 * 拉片一趟要几分钟，等结果期间用户把节点删掉是很正常的操作。那种情况下
 * `addVideoBreakdownGroups` 找不到源节点同样返回 null，和「任务成功但三个维度
 * 零产出」撞在一起 —— 分不开的话，用户自己删的节点会换来一个「拉片没有任何产出」
 * 的错误提示。所以先查节点在不在，把两种情况拆成两个结果。
 */
export function landVideoBreakdownResult({
  nodeId,
  result,
  labels,
}: {
  nodeId: string;
  result: VideoBreakdownResultLike;
  labels: Omit<PlanVideoBreakdownGroupsOptions, 'origin'>;
}): VideoBreakdownLandingOutcome {
  const store = useCanvasStore.getState();
  if (!store.nodes.some((node) => node.id === nodeId)) {
    return 'node-gone';
  }

  const groupIds = store.addVideoBreakdownGroups(nodeId, result, labels);
  return groupIds && groupIds.length > 0 ? 'ok' : 'empty';
}
