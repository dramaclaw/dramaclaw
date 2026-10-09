// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  CANVAS_NODE_TYPES,
  type VideoNodeData,
} from '@/features/canvas/domain/canvasNodes';
import type { AssetLibrarySelection } from '@/features/canvas/ui/AssetLibraryModal';
import { useCanvasStore } from '@/stores/canvasStore';

/** 目标节点没有量到的高度时的兜底（= ImageGenNode 的 DEFAULT_HEIGHT）。 */
const FALLBACK_TARGET_HEIGHT = 360;
/** 同上，视频侧（= VideoNode 的 DEFAULT_HEIGHT）。 */
const FALLBACK_VIDEO_TARGET_HEIGHT = 380;
const UPLOAD_WIDTH = 320;
const UPLOAD_HEIGHT = 240;
const GAP_X = 40;
const GAP_Y = 24;

/** 竖排摞在目标节点左侧的第 idx 个参考节点的落点。 */
function stackedSpawnPositions(
  target: { position: { x: number; y: number }; height?: number | null },
  count: number,
  fallbackHeight: number,
): { baseX: number; startY: number } {
  const baseX = target.position.x - UPLOAD_WIDTH - GAP_X;
  const totalH = UPLOAD_HEIGHT * count + GAP_Y * (count - 1);
  const startY =
    target.position.y + ((target.height ?? fallbackHeight) - totalH) / 2;
  return { baseX, startY };
}

/**
 * 从资产库选中的图片生成上游 upload 参考节点：每选一张建一个 upload 节点，竖排
 * 摞在目标节点左侧，再连线到目标节点作为参考图（多图参考直接进 reference_urls）。
 *
 * 全程只碰 canvasStore（无 React Flow 上下文），因此工作流节点（ImageGenNode）与
 * 故事板详情里的生成表单可以共用同一份编排——两处「资产库」chip 的行为完全一致。
 */
export function spawnAssetLibraryReferences(
  targetNodeId: string,
  selections: ReadonlyArray<AssetLibrarySelection>,
): void {
  const imageSelections = selections.filter((sel) => sel.media === 'image');
  if (imageSelections.length === 0) return;
  const state = useCanvasStore.getState();
  const self = state.nodes.find((n) => n.id === targetNodeId);
  if (!self) return;
  const { baseX, startY } = stackedSpawnPositions(
    self,
    imageSelections.length,
    FALLBACK_TARGET_HEIGHT,
  );
  const newIds: string[] = [];
  imageSelections.forEach((sel, idx) => {
    const y = startY + idx * (UPLOAD_HEIGHT + GAP_Y);
    const newId = state.addNode(
      CANVAS_NODE_TYPES.upload,
      { x: baseX, y },
      {
        imageUrl: sel.url,
        previewImageUrl: sel.url,
        displayName: sel.name || undefined,
      },
    );
    state.addEdge(newId, targetNodeId);
    newIds.push(newId);
  });
  state.autoGroupSpawn(targetNodeId, newIds, { label: '资产参考组' });
}

/**
 * 视频节点版：资产库三类素材都收，按媒体类型建不同的上游节点——
 * - 图片 → upload 节点（imageUrl）；
 * - 视频 → `referenceOnly` 的 video 节点（能播放本体、被 isVideoNode 识别，
 *   下游据此自动切 videoEdit；早期建的 upload 节点塞 videoUrl 既不显示也不被识别）；
 * - 音频 → audio 节点（audioUrl）。
 *
 * 与图片版同样只碰 canvasStore（无 React Flow 上下文），故工作流的 VideoNode 与
 * 故事板详情的视频生成表单共用这一份编排，两处「资产库」chip 行为完全一致。
 */
export function spawnVideoAssetLibraryReferences(
  targetNodeId: string,
  selections: ReadonlyArray<AssetLibrarySelection>,
): void {
  if (selections.length === 0) return;
  const state = useCanvasStore.getState();
  const self = state.nodes.find((n) => n.id === targetNodeId);
  if (!self) return;
  // 新建的引用视频节点继承目标节点的比例，避免播放器按默认比例把素材裁歪。
  const aspectRatio = (self.data as { aspectRatio?: unknown }).aspectRatio;
  const { baseX, startY } = stackedSpawnPositions(
    self,
    selections.length,
    FALLBACK_VIDEO_TARGET_HEIGHT,
  );
  const newIds: string[] = [];
  selections.forEach((sel, idx) => {
    const y = startY + idx * (UPLOAD_HEIGHT + GAP_Y);
    const displayName = sel.name || undefined;
    let newId: string;
    if (sel.media === 'audio') {
      newId = state.addNode(
        CANVAS_NODE_TYPES.audio,
        { x: baseX, y },
        { audioUrl: sel.url, displayName },
      );
    } else if (sel.media === 'video') {
      newId = state.addNode(
        CANVAS_NODE_TYPES.video,
        { x: baseX, y },
        {
          videoUrl: sel.url,
          aspectRatio,
          displayName,
          referenceOnly: true,
        } as Partial<VideoNodeData>,
      );
    } else {
      newId = state.addNode(
        CANVAS_NODE_TYPES.upload,
        { x: baseX, y },
        { imageUrl: sel.url, previewImageUrl: sel.url, displayName },
      );
    }
    state.addEdge(newId, targetNodeId);
    newIds.push(newId);
  });
  state.autoGroupSpawn(targetNodeId, newIds, { label: '资产参考组' });
}
