// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useCanvasStore } from '@/stores/canvasStore';
import type { CanvasEdge, CanvasNode } from '../domain/canvasNodes';
import { extractUpstreamContent } from './graphContentResolver';
import { extractUpstreamImages } from './graphImageResolver';
import type { UpstreamContent } from './ports';

// Every reference consumer used to rebuild the entire node index on each drag
// notification. Share indexes for immutable graph arrays, preserving edge order.
const nodeIndexes = new WeakMap<CanvasNode[], Map<string, CanvasNode>>();
const edgeIndexes = new WeakMap<CanvasEdge[], Map<string, string[]>>();
function indexedUpstream(nodes: CanvasNode[], edges: CanvasEdge[], nodeId: string): CanvasNode[] {
  let byId = nodeIndexes.get(nodes);
  if (!byId) {
    byId = new Map(nodes.map((node) => [node.id, node]));
    nodeIndexes.set(nodes, byId);
  }
  let sources = edgeIndexes.get(edges);
  if (!sources) {
    sources = new Map();
    for (const edge of edges) {
      const incoming = sources.get(edge.target);
      if (incoming) incoming.push(edge.source);
      else sources.set(edge.target, [edge.source]);
    }
    edgeIndexes.set(edges, sources);
  }
  return (sources.get(nodeId) ?? []).flatMap((id) => {
    const node = byId.get(id);
    return node ? [node] : [];
  });
}

/**
 * Subscribe to ONLY this node's direct (one-hop) upstream nodes, in edge-
 * connection order — not the whole `nodes` array.
 *
 * Why this exists (perf): React Flow rebuilds the `nodes` array on every drag
 * frame, but `applyNodeChanges` / `updateNodeData` reuse object identity for the
 * nodes that didn't change. A node component that subscribed to the full array
 * therefore re-rendered (and re-walked the graph) on *any* change anywhere on the
 * canvas. By selecting just the upstream node objects under `useShallow`, an
 * unrelated node's drag leaves this result referentially stable, so the consuming
 * node skips the re-render entirely.
 */
export function useUpstreamNodes(nodeId: string): CanvasNode[] {
  return useCanvasStore(
    useShallow((state) =>
      indexedUpstream(state.nodes, state.edges, nodeId),
    ),
  );
}

/**
 * Content-only snapshots for reference chips/payloads. Geometry is intentionally
 * stale after a position-only update: consumers needing positions must keep
 * useUpstreamNodes. data identity is the store's immutable content revision.
 */
export function useUpstreamReferenceNodes(nodeId: string): CanvasNode[] {
  const select = useMemo(() => {
    let previous: CanvasNode[] = [];
    return (state: { nodes: CanvasNode[]; edges: CanvasEdge[] }) => {
      const next = indexedUpstream(state.nodes, state.edges, nodeId);
      if (next.length === previous.length && next.every((node, i) =>
        node.id === previous[i].id && node.type === previous[i].type && node.data === previous[i].data,
      )) return previous;
      previous = next;
      return next;
    };
  }, [nodeId]);
  return useCanvasStore(select);
}

/** One-hop upstream contents (text / image / video / audio), per-node subscribed. */
export function useUpstreamContents(nodeId: string): UpstreamContent[] {
  const upstreamNodes = useUpstreamReferenceNodes(nodeId);
  return useMemo(() => upstreamNodes.map(extractUpstreamContent), [upstreamNodes]);
}

/** One-hop upstream referenceable image URLs (deduped), per-node subscribed. */
export function useUpstreamImages(nodeId: string): string[] {
  const upstreamNodes = useUpstreamReferenceNodes(nodeId);
  return useMemo(
    () => [...new Set(upstreamNodes.flatMap((node) => extractUpstreamImages(node)))],
    [upstreamNodes],
  );
}
