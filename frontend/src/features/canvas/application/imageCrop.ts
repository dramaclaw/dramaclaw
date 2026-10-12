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
 * 「裁剪」的编排层。与 imageRotate 是同一族（本地 canvas 变换 → 上传 → 写回一个
 * **预建的结果节点**，源图始终不动），差别只在变换本身：旋转扩画布，裁剪取子矩形。
 *
 * 纯本地运算，不走生成接口——所以没有算力消耗，也没有任务轮询。
 */

/** 裁剪框，单位是源图的**自然像素**（不是显示像素，也不是归一化比例）。 */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 裁剪比例选项（顺序即下拉里的顺序，对齐 liblib）。`original` 是**原图比例**——
 * 锁成源图自己的宽高比，不是自由裁剪；取景框始终锁比例，用户只调大小和位置。
 */
export const CROP_ASPECT_OPTIONS = ['original', '1:1', '4:3', '3:4', '16:9', '9:16'] as const;
export type CropAspectOption = (typeof CROP_ASPECT_OPTIONS)[number];

/**
 * 比例选项 → 宽/高数值。`original` 取源图自身比例，所以必须把自然尺寸传进来。
 * 尺寸还没量到（图未加载）时返回 null，调用方据此先不摆取景框。
 */
export function resolveCropAspectRatio(
  option: CropAspectOption,
  natural: { width: number; height: number },
): number | null {
  if (option === 'original') {
    return natural.width > 0 && natural.height > 0 ? natural.width / natural.height : null;
  }
  const [w, h] = option.split(':').map(Number);
  return w > 0 && h > 0 ? w / h : null;
}

/** 给定比例下、能塞进整张图的最大居中矩形——切换比例时取景框就复位到这里。 */
export function maxCenteredCropRect(
  natural: { width: number; height: number },
  ratio: number,
): CropRect {
  let width = natural.width;
  let height = width / ratio;
  if (height > natural.height) {
    height = natural.height;
    width = height * ratio;
  }
  return {
    x: (natural.width - width) / 2,
    y: (natural.height - height) / 2,
    width,
    height,
  };
}

/**
 * 裁剪框是否等同于「整张图」。用户没拖动过取景框就按「确认」时据此走「未提交」
 * 路径：不必上传一张和原图逐像素相同的新图，也不该凭空留下一个结果节点。
 *
 * 容差 1px：取景框是按显示像素拖出来的，换算回自然像素后常有亚像素误差。
 */
export function isFullFrameCrop(rect: CropRect, natural: { width: number; height: number }): boolean {
  return (
    rect.x <= 1
    && rect.y <= 1
    && rect.width >= natural.width - 1
    && rect.height >= natural.height - 1
  );
}

/**
 * 预建「裁剪结果」节点（与 createRotateResultNode 同构）：在源图片节点下游建一个
 * 以源图为预览的 exportImage 节点并连边——裁剪对这个新节点原地写回，源图保持不动。
 *
 * @returns 新建结果节点 id；源节点不存在 / 类型不支持 / 无图源时返回 null。
 */
export function createCropResultNode(
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
 * 丢弃预建的「裁剪结果」节点：用户退出 / 按 Esc / 没框选任何区域就确认时调用，
 * 否则会凭空多出一个节点（同 discardRotateResultNode）。
 */
export function discardCropResultNode(nodeId: string): void {
  useCanvasStore.getState().deleteNode(nodeId);
}

/**
 * 按裁剪框切图并原地写回结果节点：本地 canvas `drawImage` 取子矩形 → 上传 PNG →
 * 把新 url / 新 aspectRatio 写回该节点；失败把错误写到该节点。
 *
 * @param rect 自然像素坐标的裁剪框；越界部分会被夹回图内（拖拽已限制在图内，
 *   这里只是防御性收口，避免 drawImage 画出透明边）。
 * @returns 后台链 settle 时 resolve 的 Promise（不 reject）；缺 project 时不落
 *   任何状态、返回 null（调用方可据此保留编辑态或回收预建节点）。
 */
export function cropImageInPlace(
  nodeId: string,
  imageSource: string,
  rect: CropRect,
): Promise<void> | null {
  const project = readUrl().project;
  if (!project) {
    console.error('[crop] no project in URL — cannot persist result');
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
      const sx = Math.max(0, Math.min(Math.round(rect.x), image.naturalWidth - 1));
      const sy = Math.max(0, Math.min(Math.round(rect.y), image.naturalHeight - 1));
      const sw = Math.max(1, Math.min(Math.round(rect.width), image.naturalWidth - sx));
      const sh = Math.max(1, Math.min(Math.round(rect.height), image.naturalHeight - sy));

      const canvas = document.createElement('canvas');
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2d context unavailable');
      ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);

      const blob: Blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))),
          'image/png',
        );
      });

      const filename = `crop-${nodeId}-${Date.now()}.png`;
      const uploaded = await uploadFreezoneImage(project, blob, filename);

      useCanvasStore.getState().updateNodeData(nodeId, {
        imageUrl: uploaded.url,
        previewImageUrl: uploaded.url,
        aspectRatio: `${sw}:${sh}`,
        isGenerating: false,
        generationStartedAt: null,
        generationError: null,
        generationErrorDetails: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[crop] save failed', err);
      useCanvasStore.getState().updateNodeData(nodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: message,
        generationErrorDetails: message,
      });
    }
  })();
}
