// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { NodeToolbar as ReactFlowNodeToolbar, Position } from '@xyflow/react';
import { Plus } from 'lucide-react';

import { useCanvasStore } from '@/stores/canvasStore';
import type { CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import {
  getDownstreamSpawnTypes,
  nodeHasSourceHandle,
} from '@/features/canvas/domain/nodeRegistry';

const DRAG_THRESHOLD_PX = 5;

export interface BatchConnectParams {
  clientPosition: { x: number; y: number };
}

interface MultiSelectionConnectButtonProps {
  onBatchOpenMenu: (params: BatchConnectParams) => void;
  onBatchDragStart: (params: BatchConnectParams) => void;
  onBatchDragMove: (params: BatchConnectParams) => void;
  onBatchDragEnd: (params: BatchConnectParams) => void;
}

/**
 * Batch-connect affordance for a multi-selection: a single "+" anchored to the
 * right edge of the selection box. It is the multi-node generalization of
 * {@link NodeSpawnPlusOverlay}'s right-side "+":
 * - **click** → opens the node menu to spawn one downstream node that every
 *   selected source node fans into.
 * - **drag** → draws a connection line; drop it on an existing node to fan all
 *   selected nodes into it, or drop on empty canvas to open the spawn menu there.
 *
 * Only shown when ≥2 selected nodes have a source handle AND share at least one
 * valid downstream node type (so the spawned/target node can accept all of them).
 */
export const MultiSelectionConnectButton = memo(
  ({
    onBatchOpenMenu,
    onBatchDragStart,
    onBatchDragMove,
    onBatchDragEnd,
  }: MultiSelectionConnectButtonProps) => {
    const { t } = useTranslation();
    const nodes = useCanvasStore((state) => state.nodes);

    // Anchor to the full selection box (all selected nodes) so the "+" sits on
    // its right edge, matching the dashed frame / top toolbar.
    const selectedIds = useMemo(
      () => nodes.filter((node) => Boolean(node.selected)).map((node) => node.id),
      [nodes],
    );

    // Only the source-capable selected nodes can actually be fanned out.
    const selectedSourceIds = useMemo(
      () =>
        nodes
          .filter((node) => Boolean(node.selected) && nodeHasSourceHandle(node.type))
          .map((node) => node.id),
      [nodes],
    );

    // Downstream types valid for EVERY selected source — intersection so the
    // spawned/target node is a legal downstream of all of them.
    const allowedTypes = useMemo<CanvasNodeType[]>(() => {
      if (selectedSourceIds.length < 2) {
        return [];
      }
      const idSet = new Set(selectedSourceIds);
      let acc: CanvasNodeType[] | null = null;
      for (const node of nodes) {
        if (!idSet.has(node.id)) {
          continue;
        }
        const downstream = getDownstreamSpawnTypes(node.type);
        acc = acc === null ? downstream : acc.filter((type) => downstream.includes(type));
        if (acc.length === 0) {
          break;
        }
      }
      return acc ?? [];
    }, [nodes, selectedSourceIds]);

    const dragStartRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
    const draggedRef = useRef(false);
    const suppressClickRef = useRef(false);

    const handlePointerDown = useCallback(
      (event: React.PointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        dragStartRef.current = {
          x: event.clientX,
          y: event.clientY,
          pointerId: event.pointerId,
        };
        draggedRef.current = false;

        const handleMove = (moveEvent: PointerEvent) => {
          const start = dragStartRef.current;
          if (!start || start.pointerId !== moveEvent.pointerId) {
            return;
          }
          const clientPosition = { x: moveEvent.clientX, y: moveEvent.clientY };
          if (!draggedRef.current) {
            const delta = Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y);
            if (delta < DRAG_THRESHOLD_PX) {
              return;
            }
            draggedRef.current = true;
            suppressClickRef.current = true;
            onBatchDragStart({ clientPosition: { x: start.x, y: start.y } });
          }
          onBatchDragMove({ clientPosition });
        };

        const handleUp = (upEvent: PointerEvent) => {
          const wasDragging = draggedRef.current;
          if (dragStartRef.current?.pointerId === upEvent.pointerId) {
            dragStartRef.current = null;
          }
          window.removeEventListener('pointermove', handleMove, true);
          window.removeEventListener('pointerup', handleUp, true);
          window.removeEventListener('pointercancel', handleUp, true);
          if (wasDragging) {
            onBatchDragEnd({
              clientPosition: { x: upEvent.clientX, y: upEvent.clientY },
            });
          }
        };

        window.addEventListener('pointermove', handleMove, true);
        window.addEventListener('pointerup', handleUp, true);
        window.addEventListener('pointercancel', handleUp, true);
      },
      [onBatchDragEnd, onBatchDragMove, onBatchDragStart],
    );

    if (selectedSourceIds.length < 2 || allowedTypes.length === 0) {
      return null;
    }

    return (
      <ReactFlowNodeToolbar
        nodeId={selectedIds}
        isVisible
        position={Position.Right}
        align="center"
        offset={20}
        className="pointer-events-auto"
      >
        <button
          type="button"
          aria-label={t('canvas.multiConnect.label')}
          title={t('canvas.multiConnect.hint')}
          className="nodrag flex h-8 w-8 items-center justify-center rounded-full border border-white/40 bg-surface-dark/95 text-white/85 shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_6px_18px_rgba(0,0,0,0.32)] transition-[border-color,color,box-shadow] duration-150 hover:border-white/85 hover:text-white hover:shadow-[0_0_0_1px_rgba(255,255,255,0.42),0_0_18px_rgba(255,255,255,0.22)]"
          onPointerDown={handlePointerDown}
          onClick={(event) => {
            event.stopPropagation();
            if (suppressClickRef.current) {
              suppressClickRef.current = false;
              return;
            }
            onBatchOpenMenu({
              clientPosition: { x: event.clientX, y: event.clientY },
            });
          }}
        >
          <Plus className="h-4 w-4" />
        </button>
      </ReactFlowNodeToolbar>
    );
  },
);

MultiSelectionConnectButton.displayName = 'MultiSelectionConnectButton';
