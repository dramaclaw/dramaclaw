// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 阶段D：画布左下角的可见创作流水线导航。纯读投影：状态来自 storyStages 的
// 证据推导，点击只做「定位到故事组/解释下一步」，不写画布、不改任务状态。
// fmv marker：仅当画布存在待确认大纲或带 interactiveStoryId 的故事组时渲染。

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, CircleDashed, Loader, MinusCircle } from 'lucide-react';

import { useCanvasStore } from '@/stores/canvasStore';
import { isVideoNode } from '@/features/canvas/domain/canvasNodes';
import { lintStory } from '@/features/canvas/story/lintStory';
import { STORY_CHOICE_EDGE_TYPE, type StoryFlag, type StoryVariable } from '@/features/canvas/story/storyTypes';
import { selectGroupStoryFlags, selectGroupStoryVariables } from '@/features/canvas/story/storyVariableSelectors';
import {
  deriveStoryStages,
  type ManualStoryStageId,
  type StoryStageModel,
  type StoryStageStatus,
} from '@/features/canvas/story/storyStages';
import type { PendingStoryOutline } from '@/features/canvas/story/pendingStoryOutline';
import { FREEZONE_DOCK_OFFSET_ANIMATED_STYLE } from '@/features/freezone/dockOffset';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

const STATUS_ICON: Record<StoryStageStatus, typeof Check> = {
  done: Check,
  active: Loader,
  todo: CircleDashed,
  manual: MinusCircle,
};

const STATUS_CLASS: Record<StoryStageStatus, string> = {
  done: 'text-success',
  active: 'text-primary',
  todo: 'text-text-muted',
  manual: 'text-text-muted/70',
};

export interface StoryStageNavModel {
  kind: StoryStageModel['kind'];
  stages: StoryStageModel['stages'];
  currentStageId: StoryStageModel['currentStageId'];
}

/** 从画布当前状态推导阶段导航模型；不满足 fmv 条件时返回 null。 */
export function deriveStoryStageNav(
  nodes: ReturnType<typeof useCanvasStore.getState>['nodes'],
  edges: ReturnType<typeof useCanvasStore.getState>['edges'],
  outline: PendingStoryOutline | null,
): StoryStageNavModel | null {
  const group = nodes.find(
    (node) =>
      (node.data as { storyGroup?: boolean; interactiveStoryId?: string }).storyGroup === true &&
      Boolean((node.data as { interactiveStoryId?: string }).interactiveStoryId),
  );
  if (!group && !outline) return null;

  let segmentCount = 0;
  let scriptReadyCount = 0;
  let promptReadyCount = 0;
  let videoReadyCount = 0;
  let lintErrorCount = 0;
  let characterCount = 0;
  let confirmedStages: ManualStoryStageId[] = [];
  let synopsisPresent = false;
  if (group) {
    const members = nodes.filter((node) => node.parentId === group.id && isVideoNode(node));
    const memberIds = new Set(members.map((node) => node.id));
    const storyEdges = edges.filter(
      (edge) => edge.type === STORY_CHOICE_EDGE_TYPE && memberIds.has(edge.source),
    );
    const variables: StoryVariable[] = selectGroupStoryVariables(nodes, group.id);
    const flags: StoryFlag[] = selectGroupStoryFlags(nodes, group.id);
    lintErrorCount = lintStory(members, storyEdges, variables, flags).filter(
      (issue) => issue.severity === 'error',
    ).length;
    segmentCount = members.length;
    for (const node of members) {
      const data = node.data as {
        narration?: string;
        prompt?: string;
        videoUrl?: string | null;
      };
      if (typeof data.narration === 'string' && data.narration.trim()) scriptReadyCount++;
      if (typeof data.prompt === 'string' && data.prompt.trim()) promptReadyCount++;
      // 生成中/排队中的任务不算就绪：videoUrl 只在实际素材落库后才有值。
      if (data.videoUrl) videoReadyCount++;
    }
    const groupData = group.data as {
      storySynopsis?: string;
      storyCharacters?: unknown[];
      storyStageConfirmations?: Record<string, { status?: unknown }>;
    };
    synopsisPresent = Boolean(groupData.storySynopsis?.trim());
    characterCount = Array.isArray(groupData.storyCharacters) ? groupData.storyCharacters.length : 0;
    const confirmations = groupData.storyStageConfirmations;
    confirmedStages = (['characters', 'scenes', 'storyboard', 'complete'] as const).filter(
      (stage) => confirmations?.[stage]?.status === 'confirmed',
    );
  }
  return deriveStoryStages({
    outline,
    hasStoryGroup: Boolean(group),
    synopsisPresent,
    segmentCount,
    scriptReadyCount,
    promptReadyCount,
    videoReadyCount,
    lintErrorCount,
    characterCount,
    confirmedStages,
  });
}

export function StoryStageNav({ outline }: { outline: PendingStoryOutline | null }) {
  const { t } = useTranslation();
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const setSelectedNode = useCanvasStore((s) => s.setSelectedNode);
  const requestFocusNode = useCanvasStore((s) => s.requestFocusNode);

  const model = useMemo(() => deriveStoryStageNav(nodes, edges, outline), [nodes, edges, outline]);
  if (!model) return null;

  const groupId = nodes.find(
    (node) =>
      (node.data as { storyGroup?: boolean; interactiveStoryId?: string }).storyGroup === true &&
      Boolean((node.data as { interactiveStoryId?: string }).interactiveStoryId),
  )?.id;

  const currentLabel = model.currentStageId
    ? t(`freezone.stages.${model.currentStageId}`)
    : null;

  return (
    <div
      data-stage-nav-region
      className="pointer-events-auto absolute bottom-4 left-4 z-30 max-w-[calc(100%_-_2rem_-_var(--freezone-dock-width,0px))]"
      style={FREEZONE_DOCK_OFFSET_ANIMATED_STYLE}
    >
      <TooltipProvider delay={120}>
        <nav
          aria-label={t('freezone.stages.navLabel')}
          className="flex items-center gap-1 overflow-x-auto rounded-[10px] border border-border/70 bg-background/95 px-2 py-1.5 shadow-lg backdrop-blur"
        >
          {model.stages.map((stage, index) => {
            const Icon = STATUS_ICON[stage.status];
            const label = t(`freezone.stages.${stage.id}`);
            const statusLabel = t(`freezone.stages.status.${stage.status}`);
            const hint = t(`freezone.stages.hint.${stage.id}`, { defaultValue: '' });
            return (
              <Tooltip key={stage.id}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={() => {
                        if (groupId) {
                          setSelectedNode(groupId);
                          requestFocusNode(groupId);
                        }
                      }}
                      className={
                        stage.id === model.currentStageId
                          ? 'flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs ring-1 ring-primary/60'
                          : 'flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs'
                      }
                    >
                      <Icon className={`size-3 ${STATUS_CLASS[stage.status]}`} />
                      <span className={stage.status === 'todo' ? 'text-text-muted' : 'text-text'}>
                        {label}
                      </span>
                      {index < model.stages.length - 1 && (
                        <span aria-hidden="true" className="text-text-muted/50">→</span>
                      )}
                    </button>
                  }
                />
                <TooltipContent side="top" className="flex-col items-start max-w-64 text-xs">
                  <span className="font-medium">{statusLabel}</span>
                  {hint && <span className="text-background/70">{hint}</span>}
                </TooltipContent>
              </Tooltip>
            );
          })}
          {currentLabel && (
            <span className="ml-1 shrink-0 border-l border-border/60 pl-2 text-xs text-text-muted">
              {t('freezone.stages.current', { stage: currentLabel })}
            </span>
          )}
        </nav>
      </TooltipProvider>
    </div>
  );
}
