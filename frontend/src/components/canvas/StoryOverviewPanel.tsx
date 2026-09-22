// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 阶段C：只读剧本总览面板（fmv 专属视图，不接公有面板）。默认呈现剧情文案，
// 制作说明折叠展示，视频提示词不出现；行点击定位到画布节点后编辑，本面板
// 不提供任何写路径。

import { memo, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CornerDownLeft, RotateCcw, X } from 'lucide-react';

import { useCanvasStore } from '@/stores/canvasStore';
import {
  FREEZONE_DOCK_OFFSET_ANIMATED_STYLE,
} from '@/features/freezone/dockOffset';
import type { StoryTreeRow } from '@/features/canvas/story/buildStoryTree';
import {
  buildStoryOverview,
  type StoryOverviewModel,
} from '@/features/canvas/story/storyOverview';

function TreeRow({
  row,
  overview,
  onLocate,
}: {
  row: StoryTreeRow;
  overview: StoryOverviewModel;
  onLocate: (nodeId: string) => void;
}) {
  const { t } = useTranslation();
  const segment = overview.segmentsById.get(row.nodeId);
  const marker = row.repeated
    ? row.referenceKind === 'return'
      ? t('canvas.story.overview.loop')
      : t('canvas.story.overview.merge')
    : null;
  return (
    <li>
      <div
        className="flex flex-col gap-0.5 rounded-md px-1.5 py-1"
        style={{ marginLeft: Math.min(row.depth, 8) * 14 }}
      >
        <button
          type="button"
          onClick={() => onLocate(row.nodeId)}
          className="flex w-full items-center gap-1.5 text-left text-xs transition-colors hover:bg-white/[0.06]"
        >
          {row.incomingChoiceText && (
            <span className="inline-flex min-w-0 shrink items-center gap-1 text-white/45">
              <CornerDownLeft className="size-3 shrink-0" />
              <span className="truncate">
                {row.incomingChoiceText}
                {row.hasCondition ? ` · ${t('canvas.story.overview.conditional')}` : ''}
              </span>
            </span>
          )}
          <span className="shrink-0 font-medium text-white/85">{row.label}</span>
          {row.isEnding && (
            <span className="shrink-0 rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] text-white/70">
              {row.endingLabel || t('canvas.story.overview.ending')}
            </span>
          )}
          {marker && <span className="shrink-0 text-[10px] text-white/40">{marker}</span>}
          {segment && !segment.script && (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-amber-400">
              <AlertTriangle className="size-3" />
              {t('canvas.story.overview.missingScript')}
            </span>
          )}
        </button>
        {segment?.script && !row.repeated && (
          <p className="whitespace-pre-line pl-1 text-xs leading-relaxed text-white/65">{segment.script}</p>
        )}
        {segment?.productionNotes && !row.repeated && (
          <details className="pl-1 text-[11px] text-white/40">
            <summary className="cursor-pointer select-none">
              {t('canvas.story.overview.productionNotes')}
            </summary>
            <p className="mt-0.5 whitespace-pre-line">{segment.productionNotes}</p>
          </details>
        )}
      </div>
      {row.children.length > 0 && (
        <ul>
          {row.children.map((child) => (
            <TreeRow key={child.rowId} row={child} overview={overview} onLocate={onLocate} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** 故事组的只读剧本总览；由 StoryGroupToolbar「查看剧本」以 portal 挂载。 */
export const StoryOverviewPanel = memo(function StoryOverviewPanel({
  groupId,
  onClose,
}: {
  groupId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const nodes = useCanvasStore((s) => s.nodes);
  const edges = useCanvasStore((s) => s.edges);
  const setSelectedNode = useCanvasStore((s) => s.setSelectedNode);
  const requestFocusNode = useCanvasStore((s) => s.requestFocusNode);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const overview = useMemo(
    () => buildStoryOverview(groupId, nodes, edges),
    [groupId, nodes, edges],
  );

  if (!overview) return null;
  const locate = (nodeId: string) => {
    setSelectedNode(nodeId);
    requestFocusNode(nodeId);
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-label={t('canvas.story.overview.title')}
      // 与 lint/tree 面板同一让位协议：虾导抽屉开着时往左收，不被通高浮层盖住。
      style={FREEZONE_DOCK_OFFSET_ANIMATED_STYLE}
      className="fixed right-4 top-16 z-50 flex max-h-[min(78vh,calc(100%_-_5rem))] w-[420px] max-w-[calc(100%_-_2rem_-_var(--freezone-dock-width,0px))] flex-col rounded-xl border border-white/15 bg-[#17191d]/97 p-3 text-white/90 shadow-2xl backdrop-blur"
    >
      <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium">
          {t('canvas.story.overview.title')}
          {overview.title && <span className="ml-1.5 text-xs text-white/50">{overview.title}</span>}
        </span>
        <button onClick={onClose} aria-label={t('common.close')} className="shrink-0 text-white/60 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
        {overview.segmentCount === 0 ? (
          <p className="py-4 text-center text-xs text-white/45">{t('canvas.story.overview.empty')}</p>
        ) : (
          <>
            <section>
              <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-white/45">
                {t('canvas.story.overview.synopsis')}
              </h3>
              <p className="whitespace-pre-line text-xs leading-relaxed text-white/75">
                {overview.synopsis || t('canvas.story.overview.synopsisEmpty')}
              </p>
            </section>
            {overview.characters.length > 0 && (
              <section>
                <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-white/45">
                  {t('canvas.story.overview.characters')}
                </h3>
                <ul className="flex flex-col gap-1">
                  {overview.characters.map((character) => (
                    <li key={character.id} className="text-xs text-white/75">
                      <span className="font-medium text-white/90">{character.name}</span>
                      {character.description && (
                        <span className="ml-1.5 text-white/50">{character.description}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section>
              <h3 className="mb-1 flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-white/45">
                <span>{t('canvas.story.overview.branches')}</span>
                <span className="normal-case tracking-normal tabular-nums">
                  {t('canvas.story.overview.scriptReady', {
                    ready: overview.scriptReadyCount,
                    total: overview.segmentCount,
                  })}
                </span>
              </h3>
              {overview.tree.noStart && (
                <p className="mb-1 text-xs text-amber-400">{t('canvas.story.overview.noStart')}</p>
              )}
              {overview.tree.root && (
                <ul>
                  <TreeRow row={overview.tree.root} overview={overview} onLocate={locate} />
                </ul>
              )}
              {overview.tree.orphans.length > 0 && (
                <div className="mt-2">
                  <h4 className="mb-0.5 text-[11px] text-white/45">{t('canvas.story.overview.orphans')}</h4>
                  <ul className="flex flex-col gap-0.5">
                    {overview.tree.orphans.map((orphan) => (
                      <li key={orphan.nodeId}>
                        <button
                          type="button"
                          onClick={() => locate(orphan.nodeId)}
                          className="w-full rounded-md px-1.5 py-1 text-left text-xs text-white/60 transition-colors hover:bg-white/[0.06]"
                        >
                          {orphan.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
            {overview.endings.length > 0 && (
              <section>
                <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-white/45">
                  {t('canvas.story.overview.endings')}
                </h3>
                <ul className="flex flex-col gap-1">
                  {overview.endings.map((ending) => (
                    <li key={ending.label} className="text-xs text-white/70">
                      <RotateCcw className="mr-1 inline size-3 text-white/40" />
                      <span className="font-medium text-white/90">{ending.endingLabel ?? ''}</span>
                      {ending.endingLabel && ending.label && ' · '}
                      {ending.label}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
});
