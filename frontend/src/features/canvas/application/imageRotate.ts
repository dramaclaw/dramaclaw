// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { uploadFreezoneImage } from '@/api/ops';
import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  isExportImageNode,
  isImageEditNode,
  isImageGenNode,
  isUploadNode,
  resolveNodeSourceImageUrl,
} from '@/features/canvas/domain/canvasNodes';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { loadImageElement } from './imageData';

/**
 * 预建「旋转结果」节点（从 SelectedNodeOverlay.handleOpenRotate 原样搬出，语义
 * 零变化）：在源图片节点下游建一个以源图为预览的 exportImage 节点并连边——旋转
 * 是对这个新节点原地写回（RotateEditorOverlay / 详情平面行随后对它调
 * {@link rotateImageInPlace}），源图保持不动。
 *
 * @returns 新建结果节点 id；源节点不存在 / 类型不支持 / 无图源时返回 null。
 */
export function createRotateResultNode(
  sourceNodeId: string,
  opts: { displayName: string },
): string | null {
  const store = useCanvasStore.getState();
  const sourceNode = store.nodes.find((candidate) => candidate.id === sourceNodeId);
  if (!sourceNode) {
    return null;
  }
  if (
    !isUploadNode(sourceNode)
    && !isImageEditNode(sourceNode)
    && !isImageGenNode(sourceNode)
    && !isExportImageNode(sourceNode)
  ) {
    return null;
  }
  const sourceImageUrl = resolveNodeSourceImageUrl(sourceNode);
  if (!sourceImageUrl) {
    return null;
  }

  const sourceAspectRatio =
    typeof (sourceNode.data as { aspectRatio?: unknown }).aspectRatio === 'string'
      ? ((sourceNode.data as { aspectRatio?: string }).aspectRatio ?? DEFAULT_ASPECT_RATIO)
      : DEFAULT_ASPECT_RATIO;
  const position = store.findNodePosition(
    sourceNode.id,
    EXPORT_RESULT_NODE_DEFAULT_WIDTH,
    EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  );
  const newNodeId = store.addNode(
    CANVAS_NODE_TYPES.exportImage,
    position,
    {
      displayName: opts.displayName,
      imageUrl: null,
      previewImageUrl: sourceImageUrl,
      aspectRatio: sourceAspectRatio,
      resultKind: 'generic',
      isGenerating: false,
    } as unknown as Parameters<typeof store.addNode>[2],
  );
  store.addEdge(sourceNode.id, newNodeId);
  return newNodeId;
}

/**
 * 丢弃预建的「旋转结果」节点（预建 / 取消删除生命周期的函数化）：用户退出 /
 * 按 Esc / 未做任何变换就关闭时调用，否则会凭空多出一个节点。
 */
export function discardRotateResultNode(nodeId: string): void {
  useCanvasStore.getState().deleteNode(nodeId);
}

export interface RotateTransform {
  /** 旋转角度（度，0-360，顺时针）。 */
  angleDeg: number;
  mirrorH: boolean;
  mirrorV: boolean;
}

/** 无任何变换（角度 0 且无镜像）——调用方据此走「未提交」关闭路径。 */
export function isIdentityRotateTransform(transform: RotateTransform): boolean {
  return transform.angleDeg === 0 && !transform.mirrorH && !transform.mirrorV;
}

/**
 * 旋转 / 镜像并原地写回（从 RotateEditorOverlay.handleSave 原样搬出，语义零变化）：
 * 本地 canvas 旋转（画布扩大到能容纳任意角度的四角）→ 上传 PNG →
 * 把新 url / 新 aspectRatio 原地写回该节点；失败把错误写到该节点。
 *
 * @returns 后台链 settle 时 resolve 的 Promise（不 reject）；缺 project 时不落
 *   任何状态、返回 null（调用方可据此保留编辑态或回收预建节点）。
 */
export function rotateImageInPlace(
  nodeId: string,
  imageSource: string,
  transform: RotateTransform,
): Promise<void> | null {
  const project = readUrl().project;
  if (!project) {
    console.error('[rotate] no project in URL — cannot persist result');
    return null;
  }

  useCanvasStore.getState().updateNodeData(nodeId, {
    isGenerating: true,
    generationStartedAt: Date.now(),
    generationError: null,
    generationErrorDetails: null,
  });

  return (async () => {
    try {
      const image = await loadImageElement(imageSource);
      const sw = image.naturalWidth;
      const sh = image.naturalHeight;

      // 旋转后的画布需要包含图片所有四角（任意角度）。
      const rad = (transform.angleDeg * Math.PI) / 180;
      const cos = Math.abs(Math.cos(rad));
      const sin = Math.abs(Math.sin(rad));
      const dw = Math.max(1, Math.round(sw * cos + sh * sin));
      const dh = Math.max(1, Math.round(sw * sin + sh * cos));

      const canvas = document.createElement('canvas');
      canvas.width = dw;
      canvas.height = dh;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2d context unavailable');

      ctx.translate(dw / 2, dh / 2);
      ctx.rotate(rad);
      ctx.scale(transform.mirrorH ? -1 : 1, transform.mirrorV ? -1 : 1);
      ctx.drawImage(image, -sw / 2, -sh / 2);

      const blob: Blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))),
          'image/png',
        );
      });

      const filename = `rotate-${nodeId}-${Date.now()}.png`;
      const uploaded = await uploadFreezoneImage(project, blob, filename);

      const newAspectRatio = `${dw}:${dh}`;
      useCanvasStore.getState().updateNodeData(nodeId, {
        imageUrl: uploaded.url,
        previewImageUrl: uploaded.url,
        aspectRatio: newAspectRatio,
        isGenerating: false,
        generationStartedAt: null,
        generationError: null,
        generationErrorDetails: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[rotate] save failed', err);
      useCanvasStore.getState().updateNodeData(nodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: message,
        generationErrorDetails: message,
      });
    }
  })();
}
