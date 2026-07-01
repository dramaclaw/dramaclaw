import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import {
  STORY_CHOICE_EDGE_TYPE,
  type StoryChoiceCondition,
  type StoryConditionExpr,
  type StoryVariable,
} from '@/features/canvas/story/storyTypes';
import { uuidGenerator } from '@/features/canvas/infrastructure/idGenerator';
import { layoutGraph } from '@/features/canvas/application/autoLayout';
import type { ImportedLink, ImportedStory } from './importTypes';

/**
 * 选项边的显示文案。ink 的 divert/条件跳转没有玩家文案,空文案在画布显示「+ 选项」
 * 占位、试玩时还会渲染成空白按钮,故给出有意义的默认:
 * - 真实选项 → 原文案;
 * - 条件跳转 → 条件本身(如 `trust >= 3`);else 分支(无条件)→「否则」;
 * - 纯自动跳转 → 「继续」。
 */
function choiceLabel(link: ImportedLink): string {
  const text = link.text?.trim();
  if (text) return text;
  if (link.kind === 'autoConditional') return link.condition?.trim() || '否则';
  return '继续';
}

// 故事组内边距(片段四周留白)。
const GROUP_PAD = 60;
// 导入故事组默认背景色(蓝,见 GROUP_COLOR_PRESETS),让导入的组在画布上一眼可辨。
const IMPORT_GROUP_COLOR = '#3b82f6';
// 片段节点占地尺寸(VideoStoryNode 渲染约 460 宽 + 旁白较高),给布局正确的占位面积,
// 否则布局按默认 320×200 估算会让节点显得拥挤。
const CLIP_W = 460;
const CLIP_H = 300;
// 导入布局的间距(比画布「整理」默认更宽松,故事片段节点大、留白要足)。
const IMPORT_COLUMN_GAP = 160;
const IMPORT_ROW_GAP = 120;

/** 把 "favor >= 3" 这类单一比较结构化;复合/无法识别返回 null。 */
export function parseSimpleCondition(raw: string): StoryChoiceCondition | null {
  const m = raw.trim().match(/^([a-zA-Z_]\w*)\s*(>=|<=|==|>|<)\s*(-?\d+)$/);
  if (!m) return null;
  return { var: m[1], op: m[2] as StoryChoiceCondition['op'], value: Number(m[3]) };
}

/**
 * 结构化扁平复合条件:`a >= 5 && b >= 0` / `a >= 5 || b < 1`。
 * 只允许单一连接词(同时含 `&&` 和 `||`、含括号/函数 → 返回 null,保持 needsReview)。
 * 单段退化为叶子;多段返回 `{ join, items }`;任一段无法解析 → null。
 */
export function parseCompoundCondition(raw: string): StoryConditionExpr | null {
  const hasAnd = raw.includes('&&');
  const hasOr = raw.includes('||');
  if (hasAnd && hasOr) return null; // v1 不支持混合连接
  const join: 'and' | 'or' = hasOr ? 'or' : 'and';
  const sep = hasOr ? '||' : '&&';
  const parts = raw.split(sep);
  const items: StoryChoiceCondition[] = [];
  for (const part of parts) {
    const leaf = parseSimpleCondition(part);
    if (!leaf) return null;
    items.push(leaf);
  }
  if (items.length === 0) return null;
  return items.length === 1 ? items[0] : { join, items };
}

export function buildStoryGroupFromImport(
  story: ImportedStory,
  opts?: { idGen?: () => string; center?: { x: number; y: number } },
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const idGen = opts?.idGen ?? uuidGenerator.next;

  // 1) knot 名 -> 生成的节点 id
  const nodeIdByKnot = new Map<string, string>();
  for (const k of story.knots) nodeIdByKnot.set(k.name, idGen());

  const groupId = idGen();
  const edges: CanvasEdge[] = [];

  // 2) 占位视频节点(位置先留空,交给布局引擎)
  const clips: CanvasNode[] = story.knots.map((k) => {
    const id = nodeIdByKnot.get(k.name)!;
    const needsReview = k.warnings.length > 0;
    return {
      id,
      type: CANVAS_NODE_TYPES.video,
      parentId: groupId,
      position: { x: 0, y: 0 },
      width: CLIP_W,
      height: CLIP_H,
      data: {
        displayName: k.name,
        videoUrl: null,
        aspectRatio: '16:9',
        narration: k.narration,
        ...(k.videoHint ? { videoHint: k.videoHint } : {}),
        ...(k.choiceTimeLimitSec ? { choiceTimeLimitSec: k.choiceTimeLimitSec } : {}),
        ...(k.endingLabel ? { endingLabel: k.endingLabel } : {}),
        ...(k.name === story.startKnot ? { storyRole: 'start' as const } : {}),
        ...(needsReview ? { importNeedsReview: true, importReviewNote: k.warnings.join('；') } : {}),
      },
    } as CanvasNode;
  });

  // 3) 按连线关系自动布局(复用画布「整理」引擎:分层 + 减少交叉 + 重心对齐)。
  const edgePairs: Array<[string, string]> = [];
  for (const k of story.knots) {
    const source = nodeIdByKnot.get(k.name)!;
    for (const link of k.outgoing) {
      const target = nodeIdByKnot.get(link.target);
      if (target) edgePairs.push([source, target]);
    }
  }
  const layout = layoutGraph(clips, edgePairs, {
    columnGap: IMPORT_COLUMN_GAP,
    rowGap: IMPORT_ROW_GAP,
  });
  for (const clip of clips) {
    const pos = layout.positions.get(clip.id) ?? { x: 0, y: 0 };
    clip.position = { x: pos.x + GROUP_PAD, y: pos.y + GROUP_PAD };
  }

  // 4) 故事组(包住所有片段)
  const variables: StoryVariable[] = story.variables.map((v) => ({
    name: v.name,
    label: v.name,
    initial: v.initial,
  }));
  const groupWidth = layout.width + GROUP_PAD * 2;
  const groupHeight = layout.height + GROUP_PAD * 2;
  // 传入 center(视野中心)时把组居中放置;否则落在原点(向后兼容)。
  const groupPosition = opts?.center
    ? { x: opts.center.x - groupWidth / 2, y: opts.center.y - groupHeight / 2 }
    : { x: 0, y: 0 };
  const nodes: CanvasNode[] = [
    {
      id: groupId,
      type: CANVAS_NODE_TYPES.group,
      position: groupPosition,
      width: groupWidth,
      height: groupHeight,
      data: {
        label: '互动影游(导入)',
        storyGroup: true,
        storyVariables: variables,
        backgroundColor: IMPORT_GROUP_COLOR,
      },
    } as CanvasNode,
    ...clips,
  ];

  // 5) 选项边
  for (const k of story.knots) {
    const source = nodeIdByKnot.get(k.name)!;
    let order = 0;
    for (const link of k.outgoing) {
      const target = nodeIdByKnot.get(link.target);
      if (!target) continue;
      const structured = link.condition ? parseCompoundCondition(link.condition) : null;
      // 成功结构化 → 清除复审标记(条件已可机器处理);仍无法结构化 → 保持 needsReview。
      const needsReview = structured != null ? false : link.needsReview || link.condition != null;
      edges.push({
        id: `import-${source}-${target}-${order}`,
        source,
        target,
        sourceHandle: 'source',
        targetHandle: 'target',
        type: STORY_CHOICE_EDGE_TYPE,
        data: {
          choiceText: choiceLabel(link),
          order,
          ...(link.effects.length ? { effects: link.effects } : {}),
          ...(structured ? { condition: structured } : {}),
          ...(link.isDefault ? { isDefault: true } : {}),
          ...(needsReview
            ? { needsReview: true, reviewNote: link.reviewNote ?? link.condition ?? '需手动处理' }
            : {}),
        },
      } as CanvasEdge);
      order++;
    }
  }

  return { nodes, edges };
}
