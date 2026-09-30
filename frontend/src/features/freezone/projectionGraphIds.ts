// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CanvasEdge, CanvasNode } from "@/features/canvas/domain/canvasNodes";

function projectionKeyFromNode(node: CanvasNode): string | null {
  const data = (node.data ?? {}) as {
    projection_key?: unknown;
    source_projection_key?: unknown;
  };
  const projectionKey =
    typeof data.projection_key === "string" && data.projection_key.trim()
      ? data.projection_key.trim()
      : typeof data.source_projection_key === "string" && data.source_projection_key.trim()
        ? data.source_projection_key.trim()
        : null;
  return projectionKey;
}

function projectionKeyFromEdge(edge: CanvasEdge): string | null {
  const data = (edge.data ?? {}) as {
    projection_key?: unknown;
    source_projection_key?: unknown;
  };
  const projectionKey =
    typeof data.projection_key === "string" && data.projection_key.trim()
      ? data.projection_key.trim()
      : typeof data.source_projection_key === "string" && data.source_projection_key.trim()
        ? data.source_projection_key.trim()
        : null;
  return projectionKey;
}

function projectionIdPrefix(projectionKey: string): string {
  const trimmed = projectionKey.trim();
  const safeKey = projectionKey
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "projection";
  const suffix = /[^\x00-\x7F]/.test(trimmed) ? `_${stableProjectionKeyHash(trimmed)}` : "";
  return `projection_${safeKey}${suffix}__`;
}

function stableProjectionKeyHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function stampInheritedProjectionData<T extends { data?: unknown }>(
  item: T,
  projectionKey: string,
): T {
  const data = (item.data ?? {}) as {
    projection_key?: unknown;
    source_projection_key?: unknown;
    user_spawned?: unknown;
  };
  if (
    data.user_spawned === true ||
    typeof data.projection_key === "string" ||
    typeof data.source_projection_key === "string"
  ) {
    return item;
  }
  return {
    ...item,
    data: {
      ...data,
      projection_key: projectionKey,
    },
  };
}

export function projectionScopedId(projectionKey: string, id: string): string {
  const prefix = projectionIdPrefix(projectionKey);
  return id.startsWith(prefix) ? id : `${prefix}${id}`;
}

export function scopeProjectionGraphIds(
  rawNodes: CanvasNode[],
  rawEdges: CanvasEdge[],
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const explicitProjectionKeyByNode = new WeakMap<CanvasNode, string>();
  for (const node of rawNodes) {
    const projectionKey = projectionKeyFromNode(node);
    if (projectionKey) {
      explicitProjectionKeyByNode.set(node, projectionKey);
    }
  }
  const rawNodeById = new Map(rawNodes.map((node) => [node.id, node] as const));
  const projectionKeyByNode = new WeakMap<CanvasNode, string | null>();
  const resolveNodeProjectionKey = (node: CanvasNode): string | null => {
    if (projectionKeyByNode.has(node)) {
      return projectionKeyByNode.get(node) ?? null;
    }
    const explicit = explicitProjectionKeyByNode.get(node);
    if (explicit) {
      projectionKeyByNode.set(node, explicit);
      return explicit;
    }
    if (node.parentId) {
      const parent = rawNodeById.get(node.parentId);
      if (parent) {
        const parentProjectionKey = resolveNodeProjectionKey(parent);
        projectionKeyByNode.set(node, parentProjectionKey);
        return parentProjectionKey;
      }
    }
    projectionKeyByNode.set(node, null);
    return null;
  };
  const projectedRawNodeIds = new Set(
    rawNodes
      .filter((node) => resolveNodeProjectionKey(node))
      .map((node) => node.id),
  );
  const idMapByProjection = new Map<string, Map<string, string>>();
  const unambiguousIdMap = new Map<string, string | null>();
  const unambiguousProjectionKeyByRawNodeId = new Map<string, string | null>();
  const nextNodes: CanvasNode[] = [];
  const projectionKeyByScopedNodeId = new Map<string, string>();
  for (const node of rawNodes) {
    const projectionKey = resolveNodeProjectionKey(node);
    const data = (node.data ?? {}) as { user_spawned?: unknown };
    if (!projectionKey) {
      if (data.user_spawned !== true && projectedRawNodeIds.has(node.id)) {
        continue;
      }
      nextNodes.push(node);
      continue;
    }
    const scopedId = projectionScopedId(projectionKey, node.id);
    let projectionMap = idMapByProjection.get(projectionKey);
    if (!projectionMap) {
      projectionMap = new Map<string, string>();
      idMapByProjection.set(projectionKey, projectionMap);
    }
    projectionMap.set(node.id, scopedId);

    const existingGlobal = unambiguousIdMap.get(node.id);
    if (existingGlobal === undefined) {
      unambiguousIdMap.set(node.id, scopedId);
    } else if (existingGlobal !== scopedId) {
      unambiguousIdMap.set(node.id, null);
    }
    const existingProjectionKey = unambiguousProjectionKeyByRawNodeId.get(node.id);
    if (existingProjectionKey === undefined) {
      unambiguousProjectionKeyByRawNodeId.set(node.id, projectionKey);
    } else if (existingProjectionKey !== projectionKey) {
      unambiguousProjectionKeyByRawNodeId.set(node.id, null);
    }

    nextNodes.push(stampInheritedProjectionData({
      ...node,
      id: scopedId,
    }, projectionKey));
    projectionKeyByScopedNodeId.set(scopedId, projectionKey);
  }

  const remapEndpoint = (id: string, projectionKey: string | null): string => {
    if (projectionKey) {
      return idMapByProjection.get(projectionKey)?.get(id) ?? id;
    }
    return unambiguousIdMap.get(id) ?? id;
  };
  const inferEdgeProjectionKey = (edge: CanvasEdge): string | null => {
    const explicit = projectionKeyFromEdge(edge);
    if (explicit) {
      return explicit;
    }
    const sourceProjectionKey = unambiguousProjectionKeyByRawNodeId.get(edge.source);
    const targetProjectionKey = unambiguousProjectionKeyByRawNodeId.get(edge.target);
    if (sourceProjectionKey && sourceProjectionKey === targetProjectionKey) {
      return sourceProjectionKey;
    }
    return null;
  };

  const nextNodesWithParents = nextNodes.map((node) => {
    if (!node.parentId) {
      return node;
    }
    const projectionKey = projectionKeyFromNode(node) ?? projectionKeyByScopedNodeId.get(node.id) ?? null;
    return {
      ...node,
      parentId: remapEndpoint(node.parentId, projectionKey),
    };
  });

  const nextEdges = rawEdges.map((edge) => {
    const projectionKey = inferEdgeProjectionKey(edge);
    const scopedEdgeId = projectionKey ? projectionScopedId(projectionKey, edge.id) : edge.id;
    const nextEdge = {
      ...edge,
      id: scopedEdgeId,
      source: remapEndpoint(edge.source, projectionKey),
      target: remapEndpoint(edge.target, projectionKey),
    };
    return projectionKey ? stampInheritedProjectionData(nextEdge, projectionKey) : nextEdge;
  });

  return { nodes: nextNodesWithParents, edges: nextEdges };
}
