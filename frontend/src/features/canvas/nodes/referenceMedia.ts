// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  isExportImageNode,
  isImageEditNode,
  isImageGenNode,
  isStoryboardGenNode,
  isUploadNode,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';

/**
 * 上游「图片引用」的取图规则（原 VideoNode 私有 helper，抽到共享模块供故事板
 * 详情的 @图片N chip 复用——编号与取图必须与工作流同一份规则，否则 chip 会指到
 * 另一张图）。
 */
export function referenceImageUrl(node: CanvasNode | undefined | null): string | null {
  if (!node) return null;
  if (isImageGenNode(node)) {
    const data = node.data;
    // imageGen 上传给生图用的「参考图」会写到 data.referenceImageUrl；
    // 在 imageGen 自身还没生成结果之前，它就是该节点对外呈现的图片，
    // 视频节点也应该把它当成上游图引用。
    const ref =
      typeof data.referenceImageUrl === 'string' && data.referenceImageUrl.length > 0
        ? data.referenceImageUrl
        : null;
    return data.previewImageUrl || data.imageUrl || ref;
  }
  if (
    isUploadNode(node) ||
    isImageEditNode(node) ||
    isExportImageNode(node) ||
    isStoryboardGenNode(node)
  ) {
    const data = node.data;
    return data.previewImageUrl || data.imageUrl || null;
  }
  return null;
}

/**
 * 上游「视频引用」：视频节点自带 videoUrl，但从资产库选入的视频是 upload 节点，
 * 地址同样写在 data.videoUrl。所以「是不是视频上游」应按「存在非空 data.videoUrl」
 * 判定，而非节点类型——否则资产库视频会被漏认（HappyHorse 不自动切 videoEdit、
 * 提交找不到 videoUrl），还会被 referenceImageUrl / isUploadNode 误当图片。
 */
export function referenceVideoUrl(node: CanvasNode | undefined | null): string | null {
  if (!node) return null;
  const url = (node.data as { videoUrl?: unknown }).videoUrl;
  return typeof url === 'string' && url.length > 0 ? url : null;
}
