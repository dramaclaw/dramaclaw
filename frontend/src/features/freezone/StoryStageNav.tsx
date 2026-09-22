// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 阶段D：画布左下角的可见创作流水线导航。纯读投影：状态来自 storyStages 的
// 证据推导，点击只做「定位到故事组/解释下一步」，不写画布、不改任务状态。
// fmv marker：仅当画布存在待确认大纲或带 interactiveStoryId 的故事组时渲染。

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, CircleDashed, Loader, MinusCircle, MoreHorizontal } from 'lucide-react';

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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

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

type StageNavCollapseDirection = 'none' | 'start' | 'end' | 'both';

interface StoryStageNavProps {
  outline: PendingStoryOutline | null;
  leftPanelExpanded?: boolean;
  rightPanelExpanded?: boolean;
}

interface StageNavLayout {
  leading: StoryStageModel['stages'];
  visible: StoryStageModel['stages'];
  trailing: StoryStageModel['stages'];
  compact: boolean;
}

/**
 * Keep the active task path readable while either canvas drawer takes space.
 * A left drawer folds the already-completed prefix; a right drawer folds the
 * distant suffix. If the current stage sits at an edge, fold the opposite side
 * as a fallback so the bar still becomes meaningfully shorter.
 */
export function deriveStageNavLayout(
  stages: StoryStageModel['stages'],
  currentStageId: StoryStageModel['currentStageId'],
  direction: StageNavCollapseDirection,
): StageNavLayout {
  if (direction === 'none' || stages.length <= 3) {
    return { leading: [], visible: stages, trailing: [], compact: false };
  }

  const resolvedCurrentIndex = currentStageId
    ? stages.findIndex((stage) => stage.id === currentStageId)
    : stages.length - 1;
  const currentIndex = resolvedCurrentIndex >= 0 ? resolvedCurrentIndex : 0;
  // A one-item summary is not shorter than the stage it replaces, so only
  // collapse a side when it can absorb at least two stages.
  const canCollapseStart = currentIndex > 1;
  const canCollapseEnd = currentIndex < stages.length - 3;
  const collapseStart = direction === 'start' || direction === 'both';
  const collapseEnd = direction === 'end' || direction === 'both';

  let visibleStart = collapseStart && canCollapseStart ? currentIndex : 0;
  let visibleEnd = collapseEnd && canCollapseEnd ? currentIndex + 2 : stages.length;

  if (direction === 'start' && !canCollapseStart && canCollapseEnd) visibleEnd = currentIndex + 2;
  if (direction === 'end' && !canCollapseEnd && canCollapseStart) visibleStart = currentIndex;

  return {
    leading: stages.slice(0, visibleStart),
    visible: stages.slice(visibleStart, visibleEnd),
    trailing: stages.slice(visibleEnd),
    compact: visibleStart > 0 || visibleEnd < stages.length,
  };
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

export function StoryStageNav({
  outline,
  leftPanelExpanded = false,
  rightPanelExpanded = false,
}: StoryStageNavProps) {
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
  const collapseDirection: StageNavCollapseDirection = leftPanelExpanded
    ? rightPanelExpanded
      ? 'both'
      : 'start'
    : rightPanelExpanded
      ? 'end'
      : 'none';
  const layout = deriveStageNavLayout(model.stages, model.currentStageId, collapseDirection);
  const navItems = [
    ...(layout.leading.length > 0 ? [{ kind: 'leading' as const, stages: layout.leading }] : []),
    ...layout.visible.map((stage) => ({ kind: 'stage' as const, stage })),
    ...(layout.trailing.length > 0 ? [{ kind: 'trailing' as const, stages: layout.trailing }] : []),
  ];

  const focusStoryGroup = () => {
    if (!groupId) return;
    setSelectedNode(groupId);
    requestFocusNode(groupId);
  };

  return (
    <div
      data-stage-nav-region
      className="pointer-events-auto absolute bottom-4 left-8 right-4 z-30 flex"
      style={{
        ...FREEZONE_DOCK_OFFSET_ANIMATED_STYLE,
        marginLeft: leftPanelExpanded ? 300 : 0,
      }}
    >
      <TooltipProvider delay={120}>
        <nav
          aria-label={t('freezone.stages.navLabel')}
          className="flex max-w-full items-center gap-1 overflow-hidden rounded-[10px] border border-border/70 bg-background/95 px-2 py-1.5 shadow-lg backdrop-blur"
        >
          {navItems.map((item, index) => {
            const separator = index < navItems.length - 1 && (
              <span aria-hidden="true" className="shrink-0 text-text-muted/50">→</span>
            );

            if (item.kind !== 'stage') {
              const isLeading = item.kind === 'leading';
              const summaryLabel = t(
                isLeading ? 'freezone.stages.completedSummary' : 'freezone.stages.upcomingSummary',
                { count: item.stages.length },
              );
              return (
                <div key={item.kind} className="flex shrink-0 items-center gap-1">
                  <Popover>
                    <PopoverTrigger
                      render={
                        <button
                          type="button"
                          className="flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs text-text-muted transition-colors hover:bg-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                          aria-label={t('freezone.stages.showHidden', { summary: summaryLabel })}
                        >
                          {isLeading ? <Check className="size-3 text-success" /> : <MoreHorizontal className="size-3" />}
                          <span>{summaryLabel}</span>
                        </button>
                      }
                    />
                    <PopoverContent side="top" align="start" className="w-52 p-2">
                      <div className="flex flex-col gap-0.5">
                        {item.stages.map((stage) => {
                          const Icon = STATUS_ICON[stage.status];
                          return (
                            <button
                              key={stage.id}
                              type="button"
                              onClick={focusStoryGroup}
                              className="flex w-full items-center gap-2 rounded-[var(--ui-radius-sm)] px-2 py-1.5 text-left text-xs text-popover-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                            >
                              <Icon className={`size-3 ${STATUS_CLASS[stage.status]}`} />
                              <span>{t(`freezone.stages.${stage.id}`)}</span>
                              <span className="ml-auto text-[11px] text-muted-foreground">
                                {t(`freezone.stages.status.${stage.status}`)}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </PopoverContent>
                  </Popover>
                  {separator}
                </div>
              );
            }

            const stage = item.stage;
            const Icon = STATUS_ICON[stage.status];
            const label = t(`freezone.stages.${stage.id}`);
            const statusLabel = t(`freezone.stages.status.${stage.status}`);
            const hint = t(`freezone.stages.hint.${stage.id}`, { defaultValue: '' });
            return (
              <div key={stage.id} className="flex shrink-0 items-center gap-1">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={focusStoryGroup}
                        aria-current={stage.id === model.currentStageId ? 'step' : undefined}
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
                      </button>
                    }
                  />
                  <TooltipContent side="top" className="flex-col items-start max-w-64 text-xs">
                    <span className="font-medium">{statusLabel}</span>
                    {hint && <span className="text-background/70">{hint}</span>}
                  </TooltipContent>
                </Tooltip>
                {separator}
              </div>
            );
          })}
          {currentLabel && !layout.compact && (
            <span className="ml-1 shrink-0 border-l border-border/60 pl-2 text-xs text-text-muted">
              {t('freezone.stages.current', { stage: currentLabel })}
            </span>
          )}
        </nav>
      </TooltipProvider>
    </div>
  );
}
