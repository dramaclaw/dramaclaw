// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  videoReferenceEnvelopeForModel,
  type VideoReferenceEnvelope,
} from '@/features/canvas/domain/videoReferenceLimits';
import { readFreezoneVideoModels } from '@/features/canvas/hooks/useFreezoneVideoModels';
import type { ModelOption } from '@/features/canvas/ui/ProviderModelPicker';

/**
 * 把一个视频节点解析成它**当前所选模型**的引用上限包络。
 *
 * 建边校验（Canvas 的 isValidConnection、canvasStore 的 onConnect/addEdge）跑在 React
 * 之外，拿不到 useFreezoneVideoModels 的返回值，所以这里从同一个 module-level store
 * 直接读目录。domain 层保持纯函数、只接受算好的包络，解析这件事放在 application 层。
 *
 * 兜底口径必须和 VideoNode 的 `selectedVideoModel` 一致：`data.model` 没存或在目录里
 * 找不到时，用列表第一个模型 —— 那正是 ProviderModelPicker 显示、提交时也会用的那个。
 * 两边不一致的话，会出现「界面显示 A 模型的上限、建边按 B 模型拦」。
 *
 * models 参数只为测试注入目录用，生产代码不要传。
 */
export function videoReferenceEnvelopeForNode(
  videoNode: CanvasNode,
  models: ModelOption[] = readFreezoneVideoModels(),
): VideoReferenceEnvelope {
  const persisted =
    typeof videoNode.data?.model === 'string' && videoNode.data.model.length > 0
      ? videoNode.data.model
      : null;
  const model =
    (persisted ? models.find((entry) => entry.id === persisted) : undefined) ??
    models[0];
  return videoReferenceEnvelopeForModel(model);
}
