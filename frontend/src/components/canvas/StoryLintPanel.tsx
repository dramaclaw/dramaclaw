import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';

import { useShallow } from 'zustand/react/shallow';

import { useCanvasStore } from '@/stores/canvasStore';
import { FREEZONE_DOCK_OFFSET_ANIMATED_STYLE } from '@/features/freezone/dockOffset';
import { isVideoNode } from '@/features/canvas/domain/canvasNodes';
import { STORY_CHOICE_EDGE_TYPE } from '@/features/canvas/story/storyTypes';
import { selectGroupStoryFlags, selectGroupStoryVariables } from '@/features/canvas/story/storyVariableSelectors';
import { lintStory, type StoryIssue, type StoryIssueSeverity } from '@/features/canvas/story/lintStory';
import { storyDurationRange } from '@/features/canvas/story/storyDurationRange';

const SEVERITY_ICON: Record<StoryIssueSeverity, typeof Info> = {
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
};
const SEVERITY_COLOR: Record<StoryIssueSeverity, string> = {
  error: 'text-red-400',
  warning: 'text-amber-400',
  info: 'text-white/45',
};

/** 故事校验面板:列出该故事组的问题(按级别),点击聚焦对应节点。 */
export const StoryLintPanel = memo(function StoryLintPanel({
  groupId,
  onClose,
}: {
  groupId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const variables = useCanvasStore(useShallow((s) => selectGroupStoryVariables(s.nodes, groupId)));
  const flags = useCanvasStore(useShallow((s) => selectGroupStoryFlags(s.nodes, groupId)));
  const setSelectedNode = useCanvasStore((s) => s.setSelectedNode);
  const requestFocusNode = useCanvasStore((s) => s.requestFocusNode);

  const { issues, members, storyEdges, durationRange, videoReady, promptReady, loopReady, loopTotal } = useMemo(() => {
    const memberList = nodes.filter((n) => n.parentId === groupId && isVideoNode(n));
    const memberIds = new Set(memberList.map((n) => n.id));
    const edgeList = edges.filter(
      (e) => e.type === STORY_CHOICE_EDGE_TYPE && memberIds.has(e.source),
    );
    const durationRange = storyDurationRange(memberList, edgeList);
    const videoReady = memberList.filter((node) => Boolean((node.data as { videoUrl?: string | null }).videoUrl)).length;
    const promptReady = memberList.filter((node) => Boolean((node.data as { prompt?: string }).prompt?.trim())).length;
    const loopSources = memberList.filter((node) => (node.data as { storyChoiceLoop?: unknown }).storyChoiceLoop);
    const loopReady = loopSources.filter((node) => Boolean((node.data as { choiceLoopVideoUrl?: string | null }).choiceLoopVideoUrl)).length;
    return {
      issues: lintStory(memberList, edgeList, variables, flags),
      members: memberList,
      storyEdges: edgeList,
      durationRange,
      videoReady,
      promptReady,
      loopReady,
      loopTotal: loopSources.length,
    };
  }, [nodes, edges, flags, groupId, variables]);

  const nodeLabel = (id: string) => {
    const n = members.find((m) => m.id === id);
    return (n?.data as { displayName?: string } | undefined)?.displayName || id;
  };

  const focusTarget = (issue: StoryIssue): string | undefined => {
    if (issue.nodeId) return issue.nodeId;
    if (issue.edgeId) return storyEdges.find((e) => e.id === issue.edgeId)?.source;
    return undefined;
  };

  const targetLabel = (issue: StoryIssue): string | null => {
    if (issue.nodeId) return nodeLabel(issue.nodeId);
    if (issue.edgeId) {
      const e = storyEdges.find((x) => x.id === issue.edgeId);
      const text = (e?.data as { choiceText?: string } | undefined)?.choiceText;
      return text || (e ? nodeLabel(e.source) : null);
    }
    return null;
  };

  const handleClick = (issue: StoryIssue) => {
    const target = focusTarget(issue);
    if (target) {
      setSelectedNode(target);
      requestFocusNode(target);
    }
    onClose();
  };

  return (
    <div style={FREEZONE_DOCK_OFFSET_ANIMATED_STYLE} className="absolute right-4 top-16 z-30 max-h-[min(60vh,calc(100%_-_5rem))] w-80 max-w-[calc(100%_-_2rem_-_var(--freezone-dock-width,0px))] overflow-y-auto rounded-xl border border-white/15 bg-[#17191d]/97 p-3 text-white/90 shadow-2xl backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">{t('canvas.story.lint.title')}</span>
        <button onClick={onClose} aria-label={t('common.close')} className="text-white/60 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-x-3 gap-y-1 rounded-lg bg-white/[0.04] px-2.5 py-2 text-[11px] text-white/60">
        <span>{t('canvas.story.lint.videoReady')}</span>
        <span className="text-right tabular-nums text-white/85">{videoReady}/{members.length}</span>
        <span>{t('canvas.story.lint.promptReady')}</span>
        <span className="text-right tabular-nums text-white/85">{promptReady}/{members.length}</span>
        {loopTotal > 0 && <>
          <span>{t('canvas.story.lint.loopReady')}</span>
          <span className="text-right tabular-nums text-white/85">{loopReady}/{loopTotal}</span>
        </>}
        <span>{t('canvas.story.lint.playDuration')}</span>
        <span className="text-right tabular-nums text-white/85">
          {durationRange
            ? t('canvas.story.lint.durationRange', {
                min: Math.round(durationRange.minMs / 1000),
                max: Math.round(durationRange.maxMs / 1000),
                suffix: durationRange.complete ? '' : t('canvas.story.lint.durationIncomplete'),
              })
            : t('canvas.story.lint.durationUnavailable')}
        </span>
      </div>

      {issues.length === 0 ? (
        <div className="flex items-center gap-2 py-3 text-sm text-emerald-400">
          <CheckCircle2 className="h-4 w-4" />
          {t('canvas.story.lint.empty')}
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {issues.map((issue, i) => {
            const Icon = SEVERITY_ICON[issue.severity];
            const label = targetLabel(issue);
            return (
              <li key={`${issue.code}-${issue.nodeId ?? issue.edgeId ?? i}`}>
                <button
                  onClick={() => handleClick(issue)}
                  className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-white/[0.06]"
                >
                  <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${SEVERITY_COLOR[issue.severity]}`} />
                  <span className="min-w-0 flex-1">
                    <span className="text-white/85">
                      {t(`canvas.story.lint.codes.${issue.code}`, { detail: issue.detail ?? '' })}
                    </span>
                    {label && <span className="ml-1 text-white/45">· {label}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});
