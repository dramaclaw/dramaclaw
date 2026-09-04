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
// 这里取的是 i18next 默认实例（`@/i18n` 初始化的就是它）。不 import `@/i18n`
// 本身，是因为那个模块会顺带拉进 react-i18next / HttpBackend，把它塞进这条被
// 到处 import 的底层链路上，会让所有 mock 掉 react-i18next 的测试在 import 期炸掉。
import i18n from 'i18next';

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
  toast.error(rejection ?? i18n.t('canvas.referencePick.rejectGeneric'));
  return false;
}
