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

/**
 * 未命名节点的自动序号：新建时写进 data.autoTitleIndex，默认名后面拼上它
 * （「文本1」「文本2」「图片节点1」…），避免同类型节点重名分不清。
 *
 * 刻意不把序号写进 displayName —— displayName 的语义是「用户自己起的标题」，
 * isNodeUsingDefaultDisplayName / UploadNode 的自动改名都依赖这一点。
 */
export function getDefaultNodeDisplayName(type: CanvasNodeType, data: Partial<CanvasNodeData>): string {
  const base =
    type === CANVAS_NODE_TYPES.exportImage
      ? resolveExportResultDefault(data)
      : DEFAULT_NODE_DISPLAY_NAME[type];
  const index = (data as { autoTitleIndex?: unknown }).autoTitleIndex;
  return typeof index === 'number' && Number.isFinite(index) && index > 0
    ? `${base}${index}`
    : base;
}

/**
 * 下一个可用的自动序号（同类型节点内）。
 *
 * 取「已用序号最大值」与「同类型节点个数」两者的较大值 +1：
 * - 已用最大值 +1 保证不与现存节点重号（删掉中间的节点也不会撞）；
 * - 同类型个数兜底老画布——历史节点没有 autoTitleIndex，直接从 1 开始会和它们
 *   显示的无序号默认名混在一起，用个数抬高起点可以避开。
 */
export function nextAutoTitleIndex(
  type: CanvasNodeType,
  nodes: ReadonlyArray<{ type?: string | null; data?: unknown }>,
): number {
  let maxIndex = 0;
  let sameTypeCount = 0;
  for (const node of nodes) {
    if (node.type !== type) continue;
    sameTypeCount += 1;
    const raw = (node.data as { autoTitleIndex?: unknown } | undefined)?.autoTitleIndex;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > maxIndex) {
      maxIndex = raw;
    }
  }
  return Math.max(maxIndex, sameTypeCount) + 1;
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

/**
 * 给「没有自定义标题」的新节点补上自动序号，并把标题写成带序号的默认名。
 *
 * 两个字段都要写：
 * - `displayName`：各节点定义的 createDefaultData() 本就把默认名预填进 displayName，
 *   只写 autoTitleIndex 不会改变渲染结果，所以标题要一起覆盖成带序号的默认名；
 * - `autoTitleIndex`：让 getDefaultNodeDisplayName 也算出同样的带序号默认名，
 *   于是 isNodeUsingDefaultDisplayName 仍判定为「用的是默认名」（UploadNode 的
 *   自动改名依赖这一点），用户改标题后序号自然不再露出。
 *
 * 调用方已经给了 displayName（各类结果节点如「抠图」「高清放大」）→ 原样返回、不发号。
 */
export function withAutoTitleIndex<T extends Partial<CanvasNodeData>>(
  type: CanvasNodeType,
  data: T,
  existingNodes: ReadonlyArray<{ type?: string | null; data?: unknown }>,
): T {
  const explicitTitle = typeof data.displayName === 'string' ? data.displayName.trim() : '';
  if (explicitTitle) return data;
  const autoTitleIndex = nextAutoTitleIndex(type, existingNodes);
  const withIndex = { ...data, autoTitleIndex };
  return { ...withIndex, displayName: getDefaultNodeDisplayName(type, withIndex) };
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
