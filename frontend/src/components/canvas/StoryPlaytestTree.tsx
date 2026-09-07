import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CircleAlert,
  ChevronDown,
  ChevronRight,
  CornerUpLeft,
  Filter,
  Flag,
  LayoutTemplate,
  ListCollapse,
  ListTree,
  Plus,
  Search,
  SquarePlay,
  Timer,
} from 'lucide-react';

import { isVideoNode } from '@/features/canvas/domain/canvasNodes';
import { buildStoryTree, type StoryTreeRow } from '@/features/canvas/story/buildStoryTree';
import { STORY_CHOICE_EDGE_TYPE } from '@/features/canvas/story/storyTypes';
import {
  selectGroupStoryFlags,
  selectGroupStoryVariables,
} from '@/features/canvas/story/storyVariableSelectors';
import { useCanvasStore } from '@/stores/canvasStore';
import { ScrollArea } from '@/components/ui/scroll-area';

interface StoryPlaytestTreeProps {
  groupId: string;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  onAddNode: () => void;
}

function collectExpandable(row: StoryTreeRow | null, target: Set<string>): void {
  if (!row) return;
  if (row.children.length > 0) target.add(row.nodeId);
  row.children.forEach((child) => collectExpandable(child, target));
}

function filterRow(row: StoryTreeRow, query: string, issuesOnly: boolean): StoryTreeRow | null {
  const children = row.children
    .map((child) => filterRow(child, query, issuesOnly))
    .filter((child): child is StoryTreeRow => child !== null);
  const matchesQuery = !query
    || row.label.toLocaleLowerCase().includes(query)
    || (row.incomingChoiceText ?? '').toLocaleLowerCase().includes(query);
  const matchesIssue = !issuesOnly || row.issues.length > 0;
  return (matchesQuery && matchesIssue) || children.length > 0 ? { ...row, children } : null;
}

const ERROR_ISSUES = new Set([
  'no_start',
  'undefined_variable',
  'undefined_flag',
  'dangling_edge',
  'dangling_visit',
  'automatic_fallback_order',
  'variable_out_of_bounds',
  'automatic_cycle',
]);

/** 实时生成工作台左栏：把画布 DAG 投影为可折叠树，重复节点只显示引用行。 */
export const StoryPlaytestTree = memo(function StoryPlaytestTree({
  groupId,
  selectedNodeId,
  onSelectNode,
  onAddNode,
}: StoryPlaytestTreeProps) {
  const { t } = useTranslation();
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const [query, setQuery] = useState('');
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const treeRootRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!selectedNodeId) return;
    const active = Array.from(
      treeRootRef.current?.querySelectorAll<HTMLElement>('[data-story-node-id]') ?? [],
    ).find((element) => element.dataset.storyNodeId === selectedNodeId);
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selectedNodeId]);

  useEffect(() => {
    const viewport = treeRootRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      // 普通滚轮保持纵向；Shift+滚轮查看深层长标题，触控板的原生横向手势照常生效。
      if (!event.shiftKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      viewport.scrollLeft += event.deltaY;
      event.preventDefault();
    };
    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', handleWheel);
  }, []);

  const members = useMemo(
    () => nodes.filter((node) => node.parentId === groupId && isVideoNode(node)),
    [groupId, nodes],
  );
  const model = useMemo(() => {
    const memberIds = new Set(members.map((node) => node.id));
    const storyEdges = edges.filter(
      (edge) => edge.type === STORY_CHOICE_EDGE_TYPE && memberIds.has(edge.source),
    );
    return buildStoryTree(
      members,
      storyEdges,
      selectGroupStoryVariables(nodes, groupId),
      selectGroupStoryFlags(nodes, groupId),
    );
  }, [edges, groupId, members, nodes]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleRoot = useMemo(
    () => model.root ? filterRow(model.root, normalizedQuery, issuesOnly) : null,
    [issuesOnly, model.root, normalizedQuery],
  );
  const visibleOrphans = useMemo(
    () => model.orphans.filter((orphan) => {
      const matchesQuery = !normalizedQuery
        || orphan.label.toLocaleLowerCase().includes(normalizedQuery);
      return matchesQuery && (!issuesOnly || orphan.issues.length > 0);
    }),
    [issuesOnly, model.orphans, normalizedQuery],
  );
  const expandableIds = useMemo(() => {
    const ids = new Set<string>();
    collectExpandable(model.root, ids);
    return ids;
  }, [model.root]);
  const allCollapsed = expandableIds.size > 0
    && Array.from(expandableIds).every((id) => collapsed.has(id));

  const toggle = (nodeId: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  const renderRow = (row: StoryTreeRow): ReactNode => {
    const hasChildren = row.children.length > 0;
    const isCollapsed = collapsed.has(row.nodeId) && !normalizedQuery && !issuesOnly;
    const active = selectedNodeId === row.nodeId;
    const hasError = row.issues.some((issue) => ERROR_ISSUES.has(issue));
    const NodeIcon = row.repeated
      ? CornerUpLeft
      : row.isEnding
        ? Flag
        : row.depth === 0
          ? SquarePlay
          : LayoutTemplate;
    return (
      <div
        key={`${row.nodeId}-${row.depth}-${row.incomingChoiceText ?? ''}`}
        data-story-node-id={row.nodeId}
        className={row.depth > 0 ? 'ml-4 border-l border-white/[0.08] pl-1' : undefined}
      >
        <div
          className={`group/tree-row flex min-w-0 items-start gap-1 rounded-lg border px-1.5 py-1.5 transition-colors ${
            active
              ? 'border-[oklch(0.72_0.145_205/0.2)] bg-[oklch(0.72_0.145_205/0.1)] text-[oklch(0.72_0.145_205)]'
              : hasError
                ? 'border-transparent text-red-400 hover:bg-[#1a1c23]'
                : 'border-transparent text-[#e2e2e3] hover:bg-[#1a1c23]'
          }`}
        >
          {hasChildren ? (
            <button
              type="button"
              onClick={() => toggle(row.nodeId)}
              className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded text-[#8f9099] hover:bg-white/[0.06] hover:text-[#e2e2e3]"
              aria-label={isCollapsed ? t('canvas.story.tree.expand') : t('canvas.story.tree.collapse')}
            >
              {isCollapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            </button>
          ) : (
            <span className="size-5 shrink-0" />
          )}
          <button
            type="button"
            onClick={() => onSelectNode(row.nodeId)}
            className="flex min-w-0 flex-1 items-start gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[oklch(0.72_0.145_205)]"
            title={row.label}
            aria-current={active ? 'true' : undefined}
          >
            {hasError ? (
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-red-400" aria-label={t('canvas.story.tree.hasIssue')} />
            ) : (
              <NodeIcon className={`mt-0.5 size-4 shrink-0 ${active ? '' : 'text-[#8f9099]'}`} />
            )}
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="whitespace-nowrap text-sm font-medium leading-5">
                  {row.label}
                </span>
                {row.isTimedSource && <Timer className="size-3.5 shrink-0 text-[#8f9099]" />}
              </span>
              {row.incomingChoiceText && (
                <span className="mt-0.5 block whitespace-nowrap text-xs leading-4 text-[#8f9099]">
                  {row.repeated ? t('canvas.story.tree.referenceVia') : t('canvas.story.tree.choiceVia')}
                  {row.incomingChoiceText}
                </span>
              )}
            </span>
            {row.isEnding && (
              <span className="mt-0.5 inline-flex shrink-0 items-center rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-[#8f9099]">
                {row.endingLabel ?? t('canvas.story.tree.ending')}
              </span>
            )}
            {!hasError && !row.isEnding && !row.repeated && (
              <span
                aria-hidden
                className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                  active
                    ? 'bg-[oklch(0.72_0.145_205)] shadow-[0_0_8px_oklch(0.72_0.145_205/0.8)]'
                    : 'bg-white/20'
                }`}
              />
            )}
          </button>
        </div>
        {hasChildren && !isCollapsed && row.children.map(renderRow)}
      </div>
    );
  };

  return (
    <aside ref={treeRootRef} className="flex min-h-0 w-[340px] shrink-0 flex-col overflow-hidden border-r border-white/[0.08] bg-[#111218] text-[#e2e2e3]">
      <div className="shrink-0 border-b border-white/[0.08] p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-sm font-semibold">{t('canvas.story.tree.title')}</h2>
            <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-xs tabular-nums text-[#8f9099]">
              {members.length}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onAddNode}
              className="flex size-6 items-center justify-center rounded text-[#8f9099] transition hover:bg-[#1a1c23] hover:text-[#e2e2e3]"
              title={t('canvas.story.tree.addNode')}
              aria-label={t('canvas.story.tree.addNode')}
            >
              <Plus className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(expandableIds))}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-muted transition hover:bg-[rgb(var(--text-rgb)/0.1)] hover:text-text-dark"
              title={allCollapsed ? t('canvas.story.tree.expandAll') : t('canvas.story.tree.collapseAll')}
              aria-label={allCollapsed ? t('canvas.story.tree.expandAll') : t('canvas.story.tree.collapseAll')}
            >
              {allCollapsed ? (
                <ListTree className="h-3.5 w-3.5" />
              ) : (
                <ListCollapse className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              type="button"
              onClick={() => setIssuesOnly((value) => !value)}
              className={`flex size-6 items-center justify-center rounded ${
                issuesOnly
                  ? 'bg-[oklch(0.72_0.145_205/0.1)] text-[oklch(0.72_0.145_205)]'
                  : 'text-[#8f9099] hover:bg-[#1a1c23] hover:text-[#e2e2e3]'
              }`}
              title={t('canvas.story.tree.issuesOnly')}
              aria-label={t('canvas.story.tree.issuesOnly')}
              aria-pressed={issuesOnly}
            >
              <Filter className="size-4" />
            </button>
          </div>
        </div>
        <label className="flex h-8 items-center gap-2 rounded-md border border-white/[0.08] bg-[#1e212b] px-2.5 focus-within:border-[oklch(0.72_0.145_205/0.5)] focus-within:ring-2 focus-within:ring-[oklch(0.72_0.145_205/0.12)]">
          <Search className="size-4 shrink-0 text-[#8f9099]" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('canvas.story.tree.search')}
            className="min-w-0 flex-1 bg-transparent text-sm text-[#e2e2e3] outline-none placeholder:text-[#8f9099]"
          />
        </label>
      </div>

      <ScrollArea
        horizontal
        className="min-h-0 flex-1 [&_[data-slot=scroll-area-scrollbar]]:z-20 [&_[data-orientation=vertical]]:!w-3.5 [&_[data-orientation=vertical]]:!border-l [&_[data-orientation=horizontal]]:!h-3.5 [&_[data-orientation=horizontal]]:!border-t [&_[data-slot=scroll-area-scrollbar]]:!border-white/[0.08] [&_[data-slot=scroll-area-scrollbar]]:!bg-[#090a0e] [&_[data-slot=scroll-area-scrollbar]]:!p-0.5 [&_[data-orientation=vertical]_[data-slot=scroll-area-thumb]]:!min-h-8 [&_[data-orientation=horizontal]_[data-slot=scroll-area-thumb]]:!min-w-10 [&_[data-slot=scroll-area-thumb]]:!bg-[oklch(0.72_0.145_205/0.68)] [&_[data-slot=scroll-area-thumb]]:!shadow-[0_0_8px_oklch(0.72_0.145_205/0.22)] hover:[&_[data-slot=scroll-area-thumb]]:!bg-[oklch(0.72_0.145_205/0.92)]"
        role="region"
        aria-label={t('canvas.story.tree.title')}
      >
        <div className="w-max min-w-full p-2 pb-4 pr-3">
        {model.noStart && (
          <p className="mb-2 rounded-lg bg-red-400/10 px-3 py-2 text-xs text-red-300">
            {t('canvas.story.tree.noStart')}
          </p>
        )}
        {visibleRoot && <div className="space-y-0.5">{renderRow(visibleRoot)}</div>}
        {visibleOrphans.length > 0 && (
          <div className="mt-3 border-t border-white/[0.08] pt-3">
            <p className="mb-1.5 px-2 text-xs font-medium text-[#8f9099]">
              {t('canvas.story.tree.orphans')}
            </p>
            {visibleOrphans.map((orphan) => (
              <button
                type="button"
                key={orphan.nodeId}
                onClick={() => onSelectNode(orphan.nodeId)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-[#e2e2e3] hover:bg-[#1a1c23]"
              >
                <LayoutTemplate className="size-4 shrink-0 text-[#8f9099]" />
                <span className="min-w-0 flex-1 whitespace-nowrap">{orphan.label}</span>
                {orphan.issues.some((issue) => ERROR_ISSUES.has(issue)) && (
                  <CircleAlert className="size-3.5 shrink-0 text-red-400" />
                )}
              </button>
            ))}
          </div>
        )}
        {!visibleRoot && visibleOrphans.length === 0 && (
          <p className="px-3 py-8 text-center text-sm text-[#8f9099]">
            {normalizedQuery || issuesOnly
              ? t('canvas.story.tree.noResults')
              : t('canvas.story.tree.empty')}
          </p>
        )}
        </div>
      </ScrollArea>
    </aside>
  );
});
