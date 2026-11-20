// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CanvasStoreApi } from './canvasStore';

/**
 * Selects one node and deselects the rest. The `select` changes go through
 * `onNodesChange` as well as `setSelectedNode`, because the canvas view syncs
 * node `selected` flags back into the store and would undo a store-only write.
 */
export function selectNodeExclusively(store: CanvasStoreApi, nodeId: string): void {
  const state = store.getState();
  if (!state.nodes.some((node) => node.id === nodeId)) return;
  const changes = state.nodes
    .filter((node) => Boolean(node.selected) !== (node.id === nodeId))
    .map((node) => ({
      id: node.id,
      type: 'select' as const,
      selected: node.id === nodeId,
    }));
  if (changes.length > 0 && typeof state.onNodesChange === 'function') state.onNodesChange(changes);
  if (typeof state.setSelectedNode === 'function') state.setSelectedNode(nodeId);
}

/** Selects one node and asks the view to bring it into focus. */
export function selectAndFocusNode(store: CanvasStoreApi, nodeId: string): void {
  selectNodeExclusively(store, nodeId);
  store.getState().requestFocusNode(nodeId);
}
