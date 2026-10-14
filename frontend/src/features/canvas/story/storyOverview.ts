// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 阶段C：只读剧本总览的纯派生层。数据一律来自画布投影（故事组 metadata +
// 视频节点 + 选择边），不新建第二套可写剧本；分支结构复用 buildStoryTree，
// 汇合/循环不会被误排成线性剧情。

import {
  isVideoNode,
  type CanvasEdge,
  type CanvasNode,
  type StoryCharacterMetadata,
} from '@/features/canvas/domain/canvasNodes';
import { buildStoryTree, type StoryTreeModel } from './buildStoryTree';
import { STORY_CHOICE_EDGE_TYPE } from './storyTypes';
import { selectGroupStoryFlags, selectGroupStoryVariables } from './storyVariableSelectors';

/** 片段的可读投影：剧情文案与制作说明严格分开，视频提示词(prompt)永不进总览。 */
export interface StoryOverviewSegment {
  nodeId: string;
  label: string;
  /** 剧情文案（narration）。空串 = 缺文案，由 UI 标出缺项。 */
  script: string;
  /** 供生产阶段查看的镜头/连续性备注。 */
  productionNotes: string;
  videoReady: boolean;
}

export interface StoryOverviewModel {
  groupId: string;
  title: string;
  synopsis: string;
  characters: StoryCharacterMetadata[];
  segmentsById: Map<string, StoryOverviewSegment>;
  tree: StoryTreeModel;
  segmentCount: number;
  /** 有剧情文案的片段数；用于「N/M 有文案」的缺项提示。 */
  scriptReadyCount: number;
  /** 互不重复的结局行（叶子且非 ↩ 引用）。 */
  endings: Array<{ label: string; endingLabel?: string; script: string }>;
}

function trimText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 从画布当前状态派生某个故事组的只读总览；组不存在时返回 null。 */
export function buildStoryOverview(
  groupId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): StoryOverviewModel | null {
  const group = nodes.find((n) => n.id === groupId);
  if (!group || (group.data as { storyGroup?: boolean }).storyGroup !== true) return null;

  const members = nodes.filter((n) => n.parentId === groupId && isVideoNode(n));
  const memberIds = new Set(members.map((n) => n.id));
  const storyEdges = edges.filter(
    (e) => e.type === STORY_CHOICE_EDGE_TYPE && memberIds.has(e.source),
  );
  const variables = selectGroupStoryVariables(nodes, groupId);
  const flags = selectGroupStoryFlags(nodes, groupId);
  const tree = buildStoryTree(members, storyEdges, variables, flags);

  const segmentsById = new Map<string, StoryOverviewSegment>();
  let scriptReadyCount = 0;
  for (const node of members) {
    const data = node.data as {
      displayName?: string;
      label?: string;
      narration?: string;
      storyProductionNotes?: string;
      videoUrl?: string | null;
    };
    const script = trimText(data.narration);
    if (script) scriptReadyCount++;
    segmentsById.set(node.id, {
      nodeId: node.id,
      label: trimText(data.displayName) || trimText(data.label) || node.id,
      script,
      productionNotes: trimText(data.storyProductionNotes),
      videoReady: Boolean(data.videoUrl),
    });
  }

  const endings: StoryOverviewModel['endings'] = [];
  const collectEndings = (row: StoryTreeModel['root']): void => {
    if (!row || row.repeated) return;
    if (row.isEnding) {
      endings.push({
        label: row.label,
        ...(row.endingLabel ? { endingLabel: row.endingLabel } : {}),
        script: segmentsById.get(row.nodeId)?.script ?? '',
      });
      return;
    }
    for (const child of row.children) collectEndings(child);
  };
  collectEndings(tree.root);

  const groupData = group.data as {
    displayName?: string;
    label?: string;
    storySynopsis?: string;
    storyCharacters?: StoryCharacterMetadata[];
  };
  return {
    groupId,
    title: trimText(groupData.displayName) || trimText(groupData.label),
    synopsis: trimText(groupData.storySynopsis),
    characters: Array.isArray(groupData.storyCharacters) ? groupData.storyCharacters : [],
    segmentsById,
    tree,
    segmentCount: members.length,
    scriptReadyCount,
    endings,
  };
}
