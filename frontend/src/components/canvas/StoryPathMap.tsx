import { memo, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { CheckCircle2, Circle, Flag, X } from 'lucide-react';

import { useCanvasStore } from '@/stores/canvasStore';
import { isVideoNode } from '@/features/canvas/domain/canvasNodes';
import { STORY_CHOICE_EDGE_TYPE } from '@/features/canvas/story/storyTypes';
import { selectGroupStoryVariables } from '@/features/canvas/story/storyVariableSelectors';
import { buildStoryTree, type StoryTreeRow } from '@/features/canvas/story/buildStoryTree';
import { emptyStoryStats, readStoryStats } from '@/features/canvas/story/storyStats';
import { computeStoryPathCoverage } from '@/features/canvas/story/storyPathCoverage';

function pct(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

/**
 * 路径回顾图(P1 #8,参照 Stornaway Story Map 回溯):播放器内浮出,把试玩统计叠到剧情树上,
 * 高亮已走过的节点/路径、标记已达成与未达成结局,给「看了多少、还有什么没看」的地图感。
 *
 * 剧情树从画布图实时派生(同 StoryTreePanel);覆盖度来自 localStorage 统计快照。只读。
 */
export const StoryPathMap = memo(function StoryPathMap({
  groupId,
  statsKey,
  onClose,
}: {
  groupId: string;
  statsKey: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const variables = useCanvasStore(useShallow((s) => selectGroupStoryVariables(s.nodes, groupId)));

  const model = useMemo(() => {
    const members = nodes.filter((n) => n.parentId === groupId && isVideoNode(n));
    const memberIds = new Set(members.map((n) => n.id));
    const storyEdges = edges.filter((e) => e.type === STORY_CHOICE_EDGE_TYPE && memberIds.has(e.source));
    return buildStoryTree(members, storyEdges, variables);
  }, [nodes, edges, groupId, variables]);

  // 开面板时读一次统计快照;statsKey 为空(未持久化)则视为空覆盖,仍展示结构。
  const coverage = useMemo(
    () => computeStoryPathCoverage(model, statsKey ? readStoryStats(statsKey) : emptyStoryStats()),
    [model, statsKey],
  );
  const { visitedNodeIds, endingCounts, summary } = coverage;

  const renderRow = (row: StoryTreeRow): ReactNode => {
    const visited = visitedNodeIds.has(row.nodeId);
    const endingCount = endingCounts[row.nodeId];
    const endingReached = row.isEnding && endingCount != null;
    return (
      <div key={`${row.nodeId}-${row.depth}-${row.incomingChoiceText ?? ''}`}>
        <div
          className="flex items-center gap-1.5 rounded px-1 py-0.5"
          style={{ paddingLeft: row.depth * 14 + 2 }}
        >
          {/* 走过 = 实心节点;未走 = 空心。 */}
          {visited ? (
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-accent" />
          ) : (
            <Circle className="h-3.5 w-3.5 shrink-0 text-white/25" />
          )}
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {row.incomingChoiceText && (
              <span className={`shrink-0 ${visited ? 'text-white/55' : 'text-white/25'}`}>
                [{row.incomingChoiceText}]
              </span>
            )}
            <span className={`truncate ${visited ? 'text-white/90' : 'text-white/35'}`}>{row.label}</span>
            {row.isEnding && (
              <span
                className={`inline-flex shrink-0 items-center gap-1 ${
                  endingReached ? 'text-amber-300/90' : 'text-white/30'
                }`}
              >
                <Flag className="h-3 w-3" />
                {row.endingLabel ?? t('canvas.story.endingFallback')}
                {endingReached && <span className="tabular-nums text-white/50">×{endingCount}</span>}
              </span>
            )}
          </div>
        </div>
        {!row.repeated && row.children.map(renderRow)}
      </div>
    );
  };

  return (
    <div className="absolute inset-y-0 right-0 z-30 flex w-[22rem] max-w-[90vw] flex-col border-l border-white/10 bg-[#16181c]/98 text-sm text-white/90 shadow-[0_0_64px_rgba(0,0,0,0.6)] backdrop-blur-xl">
      <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
        <span className="font-medium text-white/85">{t('canvas.story.map.title')}</span>
        <button
          onClick={onClose}
          className="rounded-full p-1 text-white/55 transition-colors hover:bg-white/10 hover:text-white"
          aria-label={t('common.close')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 覆盖度概览:探索节点 + 达成结局各一条进度。 */}
      <div className="flex flex-col gap-3 border-b border-white/[0.07] px-4 py-3">
        <CoverageBar
          label={t('canvas.story.map.explored')}
          done={summary.exploredNodes}
          total={summary.totalNodes}
          tone="accent"
        />
        <CoverageBar
          label={t('canvas.story.map.endings')}
          done={summary.reachedEndings}
          total={summary.totalEndings}
          tone="amber"
        />
        <div className="text-[11px] text-white/45">
          {t('canvas.story.map.totalRuns', { count: summary.totalRuns })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 text-xs">
        {model.noStart && <p className="mb-2 text-amber-300/90">{t('canvas.story.tree.noStart')}</p>}
        {model.root ? (
          renderRow(model.root)
        ) : (
          <p className="text-white/45">{t('canvas.story.tree.empty')}</p>
        )}
      </div>
    </div>
  );
});

function CoverageBar({
  label,
  done,
  total,
  tone,
}: {
  label: string;
  done: number;
  total: number;
  tone: 'accent' | 'amber';
}) {
  const ratio = pct(done, total);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-white/45">{label}</span>
        <span className="tabular-nums text-white/70">
          {done}/{total}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full ${tone === 'accent' ? 'bg-accent/70' : 'bg-amber-300/70'}`}
          style={{ width: `${ratio}%` }}
        />
      </div>
    </div>
  );
}
