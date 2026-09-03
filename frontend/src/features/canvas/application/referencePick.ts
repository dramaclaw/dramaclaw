// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 「参考」拾取的规则层：图片 / 视频节点点开 ＋参考 后，画布上哪些节点可以被选作
 * 参考。
 *
 * 落地方式是一条普通的上游连线（canvasStore.addEdge(source, target)）——提示词栏
 * 的参考 chip 和提交时的参考图 / 参考视频本来就从上游边推导（见 useUpstreamContents
 * 与 extractUpstreamContent），所以这个功能不需要任何新的数据通路，只需要把「谁能
 * 连进来」说清楚。
 *
 * 类型规则仍然只有 nodeRegistry 一个事实来源：这里在它之上再叠一层「参考语义」的
 * 收窄（图片节点只收图片 / 文本），与 UPSTREAM_SPAWN_WHITELIST 收窄上游菜单是同一
 * 个道理——建边规则允许的边不一定是用户在这个入口里想要的边。
 */
import type { TFunction } from 'i18next';

import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
  type CanvasNodeType,
} from '../domain/canvasNodes';
import { localizeNodeDisplayName } from '../domain/nodeDisplay';
import {
  isManualConnectionAllowed,
  nodeHasSourceHandle,
  nodeHasTargetHandle,
} from '../domain/nodeRegistry';
import { extractUpstreamContent } from './graphContentResolver';

export type ReferenceKind = 'text' | 'image' | 'video' | 'audio';

/**
 * 目标节点类型 → 它能接受的参考素材种类。不在表里的类型没有 ＋参考 入口。
 */
const ACCEPTED_REFERENCE_KINDS: Partial<
  Record<CanvasNodeType, readonly ReferenceKind[]>
> = {
  [CANVAS_NODE_TYPES.imageGen]: ['image', 'text'],
  [CANVAS_NODE_TYPES.video]: ['image', 'video', 'audio', 'text'],
};

/**
 * 节点还没有内容时的兜底种类，按节点类型定。
 *
 * 为什么不只看当前内容：空文本节点、还没生成的图片节点都应该能先连上去、之后再
 * 填内容——只看内容会让它们在拾取态里凭空消失。反过来，上传节点可以装图 / 视频 /
 * 音频，所以内容能判断出来时以内容为准。
 */
const DEFAULT_REFERENCE_KIND: Partial<Record<CanvasNodeType, ReferenceKind>> = {
  [CANVAS_NODE_TYPES.textAnnotation]: 'text',
  [CANVAS_NODE_TYPES.script]: 'text',
  [CANVAS_NODE_TYPES.upload]: 'image',
  [CANVAS_NODE_TYPES.imageEdit]: 'image',
  [CANVAS_NODE_TYPES.imageGen]: 'image',
  [CANVAS_NODE_TYPES.exportImage]: 'image',
  [CANVAS_NODE_TYPES.storyboardGen]: 'image',
  [CANVAS_NODE_TYPES.video]: 'video',
  [CANVAS_NODE_TYPES.audio]: 'audio',
};

/** 「视频暂不支持作为参考」这类提示里的种类名。 */
const REFERENCE_KIND_LABEL_KEY: Record<ReferenceKind, string> = {
  text: 'canvas.referencePick.kind.text',
  image: 'canvas.referencePick.kind.image',
  video: 'canvas.referencePick.kind.video',
  audio: 'canvas.referencePick.kind.audio',
};

export interface ReferencePickCandidate {
  /** 节点在画布上显示的名字，用于「选择 xxx」提示。 */
  label: string;
  kind: ReferenceKind;
}

export interface ReferencePickTargets {
  /** 可以点选的节点：nodeId → 候选信息。 */
  candidates: Map<string, ReferencePickCandidate>;
  /**
   * 选不了的节点：nodeId → 不能选的原因文案。拾取态里把它们调暗、hover 出这句话。
   *
   * 为什么要专门算一份而不是「不是候选就不画遮罩」：静默消失只会让用户觉得「点了
   * 没反应」，分不清是不支持还是功能坏了——图片节点面对视频 / 音频节点尤其明显。
   * 说清楚不能选的原因，比让人反复试要省事。
   *
   * 分组节点不在这里：它是容器不是素材，给它盖一层暗色等于把整个组里的内容一起
   * 糊掉，而组里的每个子节点本来就各自带着自己的遮罩。
   */
  rejections: Map<string, string>;
}

/** 这个节点类型有没有 ＋参考 入口。 */
export function supportsReferencePick(type: CanvasNodeType | undefined): boolean {
  return type !== undefined && ACCEPTED_REFERENCE_KINDS[type] !== undefined;
}

export function acceptedReferenceKinds(
  type: CanvasNodeType,
): readonly ReferenceKind[] | null {
  return ACCEPTED_REFERENCE_KINDS[type] ?? null;
}

/** 一个节点当下能贡献出的参考素材种类；null 表示它贡献不了任何东西。 */
export function referenceKindOf(node: CanvasNode): ReferenceKind | null {
  const content = extractUpstreamContent(node);
  if (content.imageUrl) return 'image';
  if (content.videoUrl) return 'video';
  if (content.audioUrl) return 'audio';
  if (content.text) return 'text';
  return DEFAULT_REFERENCE_KIND[node.type as CanvasNodeType] ?? null;
}

/**
 * 算出进入拾取态那一刻画布上每个节点的去向：可选、或可解释地不可选。
 *
 * 结果是一份快照，存进 referencePickStore 后每个节点的 overlay 只做一次 Map 查询，
 * 不必在每次 store 变更时各自把 nodes 数组扫一遍（那是 O(N²)）。
 */
export function collectReferencePickTargets(
  nodes: readonly CanvasNode[],
  targetNodeId: string,
  targetNodeType: CanvasNodeType,
  t: TFunction,
): ReferencePickTargets {
  const candidates = new Map<string, ReferencePickCandidate>();
  const rejections = new Map<string, string>();
  const accepted = ACCEPTED_REFERENCE_KINDS[targetNodeType];
  if (!accepted || !nodeHasTargetHandle(targetNodeType)) {
    return { candidates, rejections };
  }

  for (const node of nodes) {
    if (node.id === targetNodeId) continue;
    const type = node.type as CanvasNodeType | undefined;
    if (!type || type === CANVAS_NODE_TYPES.group) continue;

    const kind = referenceKindOf(node);
    if (
      kind
      && accepted.includes(kind)
      && nodeHasSourceHandle(type)
      && isManualConnectionAllowed(type, targetNodeType)
    ) {
      candidates.set(node.id, {
        label: localizeNodeDisplayName(type, node.data ?? {}, t),
        kind,
      });
      continue;
    }
    // 说得出种类就说种类（「视频暂不支持作为参考」）；说不出的多半是风格、多版本
    // 这类根本不承载素材的节点，给一句通用的就够了。
    rejections.set(
      node.id,
      kind
        ? t('canvas.referencePick.rejectKind', { kind: t(REFERENCE_KIND_LABEL_KEY[kind]) })
        : t('canvas.referencePick.rejectGeneric'),
    );
  }
  return { candidates, rejections };
}

/** @ 引用能指向的素材种类；文本不参与（提示词里的 @ 只指媒体素材）。 */
export type ReferenceMediaKind = Exclude<ReferenceKind, 'text'>;

export interface ReferenceMaterialOption {
  nodeId: string;
  /** 节点在画布上显示的名字。 */
  label: string;
  kind: ReferenceMediaKind;
  /** 列表行的缩略图；音频没有，靠 kind 画一个 ♪。 */
  imageUrl?: string;
  videoUrl?: string;
  audioUrl?: string;
}

/**
 * 「素材引用」清单：画布上还能被这个节点引用、且当前还没引用的媒体素材。
 *
 * 用在提示词里替换某个 @ 引用的选单上——那里除了在已引用的素材之间换指向，还要
 * 能直接换成画布上另一个素材（选中即建边，引用行随之多一条）。可选范围与 ＋参考
 * 拾取态完全一致，走的是同一份 collectReferencePickTargets，避免两个入口对「什么
 * 能当参考」给出不同答案。
 *
 * 唯一的收窄：还没有内容的节点不进这份清单。拾取态收录它们是对的（先连上、之后
 * 再生成），但这里选中一条素材的意思是「把这处 @ 换成它」，而空节点当不了 @ 的
 * 指向——列出来只会得到一次「点了没反应」。
 *
 * excludedNodeIds 请按**实际连线**给（不是按已有内容的引用行）：已经连上、但此刻
 * 还没产出内容的上游节点同样不该再出现在「还没引用」里，否则选中它只是对一条已
 * 存在的边再 addEdge 一次，界面上什么都不会发生。
 */
export function collectReferenceMaterials(
  nodes: readonly CanvasNode[],
  targetNodeId: string,
  targetNodeType: CanvasNodeType,
  excludedNodeIds: ReadonlySet<string>,
  t: TFunction,
): ReferenceMaterialOption[] {
  const { candidates } = collectReferencePickTargets(nodes, targetNodeId, targetNodeType, t);
  const options: ReferenceMaterialOption[] = [];
  for (const node of nodes) {
    const candidate = candidates.get(node.id);
    if (!candidate || candidate.kind === 'text') continue;
    if (excludedNodeIds.has(node.id)) continue;
    const content = extractUpstreamContent(node);
    if (!content.imageUrl && !content.videoUrl && !content.audioUrl) continue;
    options.push({
      nodeId: node.id,
      label: candidate.label,
      kind: candidate.kind,
      imageUrl: content.imageUrl || undefined,
      videoUrl: content.videoUrl || undefined,
      audioUrl: content.audioUrl || undefined,
    });
  }
  return options;
}

export function collectReferenceCandidates(
  nodes: readonly CanvasNode[],
  targetNodeId: string,
  targetNodeType: CanvasNodeType,
  t: TFunction,
): Map<string, ReferencePickCandidate> {
  return collectReferencePickTargets(nodes, targetNodeId, targetNodeType, t).candidates;
}
