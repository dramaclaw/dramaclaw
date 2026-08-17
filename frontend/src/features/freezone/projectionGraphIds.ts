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

/**
 * 一个 projection_key 一个 id 命名空间。
 *
 * safeKey 只是给人看的可读部分，是**有损**的：中文角色名会被整段换成 `_` 再 strip
 * 掉，`asset:character:林小满` 和 `asset:character:顾南城` 都会塌成 `asset_character`。
 * 后端对两个角色又产出同名的原始节点 id（`character_profile` 等），前缀一撞，第二个
 * 人物进虾画时就会顶掉第一个人物的组——组名被换、两个人物的节点挤进同一个组。
 * 唯一性一律交给 key 的稳定摘要来保证。
 */
function projectionIdPrefix(projectionKey: string): string {
  const key = projectionKey.trim();
  const safeKey = key
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  const digest = projectionKeyDigest(key);
  return safeKey ? `projection_${safeKey}_${digest}__` : `projection_${digest}__`;
}

/** FNV-1a：只要求稳定 + 无碰撞倾向，不要求密码学强度。 */
function projectionKeyDigest(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
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

/** 旧命名空间：不带 key 摘要，中文角色名会互相撞车。仅用于识别存量 id。 */
function legacyProjectionIdPrefix(projectionKey: string): string {
  const safeKey =
    projectionKey
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "projection";
  return `projection_${safeKey}__`;
}

export function projectionScopedId(projectionKey: string, id: string): string {
  const prefix = projectionIdPrefix(projectionKey);
  if (id.startsWith(prefix)) {
    return id;
  }
  // 存量画布里的 id 带旧前缀：剥掉后重新加新前缀（而不是再套一层）。
  // setCanvasData 每次都会过一遍 scopeProjectionGraphIds，所以本地节点会在 hydrate
  // 时就地迁移、和后端下发的新 id 对上，布局不丢；节点各自按 data.projection_key
  // 归位，原先撞在一起的两个人物也就此分开。
  const legacy = legacyProjectionIdPrefix(projectionKey);
  const rawId = id.startsWith(legacy) ? id.slice(legacy.length) : id;
  return `${prefix}${rawId}`;
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
