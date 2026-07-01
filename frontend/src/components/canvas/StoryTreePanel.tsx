import { memo, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { AlertCircle, AlertTriangle, ChevronDown, ChevronRight, Flag, RotateCcw, Timer, X } from 'lucide-react';

import { useCanvasStore } from '@/stores/canvasStore';
import { isVideoNode } from '@/features/canvas/domain/canvasNodes';
import { STORY_CHOICE_EDGE_TYPE } from '@/features/canvas/story/storyTypes';
import { selectGroupStoryVariables } from '@/features/canvas/story/storyVariableSelectors';
import { buildStoryTree, type StoryTreeRow } from '@/features/canvas/story/buildStoryTree';

/** 剧情树面板:故事组的只读俯瞰大纲 + 校验,点击行聚焦画布节点。 */
export const StoryTreePanel = memo(function StoryTreePanel({
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
  const setSelectedNode = useCanvasStore((s) => s.setSelectedNode);
  const requestFocusNode = useCanvasStore((s) => s.requestFocusNode);

  const model = useMemo(() => {
    const members = nodes.filter((n) => n.parentId === groupId && isVideoNode(n));
    const memberIds = new Set(members.map((n) => n.id));
    const storyEdges = edges.filter((e) => e.type === STORY_CHOICE_EDGE_TYPE && memberIds.has(e.source));
    return buildStoryTree(members, storyEdges, variables);
  }, [nodes, edges, groupId, variables]);

  // 折叠集:存「已折叠」的 nodeId,默认全展开。
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const focus = (nodeId: string) => {
    setSelectedNode(nodeId);
    requestFocusNode(nodeId);
  };

  const renderRow = (row: StoryTreeRow): ReactNode => {
    const hasChildren = row.children.length > 0;
    const isCollapsed = collapsed.has(row.nodeId);
    return (
      <div key={`${row.nodeId}-${row.depth}-${row.incomingChoiceText ?? ''}`}>
        <div className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-white/5" style={{ paddingLeft: row.depth * 14 + 4 }}>
          {hasChildren ? (
            <button onClick={() => toggle(row.nodeId)} className="shrink-0 text-white/50 hover:text-white/80" aria-label="toggle">
              {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
          ) : (
            <span className="inline-block w-3.5 shrink-0" />
          )}
          <button onClick={() => focus(row.nodeId)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
            {row.incomingChoiceText && <span className="shrink-0 text-white/45">[{row.incomingChoiceText}]</span>}
            <span className="truncate text-white/90">{row.label}</span>
            {row.hasCondition && <span className="shrink-0 text-white/45" title={t('canvas.story.condition')}>{'{}'}</span>}
            {row.isTimedSource && <Timer className="h-3 w-3 shrink-0 text-white/45" />}
            {row.repeated && <RotateCcw className="h-3 w-3 shrink-0 text-white/40" aria-label={t('canvas.story.tree.repeated')} />}
            {row.isEnding && (
              <span className="inline-flex shrink-0 items-center gap-1 text-amber-300/80">
                <Flag className="h-3 w-3" />
                {row.endingLabel ?? t('canvas.story.endingFallback')}
              </span>
            )}
            {row.issues.map((code) => (
              <span key={code} className="shrink-0 text-[11px] text-red-400/80">
                {t(`canvas.story.lint.codes.${code}`, { detail: '' })}
              </span>
            ))}
          </button>
        </div>
        {hasChildren && !isCollapsed && row.children.map(renderRow)}
      </div>
    );
  };

  return (
    <div className="absolute right-4 top-16 z-30 flex max-h-[60vh] w-80 flex-col overflow-hidden rounded-md border border-white/15 bg-[#17191d]/97 text-sm text-white/90 shadow-2xl backdrop-blur">
      <div className="flex shrink-0 items-center justify-between px-3 pb-2 pt-3">
        <span className="flex items-center gap-2 text-sm font-medium">
          {t('canvas.story.tree.title')}
          {model.errorCount > 0 && (
            <span className="inline-flex items-center gap-0.5 text-xs text-red-400">
              <AlertCircle className="h-3.5 w-3.5" />{model.errorCount}
            </span>
          )}
          {model.warningCount > 0 && (
            <span className="inline-flex items-center gap-0.5 text-xs text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5" />{model.warningCount}
            </span>
          )}
        </span>
        <button onClick={onClose} aria-label={t('common.close')} className="text-white/60 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3">
      {model.noStart && <p className="mb-2 text-xs text-amber-300/90">{t('canvas.story.tree.noStart')}</p>}
      {model.root && <div className="text-xs">{renderRow(model.root)}</div>}
      {!model.root && model.orphans.length === 0 && (
        <p className="text-xs text-white/45">{t('canvas.story.tree.empty')}</p>
      )}

      {model.orphans.length > 0 && (
        <div className="mt-3 border-t border-white/10 pt-2">
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-white/45">
            {t('canvas.story.tree.orphans')}
          </p>
          {model.orphans.map((o) => (
            <button
              key={o.nodeId}
              onClick={() => focus(o.nodeId)}
              className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-white/5"
            >
              <span className="truncate text-white/80">{o.label}</span>
              {o.issues.map((code) => (
                <span key={code} className="shrink-0 text-[11px] text-amber-400/80">
                  {t(`canvas.story.lint.codes.${code}`, { detail: '' })}
                </span>
              ))}
            </button>
          ))}
        </div>
      )}
      </div>
    </div>
  );
});
