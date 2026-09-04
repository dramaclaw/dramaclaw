// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  NODE_TOOL_TYPES,
  isExportImageNode,
  isImageEditNode,
  isImageGenNode,
  isUploadNode,
  resolveNodeSourceImageUrl,
  type CanvasNode,
} from '../domain/canvasNodes';
import { stringifyAnnotationItems } from './annotation';
import type { CanvasToolPlugin } from './types';

// imageGen 也算图片源节点：上传的参考图同样可被裁剪 / 标注 / 分格抽取，
// 结果会落到新建的下游节点，不会覆盖参考图本身。
function supportsImageSourceNode(node: CanvasNode): boolean {
  return (
    isUploadNode(node) ||
    isImageEditNode(node) ||
    isExportImageNode(node) ||
    isImageGenNode(node)
  );
}

function hasToolableImage(node: CanvasNode): boolean {
  return supportsImageSourceNode(node) && Boolean(resolveNodeSourceImageUrl(node));
}

export const cropToolPlugin: CanvasToolPlugin = {
  type: NODE_TOOL_TYPES.crop,
  labelKey: 'canvas.tools.crop',
  icon: 'crop',
  editor: 'crop',
  supportsNode: (node) => hasToolableImage(node),
  createInitialOptions: () => ({
    aspectRatio: 'free',
    customAspectRatio: '',
  }),
  fields: [
    {
      key: 'aspectRatio',
      labelKey: 'canvas.cropTool.targetRatio',
      type: 'select',
      options: [
        { labelKey: 'canvas.cropTool.ratioFree', value: 'free' },
        { label: '1:1', value: '1:1' },
        { label: '16:9', value: '16:9' },
        { label: '9:16', value: '9:16' },
        { label: '4:3', value: '4:3' },
        { label: '3:4', value: '3:4' },
      ],
    },
  ],
  execute: async (sourceImageUrl, options, context) =>
    await context.processTool(NODE_TOOL_TYPES.crop, sourceImageUrl, options),
};

export const annotateToolPlugin: CanvasToolPlugin = {
  type: NODE_TOOL_TYPES.annotate,
  labelKey: 'canvas.tools.annotate',
  icon: 'annotate',
  editor: 'annotate',
  supportsNode: (node) => hasToolableImage(node),
  createInitialOptions: () => ({
    color: '#ff4d4f',
    lineWidthPercent: 0.4,
    fontSizePercent: 10,
    annotations: stringifyAnnotationItems([]),
  }),
  fields: [],
  execute: async (sourceImageUrl, options, context) =>
    await context.processTool(NODE_TOOL_TYPES.annotate, sourceImageUrl, options),
};

export const splitStoryboardToolPlugin: CanvasToolPlugin = {
  type: NODE_TOOL_TYPES.splitStoryboard,
  labelKey: 'canvas.tools.splitStoryboard',
  icon: 'split',
  editor: 'split',
  supportsNode: (node) => hasToolableImage(node),
  createInitialOptions: () => ({
    rows: 3,
    cols: 3,
    lineThicknessPercent: 0.5,
  }),
  fields: [],
  execute: async (sourceImageUrl, options, context) =>
    await context.processTool(NODE_TOOL_TYPES.splitStoryboard, sourceImageUrl, options),
};

export const builtInToolPlugins: CanvasToolPlugin[] = [
  cropToolPlugin,
  splitStoryboardToolPlugin,
  annotateToolPlugin,
];
