// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from 'i18next';

import {
  CANVAS_NODE_TYPES,
  type CanvasNodeData,
  type CanvasNodeType,
  type ExportImageNodeResultKind,
} from './canvasNodes';

/**
 * 节点默认名有两个身份：一是画布 JSON 里 `data.displayName` 的初始值（建节点时就
 * 落盘，见 nodeRegistry.createDefaultData），二是界面上显示的标题。前者是数据，
 * 换语言不能跟着变，否则同一张画布在中英文下存出不同内容；后者才该翻译。
 *
 * 所以下面这份中文表保持不动当「规范默认值」，另配一份 key 表；渲染时用
 * localizeNodeDisplayName：名字为空、或恰好等于某个规范默认值（说明用户没改过
 * 名），就按当前语言显示，否则原样显示用户起的名字。
 */
// i18n-exempt-start: 规范默认值，会写进画布 JSON；显示用 NODE_DISPLAY_NAME_KEYS
export const DEFAULT_NODE_DISPLAY_NAME: Record<CanvasNodeType, string> = {
  [CANVAS_NODE_TYPES.upload]: '上传资源',
  [CANVAS_NODE_TYPES.imageEdit]: 'AI 图片',
  [CANVAS_NODE_TYPES.imageGen]: '图片节点',
  [CANVAS_NODE_TYPES.exportImage]: '结果图片',
  [CANVAS_NODE_TYPES.beatContext]: '镜头上下文',
  [CANVAS_NODE_TYPES.textAnnotation]: '文本',
  [CANVAS_NODE_TYPES.group]: '分组',
  [CANVAS_NODE_TYPES.storyboardSplit]: '分格抽取结果',
  [CANVAS_NODE_TYPES.storyboardGen]: '多版本宫格',
  [CANVAS_NODE_TYPES.video]: '视频',
  [CANVAS_NODE_TYPES.audio]: '音频',
  [CANVAS_NODE_TYPES.videoStory]: '视频故事',
  [CANVAS_NODE_TYPES.videoCompose]: '视频合成',
  [CANVAS_NODE_TYPES.script]: '脚本生成器',
  [CANVAS_NODE_TYPES.pano360Viewer]: '360° 全景查看器',
  [CANVAS_NODE_TYPES.threeDWorld]: '3D 世界',
  [CANVAS_NODE_TYPES.skill]: '技能',
  [CANVAS_NODE_TYPES.style]: '风格',
};

// i18n-exempt: 同上，会写进画布 JSON；显示用 EXPORT_RESULT_DISPLAY_NAME_KEYS
export const EXPORT_RESULT_DISPLAY_NAME: Record<ExportImageNodeResultKind, string> = {
  generic: '结果图片',
  storyboardGenOutput: '宫格输出',
  storyboardSplitExport: '分格导出',
  storyboardFrameEdit: '单格结果',
  matte: '抠图结果',
  upscale: '高清放大',
};
// i18n-exempt-end

const NODE_DISPLAY_NAME_KEYS: Record<CanvasNodeType, string> = Object.fromEntries(
  Object.values(CANVAS_NODE_TYPES).map((type) => [type, `node.displayName.${type}`]),
) as Record<CanvasNodeType, string>;

const EXPORT_RESULT_DISPLAY_NAME_KEYS: Record<ExportImageNodeResultKind, string> =
  Object.fromEntries(
    Object.keys(EXPORT_RESULT_DISPLAY_NAME).map((kind) => [kind, `node.exportResult.${kind}`]),
  ) as Record<ExportImageNodeResultKind, string>;

/** 所有规范默认值，用来判断「这名字是系统给的还是用户起的」。 */
const CANONICAL_DEFAULT_NAMES = new Set<string>([
  ...Object.values(DEFAULT_NODE_DISPLAY_NAME),
  ...Object.values(EXPORT_RESULT_DISPLAY_NAME),
]);

function resolveExportResultKind(data: Partial<CanvasNodeData>): ExportImageNodeResultKind {
  return (data as { resultKind?: ExportImageNodeResultKind }).resultKind ?? 'generic';
}

function resolveExportResultDefault(data: Partial<CanvasNodeData>): string {
  return EXPORT_RESULT_DISPLAY_NAME[resolveExportResultKind(data)];
}

export function getDefaultNodeDisplayName(type: CanvasNodeType, data: Partial<CanvasNodeData>): string {
  if (type === CANVAS_NODE_TYPES.exportImage) {
    return resolveExportResultDefault(data);
  }
  return DEFAULT_NODE_DISPLAY_NAME[type];
}

/** 默认名的显示版本，跟随界面语言。 */
export function localizeDefaultNodeDisplayName(
  type: CanvasNodeType,
  data: Partial<CanvasNodeData>,
  t: TFunction,
): string {
  if (type === CANVAS_NODE_TYPES.exportImage) {
    return t(EXPORT_RESULT_DISPLAY_NAME_KEYS[resolveExportResultKind(data)]);
  }
  return t(NODE_DISPLAY_NAME_KEYS[type]);
}

export function resolveNodeDisplayName(type: CanvasNodeType, data: Partial<CanvasNodeData>): string {
  const customTitle = typeof data.displayName === 'string' ? data.displayName.trim() : '';
  if (customTitle) {
    return customTitle;
  }

  if (type === CANVAS_NODE_TYPES.group) {
    const legacyLabel = typeof (data as { label?: string }).label === 'string'
      ? (data as { label?: string }).label?.trim()
      : '';
    if (legacyLabel) {
      return legacyLabel;
    }
  }

  return getDefaultNodeDisplayName(type, data);
}

/** 渲染用：用户没改过名就按当前语言显示，改过就原样显示。 */
export function localizeNodeDisplayName(
  type: CanvasNodeType,
  data: Partial<CanvasNodeData>,
  t: TFunction,
): string {
  const name = resolveNodeDisplayName(type, data);
  return CANONICAL_DEFAULT_NAMES.has(name)
    ? localizeDefaultNodeDisplayName(type, data, t)
    : name;
}

export function isNodeUsingDefaultDisplayName(type: CanvasNodeType, data: Partial<CanvasNodeData>): boolean {
  const customTitle = typeof data.displayName === 'string' ? data.displayName.trim() : '';
  if (!customTitle) {
    return true;
  }
  return customTitle === getDefaultNodeDisplayName(type, data);
}
