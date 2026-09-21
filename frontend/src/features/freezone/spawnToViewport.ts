// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 「把素材放到视口中心」这套计算。
 *
 * 原本是 AssetLibraryPanel 的私有函数。Blender 收件箱的自动认领要用完全同一套
 * 落点和尺寸逻辑——抄一份必然发散，所以搬出来两边共用。搬家时一行逻辑都没改。
 */
import {
  DEFAULT_NODE_WIDTH,
  EXPORT_RESULT_NODE_MIN_HEIGHT,
  EXPORT_RESULT_NODE_MIN_WIDTH,
} from "@/features/canvas/domain/canvasNodes";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import {
  aspectRatioFromImageDimensions,
  resolveMinEdgeFittedSize,
} from "@/features/canvas/application/imageNodeSizing";
import type { CanvasAssetDragPayload } from "@/features/canvas/domain/assetDrag";
import { useCanvasStore } from "@/stores/canvasStore";

export function viewportCenteredPosition(
  store: ReturnType<typeof useCanvasStore.getState>,
  index: number,
  nodeWidth: number,
  nodeHeight: number,
): { x: number; y: number } {
  const { width: viewportWidth, height: viewportHeight } = store.canvasViewportSize;
  if (viewportWidth <= 0 || viewportHeight <= 0) {
    const fallbackCol = index % 2;
    const fallbackRow = Math.floor(index / 2);
    return {
      x: -720 + fallbackCol * (nodeWidth + 28),
      y: 120 + fallbackRow * 260,
    };
  }
  const zoom = Math.max(0.01, store.currentViewport.zoom || 1);
  const cx = -store.currentViewport.x / zoom + viewportWidth / (2 * zoom);
  const cy = -store.currentViewport.y / zoom + viewportHeight / (2 * zoom);
  const col = index % 4;
  const row = Math.floor(index / 4) % 4;
  const offsetX = (col - 1.5) * 24;
  const offsetY = (row - 1.5) * 24;
  const baseX = cx - nodeWidth / 2 + offsetX;
  const baseY = cy - nodeHeight / 2 + offsetY;
  const collides = (x: number, y: number): boolean => {
    const margin = 8;
    return store.nodes.some((node) => {
      const nw = node.measured?.width ?? DEFAULT_NODE_WIDTH;
      const nh = node.measured?.height ?? 200;
      return (
        x < node.position.x + nw + margin &&
        x + nodeWidth + margin > node.position.x &&
        y < node.position.y + nh + margin &&
        y + nodeHeight + margin > node.position.y
      );
    });
  };
  if (!collides(baseX, baseY)) {
    return { x: baseX, y: baseY };
  }
  const stepX = Math.max(nodeWidth + 16, 120);
  const stepY = Math.max(Math.round(nodeHeight * 0.35), 60);
  for (let ring = 1; ring <= 10; ring += 1) {
    const ringOffsets = [
      [ring, 0], [-ring, 0], [0, ring], [0, -ring],
      [ring, 1], [ring, -1], [-ring, 1], [-ring, -1],
      [1, ring], [-1, ring], [1, -ring], [-1, -ring],
      [ring, ring], [-ring, -ring], [ring, -ring], [-ring, ring],
    ];
    for (const [dx, dy] of ringOffsets) {
      const x = baseX + dx * stepX;
      const y = baseY + dy * stepY;
      if (!collides(x, y)) return { x, y };
    }
  }
  return { x: baseX, y: baseY };
}

/**
 * 量素材的真实宽高比，给不出就返回 null。
 *
 * 资产库的条目只存了 URL，没有尺寸；不带 aspectRatio 建出来的图片/视频节点一律
 * 按 1:1 铺开，宽图就会上下留两条黑边（节点内是 object-contain）。
 *
 * 加载失败或太慢都当量不出来处理——发到画布不该被一张坏图卡住。
 */
export function measureAspectRatio(payload: CanvasAssetDragPayload): Promise<string | null> {
  if (payload.kind !== "image" && payload.kind !== "video") return Promise.resolve(null);
  if (typeof document === "undefined") return Promise.resolve(null);
  const src = resolveImageDisplayUrl(payload.url);
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(value);
    };
    const timer = window.setTimeout(() => done(null), 4000);

    if (payload.kind === "image") {
      const image = new Image();
      image.onload = () =>
        done(aspectRatioFromImageDimensions(image.naturalWidth, image.naturalHeight));
      image.onerror = () => done(null);
      image.src = src;
      return;
    }

    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () =>
      done(aspectRatioFromImageDimensions(video.videoWidth, video.videoHeight));
    video.onerror = () => done(null);
    video.src = src;
  });
}

/**
 * 节点建出来大概多大——只用来排网格，不写进节点。
 *
 * 图片节点的尺寸跟着比例走（最小短边 300），视频和音频节点是各自组件里的固定
 * 尺寸，这里跟着写一份常量即可：排版差几像素没关系，别让节点压在一起就行。
 */
export function spawnedNodeSize(payload: CanvasAssetDragPayload): { width: number; height: number } {
  if (payload.kind === "audio") return { width: 480, height: 210 };
  if (payload.kind === "video") return { width: 580, height: 380 };
  return resolveMinEdgeFittedSize(payload.aspectRatio || "1:1", {
    minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
    minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
  });
}
