// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 阶段D：可见创作流水线的**纯读取**推导层。状态只由可验证的画布产物证据
// 得出（大纲 metadata、故事组、片段文案/提示词/视频、lint），绝不写入任何
// 状态；生成中/被接受的任务不算视频完成；缺少稳定判据的阶段返回 manual
// （暂无自动判定），不假装完成。

import type { PendingStoryOutline } from './pendingStoryOutline';

export type StoryStageStatus = 'todo' | 'active' | 'done' | 'manual';
export type ManualStoryStageId = 'characters' | 'scenes' | 'storyboard' | 'complete';

export type StoryStageId =
  | 'proposal'
  | 'outline'
  | 'script'
  | 'characters'
  | 'scenes'
  | 'storyboard'
  | 'video'
  | 'complete';

export interface StoryStageEvidence {
  outline: PendingStoryOutline | null;
  hasStoryGroup: boolean;
  synopsisPresent: boolean;
  segmentCount: number;
  /** 有剧情文案（narration）的片段数。 */
  scriptReadyCount: number;
  /** 有视频提示词的片段数。 */
  promptReadyCount: number;
  /** 视频素材就绪的片段数；生成中不计入。 */
  videoReadyCount: number;
  lintErrorCount: number;
  characterCount: number;
  /** 用户通过虾导明确确认完成的人工阶段。 */
  confirmedStages: ManualStoryStageId[];
}

export interface StoryStage {
  id: StoryStageId;
  status: StoryStageStatus;
}

export interface StoryStageModel {
  kind: 'story' | 'ad';
  stages: StoryStage[];
  /** 第一个尚未完成的阶段；manual 也会阻止流程假装跳到后续阶段。 */
  currentStageId: StoryStageId | null;
}

export const STORY_STAGE_ORDER: StoryStageId[] = [
  'proposal',
  'outline',
  'script',
  'characters',
  'scenes',
  'storyboard',
  'video',
  'complete',
];

// 广告与影游共用同一套创作流水线阶段，不再单独维护短流程；`kind` 仅用于
// 大纲卡徽标与续作文案，不影响阶段推导。

function outlineApproved(outline: PendingStoryOutline | null): boolean {
  return outline?.status === 'confirmed' || outline?.status === 'linked';
}

function proposalStage(evidence: StoryStageEvidence): StoryStage {
  const outline = evidence.outline;
  if (!outline) return { id: 'proposal', status: 'todo' };
  return { id: 'proposal', status: outlineApproved(outline) ? 'done' : 'active' };
}

function scriptLikeStage(
  id: StoryStageId,
  evidence: StoryStageEvidence,
): StoryStage {
  if (!evidence.hasStoryGroup) return { id, status: 'todo' };
  const complete =
    evidence.segmentCount > 0 &&
    evidence.scriptReadyCount === evidence.segmentCount &&
    evidence.lintErrorCount === 0;
  return { id, status: complete ? 'done' : 'active' };
}

function videoStage(evidence: StoryStageEvidence): StoryStage {
  if (evidence.segmentCount === 0) return { id: 'video', status: 'todo' };
  if (evidence.videoReadyCount === evidence.segmentCount) {
    return { id: 'video', status: 'done' };
  }
  return { id: 'video', status: evidence.videoReadyCount > 0 ? 'active' : 'todo' };
}

/** 从画布证据推导阶段状态；输入来自调用方的只读投影。广告与影游同走这套阶段。 */
export function deriveStoryStages(evidence: StoryStageEvidence): StoryStageModel {
  const kind = evidence.outline?.kind ?? 'story';
  const stages: StoryStage[] = [];
  stages.push(proposalStage(evidence));
  stages.push(
    outlineApproved(evidence.outline) || (evidence.hasStoryGroup && evidence.synopsisPresent)
      ? { id: 'outline', status: 'done' }
      : { id: 'outline', status: evidence.outline ? 'active' : 'todo' },
  );
  stages.push(scriptLikeStage('script', evidence));
  const confirmed = new Set(evidence.confirmedStages);
  // 这些阶段没有稳定的自动判据，只接受用户通过虾导作出的显式确认。
  stages.push(
    !evidence.hasStoryGroup
      ? { id: 'characters', status: 'todo' }
      : { id: 'characters', status: confirmed.has('characters') ? 'done' : 'manual' },
  );
  stages.push({ id: 'scenes', status: confirmed.has('scenes') ? 'done' : 'manual' });
  stages.push({ id: 'storyboard', status: confirmed.has('storyboard') ? 'done' : 'manual' });
  stages.push(videoStage(evidence));
  // 「完成」要求可试玩且交付项已验证，不等同于 Validate 通过。
  stages.push({ id: 'complete', status: confirmed.has('complete') ? 'done' : 'manual' });
  // 流程必须停在最早的未完成阶段。尤其不能跳过 manual 阶段把「视频」高亮为
  // 当前阶段，否则 UI 和 Agent 都会把尚未制作的角色/场景误报成已完成。
  const current = stages.find((stage) => stage.status !== 'done') ?? null;
  return { kind, stages, currentStageId: current?.id ?? null };
}
