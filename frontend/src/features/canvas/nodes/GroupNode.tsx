// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position, useReactFlow } from '@xyflow/react';
import {
  FileText,
  Film,
  History,
  Image as ImageIcon,
  LayoutGrid,
  Music,
  Play,
  Plus,
  RefreshCw,
  Upload,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { uploadFreezoneImage } from '@/api/ops';
import { readUrl } from '@/lib/url-params';
import { CanvasHistoryAssetsModal } from '@/features/canvas/ui/CanvasHistoryAssetsModal';
import type { CanvasAsset } from '@/features/canvas/domain/canvasAssets';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { canvasNodeFrameClass } from '@/features/canvas/ui/nodeFrameStyles';
import {
  groupColorBackground,
  groupColorBorder,
} from '@/features/canvas/domain/groupColors';
import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
  type GroupNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { computeSnapAlign } from '@/features/canvas/snap-align/computeSnapAlign';
import { useSnapAlignStore } from '@/features/canvas/snap-align/snapAlignStore';
import {
  STORYBOARD_CELL_GAP,
  STORYBOARD_HEADER_PADDING,
  STORYBOARD_PADDING,
  computeStoryboardBoardLayout,
  resolveStoryboardCols,
  storyboardSlotRect,
} from '@/features/canvas/domain/storyboardGroup';
import {
  getStoryboardCellPreview,
  type StoryboardCellKind,
} from '@/features/canvas/domain/storyboardCellPreview';
import { useCanvasProjectionStatus } from '@/features/freezone/projectionStatusStore';
import { useCanvasStore } from '@/stores/canvasStore';
import { useShallow } from 'zustand/react/shallow';

type GroupNodeProps = {
  id: string;
  data: GroupNodeData;
  selected?: boolean;
};

interface DragState {
  from: number;
  start: { x: number; y: number };
  cur: { x: number; y: number };
}

const CELL_PLACEHOLDER_ICON: Record<StoryboardCellKind, typeof ImageIcon> = {
  image: ImageIcon,
  video: Film,
  audio: Music,
  script: FileText,
  empty: ImageIcon,
};

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

export const GroupNode = memo(({ id, data, selected }: GroupNodeProps) => {
  const { t } = useTranslation();
  const reactFlow = useReactFlow();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const isStoryboard = data.storyboardGroup === true;
  const showIndex = isStoryboard && data.storyboardShowIndex === true;

  // 只订阅本组自身节点 + 其成员节点(useShallow 逐元素比较)。groupPosition / board /
  // childGeometrySignature 都只依赖这些;拖动组外无关节点时本 GroupNode 不再重渲染。
  const groupScopedNodes = useCanvasStore(
    useShallow((state) => state.nodes.filter((node) => node.id === id || node.parentId === id))
  );
  const childCount = groupScopedNodes.reduce(
    (acc, node) => (node.parentId === id ? acc + 1 : acc),
    0
  );
  const fitGroupToChildren = useCanvasStore((state) => state.fitGroupToChildren);
  const reorderStoryboardMember = useCanvasStore((state) => state.reorderStoryboardMember);
  const addStoryboardMembers = useCanvasStore((state) => state.addStoryboardMembers);
  const deleteNode = useCanvasStore((state) => state.deleteNode);
  const isInteracting = useCanvasStore((state) => state.dragHistorySnapshot !== null);

  // Add-to-empty-slot: a small menu (local upload / history), both image-only.
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addMenuAnchor, setAddMenuAnchor] = useState<{ cx: number; cy: number } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const addMenuRef = useRef<HTMLDivElement | null>(null);

  const handleLocalUploadFiles = useCallback(
    async (files: FileList | null) => {
      setAddMenuOpen(false);
      if (!files || files.length === 0) {
        return;
      }
      const imageFiles = Array.from(files).filter((file) => file.type.startsWith('image/'));
      if (imageFiles.length === 0) {
        toast(t('canvas.storyboardGroup.imageOnlyHint'));
        return;
      }
      const projectId = readUrl().project;
      if (!projectId) {
        return;
      }
      setUploading(true);
      try {
        const uploaded = await Promise.all(
          imageFiles.map(async (file) => {
            const result = await uploadFreezoneImage(projectId, file, file.name);
            return { imageUrl: result.url, previewImageUrl: result.url, displayName: file.name };
          })
        );
        addStoryboardMembers(id, uploaded);
      } catch (error) {
        console.error('[storyboard] upload failed', error);
        toast(t('canvas.storyboardGroup.uploadFailed'));
      } finally {
        setUploading(false);
      }
    },
    [addStoryboardMembers, id, t]
  );

  const handlePickHistoryAsset = useCallback(
    (asset: CanvasAsset) => {
      setHistoryOpen(false);
      addStoryboardMembers(id, [
        { imageUrl: asset.url, previewImageUrl: asset.previewUrl ?? asset.url, displayName: asset.label ?? undefined },
      ]);
    },
    [addStoryboardMembers, id]
  );

  useEffect(() => {
    if (!addMenuOpen) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (addMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      setAddMenuOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [addMenuOpen]);
  const snapEnabled = useSnapAlignStore((state) => state.enabled);
  const setSnapGuides = useSnapAlignStore((state) => state.setGuides);
  const clearSnapGuides = useSnapAlignStore((state) => state.clearGuides);

  // This group's absolute flow position — used to map thumbnail cells (group-local
  // coords) into canvas flow coords for snap-align.
  const groupPosition = useMemo(() => {
    const self = groupScopedNodes.find((node) => node.id === id);
    return self?.position ?? { x: 0, y: 0 };
  }, [groupScopedNodes, id]);

  // Thumbnail board: member previews (reading order) + grid geometry. The grid
  // matches the box the store sized via `computeStoryboardBoardLayout`.
  const board = useMemo(() => {
    if (!isStoryboard) {
      return null;
    }
    const members = groupScopedNodes
      .filter((node) => node.parentId === id)
      .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
    const layout = computeStoryboardBoardLayout({
      count: members.length,
      cols: resolveStoryboardCols(members.length, data.storyboardCols),
      aspectKey: data.storyboardAspect,
    });
    return {
      previews: members.map((node) => getStoryboardCellPreview(node)),
      cols: layout.cols,
      rows: layout.rows,
      cellWidth: layout.cellWidth,
      cellHeight: layout.cellHeight,
    };
  }, [groupScopedNodes, id, isStoryboard, data.storyboardCols, data.storyboardAspect]);
  const count = board?.previews.length ?? 0;

  // --- Drag-to-reorder (pointer based, with floating preview + live reflow) ---
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  // Which slot the dragged thumbnail is hovering, from the pointer delta in flow
  // coords (screen delta ÷ zoom). Used for both the live reflow and the commit.
  const resolveOverIndex = useCallback(
    (state: DragState): number => {
      if (!board || count === 0) {
        return 0;
      }
      const zoom = reactFlow.getViewport().zoom || 1;
      const dx = (state.cur.x - state.start.x) / zoom;
      const dy = (state.cur.y - state.start.y) / zoom;
      const fromRect = storyboardSlotRect(state.from, board.cols, board.cellWidth, board.cellHeight);
      const centerX = fromRect.x + dx + board.cellWidth / 2;
      const centerY = fromRect.y + dy + board.cellHeight / 2;
      const col = clamp(
        Math.round((centerX - STORYBOARD_PADDING) / (board.cellWidth + STORYBOARD_CELL_GAP)),
        0,
        board.cols - 1
      );
      const row = clamp(
        Math.round((centerY - STORYBOARD_HEADER_PADDING) / (board.cellHeight + STORYBOARD_CELL_GAP)),
        0,
        board.rows - 1
      );
      return clamp(row * board.cols + col, 0, count - 1);
    },
    [board, count, reactFlow]
  );

  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) {
      return;
    }
    const onMove = (event: PointerEvent) => {
      setDrag((prev) => (prev ? { ...prev, cur: { x: event.clientX, y: event.clientY } } : prev));
    };
    const onUp = () => {
      const state = dragRef.current;
      if (state) {
        const over = resolveOverIndex(state);
        if (over !== state.from) {
          reorderStoryboardMember(id, state.from, over);
        }
      }
      clearSnapGuides();
      setDrag(null);
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    return () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onUp, true);
    };
  }, [dragging, id, reorderStoryboardMember, resolveOverIndex, clearSnapGuides]);

  // Visual order while dragging: the dragged index removed and re-inserted at the
  // hovered slot, so every other cell reflows around the gap it will land in.
  const overIndex = drag ? resolveOverIndex(drag) : null;
  const slotOf = useMemo(() => {
    const order = Array.from({ length: count }, (_, index) => index);
    if (drag && overIndex !== null) {
      order.splice(drag.from, 1);
      order.splice(overIndex, 0, drag.from);
    }
    const map = new Map<number, number>();
    order.forEach((original, slot) => map.set(original, slot));
    return map;
  }, [count, drag, overIndex]);

  // Floating preview for the dragged thumbnail. When snap-align is on, the
  // thumbnail is mapped into flow coords and aligned against the other cells via
  // the shared computeSnapAlign, producing the same guide lines node drag does.
  const floating = useMemo(() => {
    if (!drag || !board) {
      return null;
    }
    const zoom = reactFlow.getViewport().zoom || 1;
    const fromRect = storyboardSlotRect(drag.from, board.cols, board.cellWidth, board.cellHeight);
    const rawLeft = fromRect.x + (drag.cur.x - drag.start.x) / zoom;
    const rawTop = fromRect.y + (drag.cur.y - drag.start.y) / zoom;
    let left = rawLeft;
    let top = rawTop;
    let guides = { vertical: [] as number[], horizontal: [] as number[] };

    if (snapEnabled) {
      const draggedFlow = { x: groupPosition.x + rawLeft, y: groupPosition.y + rawTop };
      const pseudo = {
        position: draggedFlow,
        width: board.cellWidth,
        height: board.cellHeight,
      } as unknown as CanvasNode;
      const others: CanvasNode[] = [];
      for (let index = 0; index < count; index += 1) {
        if (index === drag.from) {
          continue;
        }
        const slot = slotOf.get(index) ?? index;
        const rect = storyboardSlotRect(slot, board.cols, board.cellWidth, board.cellHeight);
        others.push({
          position: { x: groupPosition.x + rect.x, y: groupPosition.y + rect.y },
          width: board.cellWidth,
          height: board.cellHeight,
        } as unknown as CanvasNode);
      }
      const snap = computeSnapAlign(pseudo, draggedFlow, others);
      left = snap.position.x - groupPosition.x;
      top = snap.position.y - groupPosition.y;
      guides = snap.guides;
    }

    return {
      left,
      top,
      width: board.cellWidth,
      height: board.cellHeight,
      preview: board.previews[drag.from],
      guides,
    };
  }, [drag, board, reactFlow, snapEnabled, groupPosition, count, slotOf]);

  // Push the live alignment guides to the shared snap store so SnapAlignGuides
  // (mounted in Canvas) renders them across the canvas during the reorder.
  useEffect(() => {
    if (!dragging || !snapEnabled || !floating) {
      return;
    }
    setSnapGuides(floating.guides);
  }, [dragging, snapEnabled, floating, setSnapGuides]);

  const emptyCells = useMemo(() => {
    if (!board) {
      return [];
    }
    const rects = [];
    for (let index = count; index < board.cols * board.rows; index += 1) {
      rects.push(storyboardSlotRect(index, board.cols, board.cellWidth, board.cellHeight));
    }
    return rects;
  }, [board, count]);

  // Plain groups auto-fit to enclose their children (covers nodes that grow when
  // their image loads). Storyboard groups size from the board, so skip them.
  const childGeometrySignature = useMemo(
    () =>
      isStoryboard
        ? ''
        : groupScopedNodes
            .filter((node) => node.parentId === id)
            .map(
              (node) =>
                `${node.id}:${Math.round(node.position.x)},${Math.round(node.position.y)},${Math.round(
                  node.measured?.width ?? (typeof node.width === 'number' ? node.width : 0)
                )},${Math.round(node.measured?.height ?? (typeof node.height === 'number' ? node.height : 0))}`
            )
            .join('|'),
    [groupScopedNodes, id, isStoryboard]
  );

  useEffect(() => {
    if (isStoryboard || isInteracting) {
      return;
    }
    fitGroupToChildren(id);
  }, [childGeometrySignature, isStoryboard, isInteracting, fitGroupToChildren, id]);

  const resolvedTitle = useMemo(
    () => resolveNodeDisplayName(CANVAS_NODE_TYPES.group, data),
    [data]
  );
  const headerTitle = isStoryboard
    ? t('canvas.storyboardGroup.headerCount', { count: childCount })
    : resolvedTitle;
  const projectionKey =
    data.user_spawned !== true &&
    typeof data.projection_key === 'string' &&
    data.projection_key.trim()
      ? data.projection_key.trim()
      : null;
  const projectionStatus = useCanvasProjectionStatus(projectionKey);
  const projectionIsStale = projectionStatus?.stale === true;
  // 黄色呼吸边框是「这个组来自主线」的常驻标识，不是只有待更新时才亮；有更新时
  // 换成更亮更快的那一档。两个 class 都动 border-color，只能二选一。
  const projectionFrameClass = projectionIsStale
    ? 'projection-stale-frame'
    : projectionKey
      ? 'projection-frame'
      : '';

  return (
    <div
      className={`group relative h-full w-full overflow-visible rounded-[18px] border ${canvasNodeFrameClass({ selected })} ${projectionFrameClass}`}
      style={{
        backgroundColor:
          (!isStoryboard && groupColorBackground(data.backgroundColor)) ||
          'var(--group-node-bg)',
        // 选中时让选中高亮边框生效，未选中时用组配色描边。
        borderColor:
          !isStoryboard && !selected
            ? groupColorBorder(data.backgroundColor)
            : undefined,
      }}
    >
      <NodeHeader
        // Storyboard groups only drag by this header (dragHandle on the node), so
        // dragging a thumbnail reorders instead of moving the whole board.
        className={`${NODE_HEADER_FLOATING_POSITION_CLASS}${
          isStoryboard ? ' storyboard-group-drag-handle' : ''
        }`}
        icon={<LayoutGrid className="h-4 w-4" />}
        titleText={headerTitle}
        editable={!isStoryboard}
        onTitleChange={(nextTitle) => updateNodeData(id, {
          displayName: nextTitle,
          label: nextTitle,
        })}
      />

      {isStoryboard
        ? emptyCells.map((rect, index) => (
            <button
              key={`empty-${index}`}
              type="button"
              // Click an empty slot to add an image (upload / history).
              className="nodrag nopan absolute flex items-center justify-center rounded-lg border border-dashed border-white/[0.12] bg-white/[0.015] transition-colors hover:border-white/30 hover:bg-white/[0.04]"
              style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                setAddMenuAnchor({ cx: rect.x + rect.width / 2, cy: rect.y + rect.height / 2 });
                setAddMenuOpen(true);
              }}
            >
              {uploading ? (
                <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white/60" />
              ) : (
                <Plus className="h-7 w-7 text-white/25" />
              )}
            </button>
          ))
        : null}

      {isStoryboard && addMenuOpen && addMenuAnchor ? (
        <div
          ref={addMenuRef}
          className="nodrag nopan nowheel absolute z-[60] flex w-52 flex-col overflow-hidden rounded-xl border border-white/10 bg-[#242426]/95 p-1.5 text-text-dark shadow-[0_12px_32px_rgba(0,0,0,0.45)] backdrop-blur-2xl"
          style={{ left: addMenuAnchor.cx, top: addMenuAnchor.cy, transform: 'translate(-50%, -50%)' }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="flex h-10 items-center gap-2.5 rounded-[10px] px-3 text-left text-sm hover:bg-[rgba(255,255,255,0.075)]"
            onClick={(event) => {
              event.stopPropagation();
              setAddMenuOpen(false);
              fileInputRef.current?.click();
            }}
          >
            <Upload className="h-4 w-4 text-text-muted" />
            <span>{t('canvas.storyboardGroup.localUpload')}</span>
          </button>
          <button
            type="button"
            className="flex h-10 items-center gap-2.5 rounded-[10px] px-3 text-left text-sm hover:bg-[rgba(255,255,255,0.075)]"
            onClick={(event) => {
              event.stopPropagation();
              setAddMenuOpen(false);
              setHistoryOpen(true);
            }}
          >
            <History className="h-4 w-4 text-text-muted" />
            <span>{t('canvas.storyboardGroup.fromHistory')}</span>
          </button>
        </div>
      ) : null}

      {isStoryboard ? (
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(event) => {
            void handleLocalUploadFiles(event.target.files);
            event.target.value = '';
          }}
        />
      ) : null}

      {historyOpen ? (
        <CanvasHistoryAssetsModal
          imageOnly
          assetSource="live-canvas"
          onClose={() => setHistoryOpen(false)}
          onUseAsset={handlePickHistoryAsset}
          onDeleteNode={(nodeId) => deleteNode(nodeId)}
        />
      ) : null}

      {isStoryboard && board
        ? board.previews.map((preview, index) => {
            if (drag && drag.from === index) {
              // Rendered as the floating preview below; leave its target slot as a gap.
              return null;
            }
            const slot = slotOf.get(index) ?? index;
            const rect = storyboardSlotRect(slot, board.cols, board.cellWidth, board.cellHeight);
            const PlaceholderIcon = CELL_PLACEHOLDER_ICON[preview.kind];
            return (
              <div
                key={preview.nodeId}
                // `nodrag` so the pointer gesture reorders the thumbnail instead of
                // moving the whole group node.
                className="nodrag nopan absolute cursor-grab overflow-hidden rounded-lg border border-white/[0.08] bg-black/35 active:cursor-grabbing"
                style={{
                  left: rect.x,
                  top: rect.y,
                  width: rect.width,
                  height: rect.height,
                  transition: drag ? 'left 150ms ease, top 150ms ease' : undefined,
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0) {
                    return;
                  }
                  event.stopPropagation();
                  setDrag({
                    from: index,
                    start: { x: event.clientX, y: event.clientY },
                    cur: { x: event.clientX, y: event.clientY },
                  });
                }}
              >
                {preview.imageUrl ? (
                  <img
                    src={preview.imageUrl}
                    alt=""
                    draggable={false}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-white/25">
                    <PlaceholderIcon className="h-7 w-7" />
                  </div>
                )}
                {preview.kind === 'video' && preview.imageUrl ? (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/45 backdrop-blur-sm">
                      <Play className="h-4 w-4 fill-white text-white" />
                    </span>
                  </div>
                ) : null}
                {showIndex ? (
                  <span className="pointer-events-none absolute left-1.5 top-1.5 flex h-5 min-w-5 items-center justify-center rounded bg-black/55 px-1 text-[11px] font-semibold text-white/90 backdrop-blur-sm">
                    {(slotOf.get(index) ?? index) + 1}
                  </span>
                ) : null}
              </div>
            );
          })
        : null}

      {floating ? (
        <div
          className="pointer-events-none absolute z-50 overflow-hidden rounded-lg border border-white/20 bg-black/35 shadow-[0_18px_40px_rgba(0,0,0,0.55)]"
          style={{
            left: floating.left,
            top: floating.top,
            width: floating.width,
            height: floating.height,
          }}
        >
          {floating.preview.imageUrl ? (
            <img
              src={floating.preview.imageUrl}
              alt=""
              draggable={false}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-white/25">
              <ImageIcon className="h-7 w-7" />
            </div>
          )}
        </div>
      ) : null}

      {projectionIsStale ? (
        <div className="projection-stale-banner pointer-events-none absolute left-3 top-3 z-20 inline-flex max-w-[calc(100%-1.5rem)] items-center gap-2 rounded-lg border border-amber-300/45 bg-[#241806]/90 px-3 py-1.5 text-xs font-semibold text-amber-100 shadow-[0_10px_28px_rgba(0,0,0,0.28)] backdrop-blur-md">
          <RefreshCw className="h-3.5 w-3.5 shrink-0 text-amber-200" />
          <span className="truncate">{t('freezone.projections.staleBadge')}</span>
        </div>
      ) : null}
      {/* Storyboard boards expose handles so an upstream node's edge can connect
          to the board after its image member is absorbed as a thumbnail. */}
      {isStoryboard ? (
        <>
          <Handle
            type="target"
            id="target"
            position={Position.Left}
            className="!h-2 !w-2 !border-surface-dark !bg-[rgb(148,163,184)]"
          />
          <Handle
            type="source"
            id="source"
            position={Position.Right}
            className="!h-2 !w-2 !border-surface-dark !bg-[rgb(148,163,184)]"
          />
        </>
      ) : null}

      {!isStoryboard ? (
        <NodeResizeHandle
          minWidth={220}
          minHeight={140}
          maxWidth={2200}
          maxHeight={1600}
          visible={Boolean(selected)}
        />
      ) : null}
    </div>
  );
});

GroupNode.displayName = 'GroupNode';
