// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { TaskCompletionError } from '@/api/tasks';

type NodeGenerationData = Record<string, unknown>;

const GENERATED_MEDIA_FIELDS = [
  'imageUrl',
  'previewImageUrl',
  'videoUrl',
  'resultVideoUrl',
  'audioUrl',
] as const;

// 失败横幅是绝对定位盖在图上的（见 ImageGenNode 的错误浮层），只要节点上换了一张
// 新图却没清这三个字段，上一次的「生成失败 / 请求 ID / 重新生成」就会继续糊在新图
// 上面。任何原地写 imageUrl / previewImageUrl / referenceImageUrl 的路径都要带上它。
export const GENERATION_ERROR_CLEARED_PATCH = {
  generationError: null,
  generationErrorDetails: null,
  generationErrorRequestId: null,
} as const;

export function buildImageGenerationSuccessPatch(url: string): Record<string, unknown> {
  return {
    imageUrl: url,
    previewImageUrl: url,
    isGenerating: false,
    generationStartedAt: null,
    ...GENERATION_ERROR_CLEARED_PATCH,
  };
}

export function isTaskCancelledError(error: unknown): boolean {
  return error instanceof TaskCompletionError && error.status === 'cancelled';
}

function nodeHasGeneratedMedia(nodeData: NodeGenerationData): boolean {
  return GENERATED_MEDIA_FIELDS.some((field) => {
    const value = nodeData[field];
    return typeof value === 'string' && value.length > 0;
  });
}

export function hasGeneratedMedia(nodeData: NodeGenerationData): boolean {
  return nodeHasGeneratedMedia(nodeData);
}

function registeredTaskKey(nodeData: NodeGenerationData): string {
  const value = nodeData.generationTaskKey;
  return typeof value === 'string' ? value : '';
}

export function isStaleGenerationTask({
  nodeData,
  taskKey,
}: {
  nodeData: NodeGenerationData;
  taskKey: string;
}): boolean {
  const currentTaskKey = registeredTaskKey(nodeData);
  return currentTaskKey.length > 0 && currentTaskKey !== taskKey;
}

export function shouldWriteGenerationError({
  nodeData,
  taskKey,
  error,
}: {
  nodeData: NodeGenerationData;
  taskKey: string;
  error: unknown;
}): boolean {
  if (isStaleGenerationTask({ nodeData, taskKey })) {
    return false;
  }

  if (isTaskCancelledError(error) && nodeHasGeneratedMedia(nodeData)) {
    return false;
  }

  return true;
}
