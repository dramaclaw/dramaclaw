// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 阶段C：只读剧本总览面板（fmv 专属视图，不接公有面板）。默认呈现剧情文案，
// 制作说明折叠展示，视频提示词不出现；行点击定位到画布节点后编辑，本面板
// 不提供任何写路径。

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
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
import styles from './StoryOverviewPanel.module.css';

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
    <li className={styles.branchItem} data-root={row.depth === 0} data-story-branch-node={row.nodeId}>
      <div className={styles.branchBody} data-has-children={row.children.length > 0}>
        <button
          type="button"
          onClick={() => onLocate(row.nodeId)}
          className={styles.branchHeading}
        >
          <span className={styles.branchDot} aria-hidden="true" />
          <span className="min-w-0 flex-1 text-xs">
            <span className="block break-words font-medium text-white/85">{row.label}</span>
            {row.incomingChoiceText && (
              <span className="mt-0.5 flex min-w-0 items-start gap-1 text-white/55">
                <CornerDownLeft className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
                <span className="min-w-0 break-words">
                  {row.incomingChoiceText}
                  {row.hasCondition ? ` · ${t('canvas.story.overview.conditional')}` : ''}
                </span>
              </span>
            )}
          </span>
          {row.isEnding && (
            <span className="shrink-0 rounded-full bg-white/10 px-1.5 py-0.5 text-xs text-white/70">
              {row.endingLabel || t('canvas.story.overview.ending')}
            </span>
          )}
          {marker && <span className="shrink-0 text-xs text-white/55">{marker}</span>}
          {segment && !segment.script && (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-amber-400">
              <AlertTriangle className="size-3" />
              {t('canvas.story.overview.missingScript')}
            </span>
          )}
        </button>
        {segment?.script && !row.repeated && (
          <p className={`${styles.branchCopy} whitespace-pre-line text-xs leading-relaxed text-white/65`}>{segment.script}</p>
        )}
        {segment?.productionNotes && !row.repeated && (
          <details className={`${styles.branchCopy} text-xs text-white/55`}>
            <summary className="cursor-pointer select-none">
              {t('canvas.story.overview.productionNotes')}
            </summary>
            <p className="mt-0.5 whitespace-pre-line">{segment.productionNotes}</p>
          </details>
        )}
      </div>
      {row.children.length > 0 && (
        <ul className={`${styles.branchChildren} ${row.depth >= 8 ? styles.branchChildrenCompact : ''}`}>
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
  const [top, setTop] = useState(64);
  const [width, setWidth] = useState(420);
  const [resizing, setResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const resizeSession = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  const maxWidth = () => {
    const right = panelRef.current?.getBoundingClientRect().right;
    const viewportRight = typeof window === 'undefined' ? 1008 : window.innerWidth - 16;
    return Math.max(240, (right && right > 0 ? right : viewportRight) - 16);
  };
  const clampWidth = (next: number) => {
    const max = maxWidth();
    return Math.min(max, Math.max(Math.min(320, max), next));
  };
  const finishResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeSession.current?.pointerId !== event.pointerId) return;
    setWidth(clampWidth(resizeSession.current.startWidth + resizeSession.current.startX - event.clientX));
    resizeSession.current = null;
    setResizing(false);
    try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch { /* Capture may already be released. */ }
  };

  useEffect(() => {
    if (!resizing) return;
    const { body } = document;
    const previousCursor = body.style.cursor;
    const previousUserSelect = body.style.userSelect;
    body.style.cursor = 'col-resize';
    body.style.userSelect = 'none';
    return () => {
      body.style.cursor = previousCursor;
      body.style.userSelect = previousUserSelect;
    };
  }, [resizing]);

  useLayoutEffect(() => {
    const toolbar = document.querySelector('[data-story-toolbar-region]');
    if (!toolbar) return;
    const updateTop = () => setTop(Math.ceil(toolbar.getBoundingClientRect().bottom) + 8);
    updateTop();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateTop);
    observer?.observe(toolbar);
    window.addEventListener('resize', updateTop);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateTop);
    };
  }, []);

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
      ref={panelRef}
      role="dialog"
      aria-label={t('canvas.story.overview.title')}
      // 与 lint/tree 面板同一让位协议：虾导抽屉开着时往左收，不被通高浮层盖住。
      style={{ ...FREEZONE_DOCK_OFFSET_ANIMATED_STYLE, top, width, maxHeight: `min(78vh, calc(100dvh - ${top}px - 16px))` }}
      className="fixed right-4 z-50 flex max-w-[calc(100%_-_2rem_-_var(--freezone-dock-width,0px))] flex-col rounded-xl border border-white/15 bg-[#17191d]/97 p-3 text-white/90 shadow-2xl backdrop-blur"
    >
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label={t('canvas.story.overview.resize')}
        aria-valuemin={Math.min(320, maxWidth())}
        aria-valuemax={maxWidth()}
        aria-valuenow={Math.min(width, maxWidth())}
        className={styles.resizeHandle}
        data-resizing={resizing}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          resizeSession.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startWidth: panelRef.current?.getBoundingClientRect().width || width,
          };
          setResizing(true);
          try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* Pointer capture may be unavailable. */ }
        }}
        onPointerMove={(event) => {
          const session = resizeSession.current;
          if (session?.pointerId !== event.pointerId) return;
          setWidth(clampWidth(session.startWidth + session.startX - event.clientX));
        }}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={() => { resizeSession.current = null; setResizing(false); }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const current = panelRef.current?.getBoundingClientRect().width || width;
          setWidth(clampWidth(current + (event.key === 'ArrowLeft' ? 24 : -24)));
        }}
      />
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
                <ul className={styles.branchTree}>
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
