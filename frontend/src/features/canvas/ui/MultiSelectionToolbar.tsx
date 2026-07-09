// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  NodeToolbar as ReactFlowNodeToolbar,
  Position,
} from '@xyflow/react';
import {
  LayoutGrid,
  Workflow,
  StretchHorizontal,
  StretchVertical,
  Copy,
  Download,
  Loader2,
  ChevronDown,
  Group,
  Clapperboard,
  Trash2,
} from 'lucide-react';

import { useCanvasStore } from '@/stores/canvasStore';
import {
  CANVAS_NODE_TYPES,
  DEFAULT_NODE_WIDTH,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { computeAutoLayout } from '@/features/canvas/application/autoLayout';
import { collectBatchDeletableIds } from '@/features/canvas/domain/groupSelectionDelete';

// 合并分镜组只接受图片类节点。
const STORYBOARD_IMAGE_NODE_TYPES = new Set<string>([
  CANVAS_NODE_TYPES.upload,
  CANVAS_NODE_TYPES.imageEdit,
  CANVAS_NODE_TYPES.imageGen,
  CANVAS_NODE_TYPES.exportImage,
]);
const STORYBOARD_MAX_NODES = 25;
import { downloadUrlAsFile } from '@/lib/browserDownload';
import { ZoomScaledToolbar } from '@/features/canvas/ui/ZoomScaledToolbar';

// Gap (in flow units) kept between nodes when arranging.
const ARRANGE_GAP = 32;
// Fallback height when a node has not been measured yet.
const DEFAULT_NODE_HEIGHT = 320;
const MULTI_TOOLBAR_BUTTON_CLASS =
  'flex h-9 items-center gap-1.5 rounded-[12px] px-3 text-sm text-text-dark transition-colors hover:bg-[rgba(255,255,255,0.075)]';
const MULTI_TOOLBAR_SEPARATOR_CLASS =
  'mx-1 h-4 w-px shrink-0 bg-[rgba(255,255,255,0.14)]';
const MULTI_TOOLBAR_MENU_ITEM_CLASS =
  'flex h-11 w-full items-center gap-2.5 rounded-[10px] px-3 text-left text-sm text-text-dark transition-colors hover:bg-[rgba(255,255,255,0.075)]';

type ArrangeMode = 'graph' | 'horizontal' | 'vertical';

function getNodeSize(node: CanvasNode): { width: number; height: number } {
  return {
    width:
      typeof node.measured?.width === 'number'
        ? node.measured.width
        : typeof node.width === 'number'
          ? node.width
          : DEFAULT_NODE_WIDTH,
    height:
      typeof node.measured?.height === 'number'
        ? node.measured.height
        : typeof node.height === 'number'
          ? node.height
          : DEFAULT_NODE_HEIGHT,
  };
}

export const MultiSelectionToolbar = memo(() => {
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const setNodePositions = useCanvasStore((state) => state.setNodePositions);
  const duplicateNodesAsSiblings = useCanvasStore(
    (state) => state.duplicateNodesAsSiblings
  );
  const deleteNodes = useCanvasStore((state) => state.deleteNodes);
  const groupNodes = useCanvasStore((state) => state.groupNodes);
  const mergeStoryboardGroup = useCanvasStore((state) => state.mergeStoryboardGroup);

  const [arrangeMenuOpen, setArrangeMenuOpen] = useState(false);
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const arrangeMenuRef = useRef<HTMLDivElement>(null);
  const groupMenuRef = useRef<HTMLDivElement>(null);
  const arrangeMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const nodeById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node] as const)),
    [nodes]
  );

  const selectedNodes = useMemo(
    () => nodes.filter((node) => Boolean(node.selected)),
    [nodes]
  );

  const selectedIds = useMemo(
    () => selectedNodes.map((node) => node.id),
    [selectedNodes]
  );

  // 合并分镜组：仅图片节点、且数量不超过上限。
  const canMergeStoryboard = useMemo(
    () =>
      selectedNodes.length <= STORYBOARD_MAX_NODES &&
      selectedNodes.every((node) => STORYBOARD_IMAGE_NODE_TYPES.has(node.type ?? '')),
    [selectedNodes]
  );

  // Preset/mainline-managed nodes are not user-deletable — the store filters
  // them out internally too, but we compute the deletable subset here so the
  // button can disable itself when the whole selection is locked. The marquee
  // drops a fully-enclosed group from `selected` (so dragging children doesn't
  // double-move them), so we also re-include any group whose every child is
  // selected — otherwise a batch delete empties the group but leaves its frame.
  const deletableIds = useMemo(
    () => collectBatchDeletableIds(nodes, selectedIds),
    [nodes, selectedIds]
  );

  // Resolve a node's absolute (canvas-space) position by walking its parent
  // chain — child nodes store their position relative to the group.
  const resolveAbsolute = useCallback(
    (node: CanvasNode | undefined): { x: number; y: number } => {
      let x = 0;
      let y = 0;
      let current = node;
      const guard = new Set<string>();
      while (current && !guard.has(current.id)) {
        guard.add(current.id);
        x += current.position.x;
        y += current.position.y;
        current = current.parentId ? nodeById.get(current.parentId) : undefined;
      }
      return { x, y };
    },
    [nodeById]
  );

  const handleArrange = useCallback(
    (mode: ArrangeMode) => {
      setArrangeMenuOpen(false);
      if (selectedNodes.length < 2) {
        return;
      }

      const items = selectedNodes
        .map((node) => ({
          node,
          abs: resolveAbsolute(node),
          size: getNodeSize(node),
        }))
        // Stable reading order (top-to-bottom, then left-to-right) so the
        // arranged result matches how the user perceives the selection.
        .sort((a, b) => a.abs.y - b.abs.y || a.abs.x - b.abs.x);

      const minX = Math.min(...items.map((item) => item.abs.x));
      const minY = Math.min(...items.map((item) => item.abs.y));

      const targets = new Map<string, { x: number; y: number }>();

      if (mode === 'horizontal') {
        let cursorX = minX;
        for (const item of items) {
          targets.set(item.node.id, { x: cursorX, y: minY });
          cursorX += item.size.width + ARRANGE_GAP;
        }
      } else if (mode === 'vertical') {
        let cursorY = minY;
        for (const item of items) {
          targets.set(item.node.id, { x: minX, y: cursorY });
          cursorY += item.size.height + ARRANGE_GAP;
        }
      } else {
        // 按连线排列：复用画布「整理」用的 Sugiyama 分层算法（computeAutoLayout），
        // 但只喂选中的这批节点 + 它们之间的连线，让父→子沿边方向左→右分层、纵向
        // 按重心对齐。喂进去的是「绝对坐标 + 清空 parentId」的克隆，这样即便选区
        // 跨越不同分组也能在同一坐标系里布局；computeAutoLayout 会把结果锚定在选区
        // 左上角（min 绝对坐标 = minX/minY），与其它模式一致、选区不会整体漂走。
        const selectedIdSet = new Set(items.map((item) => item.node.id));
        const layoutNodes = items.map((item) => ({
          ...item.node,
          position: { x: item.abs.x, y: item.abs.y },
          parentId: undefined,
        }));
        const layoutEdges = edges.filter(
          (edge) => selectedIdSet.has(edge.source) && selectedIdSet.has(edge.target)
        );
        const { positions: absPositions } = computeAutoLayout(layoutNodes, layoutEdges);
        for (const item of items) {
          const abs = absPositions[item.node.id];
          if (!abs) continue;
          targets.set(item.node.id, abs);
        }
      }

      // Convert the computed absolute targets back into each node's own
      // coordinate space (relative to its parent group, if any).
      const positions: Record<string, { x: number; y: number }> = {};
      for (const item of items) {
        const target = targets.get(item.node.id);
        if (!target) continue;
        const parentAbs = item.node.parentId
          ? resolveAbsolute(nodeById.get(item.node.parentId))
          : { x: 0, y: 0 };
        positions[item.node.id] = {
          x: target.x - parentAbs.x,
          y: target.y - parentAbs.y,
        };
      }

      setNodePositions(positions);
    },
    [edges, nodeById, resolveAbsolute, selectedNodes, setNodePositions]
  );

  const cancelArrangeMenuClose = useCallback(() => {
    if (arrangeMenuCloseTimerRef.current) {
      clearTimeout(arrangeMenuCloseTimerRef.current);
      arrangeMenuCloseTimerRef.current = null;
    }
  }, []);

  const openArrangeMenu = useCallback(() => {
    cancelArrangeMenuClose();
    setArrangeMenuOpen(true);
  }, [cancelArrangeMenuClose]);

  const scheduleArrangeMenuClose = useCallback(() => {
    cancelArrangeMenuClose();
    arrangeMenuCloseTimerRef.current = setTimeout(() => {
      setArrangeMenuOpen(false);
      arrangeMenuCloseTimerRef.current = null;
    }, 160);
  }, [cancelArrangeMenuClose]);

  useEffect(() => cancelArrangeMenuClose, [cancelArrangeMenuClose]);

  const handleDuplicate = useCallback(() => {
    if (selectedIds.length === 0) {
      return;
    }
    duplicateNodesAsSiblings(selectedIds);
  }, [duplicateNodesAsSiblings, selectedIds]);

  const handleBatchDownload = useCallback(async () => {
    if (isDownloading) {
      return;
    }
    setIsDownloading(true);
    try {
      for (const node of selectedNodes) {
        const data = node.data as {
          imageUrl?: string | null;
          previewImageUrl?: string | null;
          videoUrl?: string | null;
          sourceFileName?: string | null;
        };
        const url = data.imageUrl || data.previewImageUrl || data.videoUrl;
        if (!url) {
          continue;
        }
        const filename =
          typeof data.sourceFileName === 'string' && data.sourceFileName.trim()
            ? data.sourceFileName.trim()
            : undefined;
        try {
          await downloadUrlAsFile(url, filename);
        } catch (error) {
          console.error('[batch-download] failed for node', node.id, error);
        }
        // Space out triggers so the browser doesn't drop concurrent downloads.
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    } finally {
      setIsDownloading(false);
    }
  }, [isDownloading, selectedNodes]);

  const handleBatchDelete = useCallback(() => {
    if (deletableIds.length === 0) {
      return;
    }
    // Match the keyboard Delete handler in Canvas.tsx — immediate delete with
    // no native confirm dialog. Undo is available via standard history.
    deleteNodes(deletableIds);
  }, [deletableIds, deleteNodes]);

  const handleGroup = useCallback(() => {
    setGroupMenuOpen(false);
    if (selectedIds.length < 2) {
      return;
    }
    groupNodes(selectedIds);
  }, [groupNodes, selectedIds]);

  const handleMergeStoryboard = useCallback(() => {
    setGroupMenuOpen(false);
    if (selectedIds.length < 2) {
      return;
    }
    mergeStoryboardGroup(selectedIds);
  }, [mergeStoryboardGroup, selectedIds]);

  useEffect(() => {
    if (!arrangeMenuOpen) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (arrangeMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      setArrangeMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [arrangeMenuOpen]);

  useEffect(() => {
    if (!groupMenuOpen) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (groupMenuRef.current?.contains(event.target as Node)) {
        return;
      }
      setGroupMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [groupMenuOpen]);

  // Only surface the toolbar for a genuine multi-selection — single-node
  // selection is handled by SelectedNodeOverlay / NodeActionToolbar.
  if (selectedIds.length < 2) {
    return null;
  }

  return (
    <ReactFlowNodeToolbar
      nodeId={selectedIds}
      isVisible
      position={Position.Top}
      align="start"
      offset={32}
    >
      {/* counter 模式：抵消画布缩放，让批量菜单保持恒定的屏幕尺寸——画布缩得越小，
          菜单相对越大越清晰，不再像 follow 模式那样跟着一起缩到看不清。counterMax
          与通用节点工具栏(NodeActionToolbar)一致封在 1，避免放大画布时反而变大。 */}
      <ZoomScaledToolbar origin="bottom left" mode="counter" counterMax={1}>
      <div ref={arrangeMenuRef} className="relative" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center gap-1.5 rounded-[18px] border border-white/10 bg-[#242426]/95 px-2 py-1.5 text-sm shadow-[0_10px_24px_rgba(0,0,0,0.28)] backdrop-blur-2xl [&_svg]:h-4 [&_svg]:w-4">
          <button
            type="button"
            className={MULTI_TOOLBAR_BUTTON_CLASS}
            onMouseEnter={openArrangeMenu}
            onMouseLeave={scheduleArrangeMenuClose}
            onClick={() => setArrangeMenuOpen((open) => !open)}
          >
            <LayoutGrid className="h-4 w-4 text-text-muted" />
            <span>排列</span>
            <ChevronDown className="h-3.5 w-3.5 text-text-muted" />
          </button>

          <div className={MULTI_TOOLBAR_SEPARATOR_CLASS} />

          <button
            type="button"
            className={MULTI_TOOLBAR_BUTTON_CLASS}
            onClick={handleDuplicate}
          >
            <Copy className="h-4 w-4 text-text-muted" />
            <span>创建副本</span>
          </button>

          <button
            type="button"
            disabled={isDownloading}
            className={`${MULTI_TOOLBAR_BUTTON_CLASS} disabled:cursor-not-allowed disabled:opacity-50`}
            onClick={handleBatchDownload}
          >
            {isDownloading ? (
              <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
            ) : (
              <Download className="h-4 w-4 text-text-muted" />
            )}
            <span>批量下载</span>
          </button>

          <div className={MULTI_TOOLBAR_SEPARATOR_CLASS} />

          <div ref={groupMenuRef} className="relative">
            <button
              type="button"
              className={MULTI_TOOLBAR_BUTTON_CLASS}
              onClick={() => setGroupMenuOpen((open) => !open)}
            >
              <Group className="h-4 w-4 text-text-muted" />
              <span>打组</span>
              <ChevronDown className="h-3.5 w-3.5 text-text-muted" />
            </button>

            {groupMenuOpen && (
              <div className="absolute right-0 top-full mt-2 min-w-[160px] overflow-hidden rounded-xl border border-white/10 bg-[#242426]/95 p-1.5 text-text-dark shadow-none backdrop-blur-3xl">
                <button
                  type="button"
                  className={MULTI_TOOLBAR_MENU_ITEM_CLASS}
                  onClick={handleGroup}
                >
                  <Group className="h-4 w-4 text-text-muted" />
                  <span>打组</span>
                </button>
                <div className="group/sb relative">
                  <button
                    type="button"
                    // Not the native `disabled` so hover still fires the tooltip; the
                    // click is gated and the row is styled as disabled instead.
                    aria-disabled={!canMergeStoryboard}
                    className={`${MULTI_TOOLBAR_MENU_ITEM_CLASS} ${
                      canMergeStoryboard ? '' : 'cursor-not-allowed opacity-40'
                    }`}
                    onClick={() => {
                      if (canMergeStoryboard) {
                        handleMergeStoryboard();
                      }
                    }}
                  >
                    <Clapperboard className="h-4 w-4 text-text-muted" />
                    <span>合并分镜组</span>
                  </button>
                  {!canMergeStoryboard ? (
                    <div className="pointer-events-none absolute right-0 top-full z-10 mt-1.5 hidden w-max max-w-[240px] rounded-lg border border-white/10 bg-[#1c1c1e]/95 px-3 py-1.5 text-xs leading-relaxed text-white/80 shadow-[0_10px_24px_rgba(0,0,0,0.35)] backdrop-blur-2xl group-hover/sb:block">
                      分镜组仅支持图片节点，且组内节点数量不可超过25个
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </div>

          <div className={MULTI_TOOLBAR_SEPARATOR_CLASS} />

          <button
            type="button"
            disabled={deletableIds.length === 0}
            className={`${MULTI_TOOLBAR_BUTTON_CLASS} hover:text-rose-100 disabled:cursor-not-allowed disabled:opacity-50`}
            onClick={handleBatchDelete}
            title={
              deletableIds.length === 0
                ? '所选节点均为主线锁定节点，不可删除'
                : `删除 ${deletableIds.length} 个节点`
            }
          >
            <Trash2 className="h-4 w-4 text-text-muted" />
            <span>批量删除</span>
          </button>
        </div>

        {arrangeMenuOpen && (
          <div
            className="absolute left-0 top-full mt-2 min-w-[150px] overflow-hidden rounded-xl border border-white/10 bg-[#242426]/95 p-1.5 text-text-dark shadow-none backdrop-blur-3xl"
            onMouseEnter={openArrangeMenu}
            onMouseLeave={scheduleArrangeMenuClose}
          >
            <button
              type="button"
              className={MULTI_TOOLBAR_MENU_ITEM_CLASS}
              onClick={() => handleArrange('graph')}
            >
              <Workflow className="h-4 w-4 text-text-muted" />
              <span>宫格排列</span>
            </button>
            <button
              type="button"
              className={MULTI_TOOLBAR_MENU_ITEM_CLASS}
              onClick={() => handleArrange('horizontal')}
            >
              <StretchHorizontal className="h-4 w-4 text-text-muted" />
              <span>水平排列</span>
            </button>
            <button
              type="button"
              className={MULTI_TOOLBAR_MENU_ITEM_CLASS}
              onClick={() => handleArrange('vertical')}
            >
              <StretchVertical className="h-4 w-4 text-text-muted" />
              <span>垂直排列</span>
            </button>
          </div>
        )}
      </div>
      </ZoomScaledToolbar>
    </ReactFlowNodeToolbar>
  );
});

MultiSelectionToolbar.displayName = 'MultiSelectionToolbar';
