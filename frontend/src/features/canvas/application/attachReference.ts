// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 把一个画布节点挂成某个节点的参考（= 一条上游连线），失败时说明原因。
 *
 * canvasStore.addEdge 只回 null 不讲理由，而「视频素材超上限」是这里唯一需要、也
 * 唯一说得出话的拒绝原因。参考的入口不止一个（拾取态点选、提示词里的替换选单），
 * 它们对失败必须给同一句话——静默无反应是最糟的那种「坏了」。
 */
import { toast } from 'sonner';

import { videoReferenceConnectionRejection } from '@/features/canvas/domain/videoReferenceLimits';
import { videoReferenceEnvelopeForNode } from '@/features/canvas/application/videoReferenceEnvelope';
import { useCanvasStore } from '@/stores/canvasStore';

/** 建边成功返回 true；失败时已经弹过 toast。 */
export function attachReferenceEdge(sourceNodeId: string, targetNodeId: string): boolean {
  const store = useCanvasStore.getState();
  if (store.addEdge(sourceNodeId, targetNodeId)) return true;
  const rejection = videoReferenceConnectionRejection(
    store.nodes,
    store.edges,
    { source: sourceNodeId, target: targetNodeId },
    videoReferenceEnvelopeForNode,
  );
  toast.error(rejection ?? '这个节点不能作为参考');
  return false;
}
