// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { FreezonePresetCanvasRequest } from "@/api/canvas";
import type { CanvasEdge, CanvasNode } from "@/stores/canvasStore";
import {
  projectionScopedId,
  scopeProjectionGraphIds,
} from "@/features/freezone/projectionGraphIds";

export function personalCanvasIdForUsername(username: string): string {
  const trimmed = username.trim();
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36) || "u";
  const hash = stableCanvasIdHash(trimmed || "user");
  return `user_${slug}_${hash}`.slice(0, 64).replace(/_+$/g, "");
}

export function canvasIdForFreezoneEntry({
  explicitCanvasId,
  username,
}: {
  explicitCanvasId: string | null | undefined;
  username: string | null | undefined;
}): string {
  const explicit = explicitCanvasId?.trim();
  if (explicit) return explicit;
  return personalCanvasIdForUsername(username?.trim() || "user");
}

export function projectionKeyForPresetRequest(
  request: Pick<
    FreezonePresetCanvasRequest,
    "scope" | "episode" | "beat" | "asset_kind" | "asset_id" | "character" | "identity_id"
  >,
): string {
  if (request.scope === "beat") return `beat:${request.episode ?? 0}:${request.beat ?? 0}`;
  if (request.scope === "episode") return `episode:${request.episode ?? 0}`;
  const kind = sanitizeProjectionPart(request.asset_kind ?? "asset");
  const assetId = sanitizeProjectionPart(
    request.asset_id ?? request.identity_id ?? request.character ?? "unknown",
  );
  return `asset:${kind}:${assetId}`;
}

export function normalizePresetProjectionRequest<T extends FreezonePresetCanvasRequest>(
  request: T,
): T {
  if (request.scope !== "beat") return request;
  return {
    ...request,
    primary_slot: "render",
  };
}

export function projectionLabelForPresetRequest(
  request: Pick<
    FreezonePresetCanvasRequest,
    "scope" | "episode" | "beat" | "asset_kind" | "asset_id" | "character" | "identity_id"
  >,
): string {
  if (request.scope === "beat") return `EP${request.episode ?? 0}/B${request.beat ?? 0}`;
  if (request.scope === "episode") return `EP${request.episode ?? 0}`;
  const kind = request.asset_kind ?? "asset";
  const assetId = request.asset_id ?? request.identity_id ?? request.character ?? "unknown";
  return `${kind} · ${assetId}`;
}

export function shouldProjectPresetIntoPersonalCanvas({
  personalCanvasId,
  request,
}: {
  currentCanvasId: string;
  personalCanvasId: string;
  request: Pick<
    FreezonePresetCanvasRequest,
    "scope" | "episode" | "beat" | "asset_kind" | "asset_id" | "character" | "identity_id"
  >;
}): { targetCanvasId: string; projectionKey: string } {
  return {
    targetCanvasId: personalCanvasId,
    projectionKey: projectionKeyForPresetRequest(request),
  };
}

export function projectionTargetForCanvasPanel({
  currentCanvasId,
  request,
}: {
  currentCanvasId: string;
  request: Pick<
    FreezonePresetCanvasRequest,
    "scope" | "episode" | "beat" | "asset_kind" | "asset_id" | "character" | "identity_id"
  >;
}): { targetCanvasId: string; projectionKey: string } {
  return {
    targetCanvasId: currentCanvasId,
    projectionKey: projectionKeyForPresetRequest(request),
  };
}

export function hasLegacyPresetCanvasMetadata(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  const projections = metadata?.projections;
  if (projections && typeof projections === "object") {
    return false;
  }
  const preset = metadata?.preset as { scope?: unknown } | undefined;
  return typeof preset?.scope === "string";
}

export function mergeProjectedCanvasWithLocalCanvas(
  remoteNodes: CanvasNode[],
  remoteEdges: CanvasEdge[],
  localNodes: CanvasNode[],
  localEdges: CanvasEdge[],
  projectionKey: string,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const remoteProjectionRawNodeIds = new Set(remoteNodes.filter((node) =>
    isProjectionManagedNode(node, projectionKey) ||
    isArchivedProjectionNode(node, projectionKey),
  ).map((node) => node.id));
  const remoteProjectionRawEdgeIds = new Set(remoteEdges.filter((edge) =>
    isProjectionManagedEdge(edge, projectionKey),
  ).map((edge) => edge.id));
  const remapLocalProjectionEndpoint = (id: string): string =>
    remoteProjectionRawNodeIds.has(id) ? projectionScopedId(projectionKey, id) : id;
  const scopedRemote = scopeProjectionGraphIds(remoteNodes, remoteEdges);
  const remoteProjectionNodes = uniqueById(scopedRemote.nodes.filter((node) =>
    isProjectionManagedNode(node, projectionKey) ||
    isArchivedProjectionNode(node, projectionKey),
  ));
  const remoteProjectionEdges = uniqueById(scopedRemote.edges.filter((edge) =>
    isProjectionManagedEdge(edge, projectionKey),
  ));
  const remoteProjectionNodeById = new Map(remoteProjectionNodes.map((node) => [node.id, node]));
  const remoteProjectionEdgeById = new Map(remoteProjectionEdges.map((edge) => [edge.id, edge]));
  const remoteProjectionNodeIds = new Set(remoteProjectionNodes.map((node) => node.id));
  const remoteProjectionEdgeIds = new Set(remoteProjectionEdges.map((edge) => edge.id));
  const emittedNodeIds = new Set<string>();
  const finalNodes: CanvasNode[] = [];
  for (const node of localNodes) {
    const replacement = remoteProjectionNodeById.get(node.id);
    if (replacement) {
      finalNodes.push(preserveLocalProjectionNodeLayout(replacement, node));
      emittedNodeIds.add(replacement.id);
      continue;
    }
    if (!isProjectionManagedNode(node, projectionKey)) {
      if (isLegacyUnscopedProjectionNode(node, remoteProjectionRawNodeIds)) {
        continue;
      }
      finalNodes.push(node);
      emittedNodeIds.add(node.id);
    }
  }
  for (const node of remoteProjectionNodes) {
    if (!emittedNodeIds.has(node.id)) {
      finalNodes.push(node);
      emittedNodeIds.add(node.id);
    }
  }
  const finalNodeIds = new Set(finalNodes.map((node) => node.id));
  const emittedEdgeIds = new Set<string>();
  const finalEdges: CanvasEdge[] = [];
  for (const edge of localEdges) {
    const localEdge = {
      ...edge,
      source: remapLocalProjectionEndpoint(edge.source),
      target: remapLocalProjectionEndpoint(edge.target),
    };
    const replacement = remoteProjectionEdgeById.get(localEdge.id);
    if (
      replacement &&
      finalNodeIds.has(replacement.source) &&
      finalNodeIds.has(replacement.target)
    ) {
      finalEdges.push(replacement);
      emittedEdgeIds.add(replacement.id);
      continue;
    }
    if (isProjectionManagedEdge(localEdge, projectionKey)) {
      continue;
    }
    if (isLegacyUnscopedProjectionEdge(localEdge, remoteProjectionRawEdgeIds)) {
      continue;
    }
    if (
      !remoteProjectionEdgeIds.has(localEdge.id) &&
      finalNodeIds.has(localEdge.source) &&
      finalNodeIds.has(localEdge.target)
    ) {
      finalEdges.push(localEdge);
      emittedEdgeIds.add(localEdge.id);
    }
  }
  for (const edge of remoteProjectionEdges) {
    if (emittedEdgeIds.has(edge.id)) continue;
    if (
      finalNodeIds.has(edge.source) &&
      finalNodeIds.has(edge.target) &&
      (remoteProjectionNodeIds.has(edge.source) || remoteProjectionNodeIds.has(edge.target))
    ) {
      finalEdges.push(edge);
      emittedEdgeIds.add(edge.id);
    }
  }
  return { nodes: sortParentNodesBeforeChildren(finalNodes), edges: finalEdges };
}

function preserveLocalProjectionNodeLayout(replacement: CanvasNode, local: CanvasNode): CanvasNode {
  // 本地成员已经脱离组（组被顶掉 / 命名空间迁移后 detachMissingParents 摘了 parent）：
  // 认后端刚重建的组，位置也一并跟过去——child 的 position 是相对父框的，散落时那份
  // 已经是画布绝对坐标了，留着会被 extent:"parent" 夹到组边缘。
  const readoptRemoteParent = !local.parentId && Boolean(replacement.parentId);
  return {
    ...replacement,
    position: readoptRemoteParent ? replacement.position : local.position,
    parentId: readoptRemoteParent ? replacement.parentId : local.parentId,
    extent: readoptRemoteParent ? replacement.extent : local.extent,
    expandParent: local.expandParent,
    origin: local.origin,
    width: local.width ?? replacement.width,
    height: local.height ?? replacement.height,
    measured: local.measured ?? replacement.measured,
    style: local.style ?? replacement.style,
  };
}

export function mergeProjectionMetadata(
  localMetadata: Record<string, unknown> | null | undefined,
  incomingMetadata: Record<string, unknown> | null | undefined,
  projectionKey: string,
): Record<string, unknown> | null {
  if (!incomingMetadata || typeof incomingMetadata !== "object") {
    return localMetadata ? { ...localMetadata } : null;
  }
  const incomingProjections = incomingMetadata.projections;
  const incomingProjection =
    incomingProjections && typeof incomingProjections === "object"
      ? (incomingProjections as Record<string, unknown>)[projectionKey]
      : null;
  if (!incomingProjection || typeof incomingProjection !== "object") {
    return localMetadata ? { ...localMetadata } : { ...incomingMetadata };
  }
  const local = localMetadata && typeof localMetadata === "object" ? localMetadata : {};
  const localProjections =
    local.projections && typeof local.projections === "object"
      ? (local.projections as Record<string, unknown>)
      : {};
  return {
    ...local,
    projections: {
      ...localProjections,
      [projectionKey]: incomingProjection,
    },
    last_projection_key:
      typeof incomingMetadata.last_projection_key === "string"
        ? incomingMetadata.last_projection_key
        : projectionKey,
  };
}

export function projectionMetadataWithRequest(
  incomingMetadata: Record<string, unknown> | null | undefined,
  projectionKey: string,
  request: Omit<FreezonePresetCanvasRequest, "canvas_id" | "overwrite_existing" | "base_revision">,
  factsSignature?: string | null,
): Record<string, unknown> {
  const metadata =
    incomingMetadata && typeof incomingMetadata === "object"
      ? { ...incomingMetadata }
      : {};
  const projections =
    metadata.projections && typeof metadata.projections === "object"
      ? { ...(metadata.projections as Record<string, unknown>) }
      : {};
  const existingProjection =
    projections[projectionKey] && typeof projections[projectionKey] === "object"
      ? { ...(projections[projectionKey] as Record<string, unknown>) }
      : {};
  const normalizedFactsSignature = String(factsSignature ?? "").trim();
  projections[projectionKey] = {
    ...existingProjection,
    projection_key: projectionKey,
    ...(normalizedFactsSignature ? { facts_signature: normalizedFactsSignature } : {}),
    request: normalizePresetProjectionRequest(request),
  };
  return {
    ...metadata,
    projections,
    last_projection_key:
      typeof metadata.last_projection_key === "string"
        ? metadata.last_projection_key
        : projectionKey,
  };
}

export function removeProjectionFromLocalCanvas(
  localNodes: CanvasNode[],
  localEdges: CanvasEdge[],
  projectionKey: string,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const removedNodeIds = new Set(
    localNodes
      .filter((node) =>
        isProjectionManagedNode(node, projectionKey) ||
        isArchivedProjectionNode(node, projectionKey),
      )
      .map((node) => node.id),
  );
  const nodes = localNodes
    .filter((node) => !removedNodeIds.has(node.id))
    .map((node) => {
      if (!node.parentId || !removedNodeIds.has(node.parentId)) {
        return node;
      }
      return {
        ...node,
        parentId: undefined,
        extent: undefined,
      };
    });
  const edges = localEdges.filter((edge) => {
    if (removedNodeIds.has(edge.source) || removedNodeIds.has(edge.target)) {
      return false;
    }
    return !isProjectionManagedEdge(edge, projectionKey);
  });
  return { nodes: sortParentNodesBeforeChildren(nodes), edges };
}

export function removeProjectionMetadata(
  localMetadata: Record<string, unknown> | null | undefined,
  projectionKey: string,
): Record<string, unknown> | null {
  if (!localMetadata || typeof localMetadata !== "object") {
    return null;
  }
  const projections =
    localMetadata.projections && typeof localMetadata.projections === "object"
      ? { ...(localMetadata.projections as Record<string, unknown>) }
      : {};
  delete projections[projectionKey];
  const next: Record<string, unknown> = {
    ...localMetadata,
    projections,
  };
  if (next.last_projection_key === projectionKey) {
    delete next.last_projection_key;
  }
  return next;
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const order: string[] = [];
  const byId = new Map<string, T>();
  for (const item of items) {
    if (!byId.has(item.id)) {
      order.push(item.id);
    }
    byId.set(item.id, item);
  }
  return order.map((id) => byId.get(id)!);
}

function sanitizeProjectionPart(value: string): string {
  return value.trim().replace(/[:\s]+/g, "_").slice(0, 80) || "unknown";
}

function stableCanvasIdHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function sortParentNodesBeforeChildren(nodes: CanvasNode[]): CanvasNode[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const originalIndex = new Map(nodes.map((node, index) => [node.id, index]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: CanvasNode[] = [];

  const visit = (node: CanvasNode) => {
    if (visited.has(node.id)) return;
    if (visiting.has(node.id)) {
      sorted.push(node);
      visited.add(node.id);
      return;
    }
    visiting.add(node.id);
    if (node.parentId) {
      const parent = nodeById.get(node.parentId);
      if (parent) {
        visit(parent);
      }
    }
    visiting.delete(node.id);
    if (!visited.has(node.id)) {
      sorted.push(node);
      visited.add(node.id);
    }
  };

  for (const node of [...nodes].sort((a, b) => (originalIndex.get(a.id) ?? 0) - (originalIndex.get(b.id) ?? 0))) {
    visit(node);
  }
  return sorted;
}

function isProjectionManagedNode(node: CanvasNode, projectionKey: string): boolean {
  const data = (node.data ?? {}) as {
    projection_key?: unknown;
    user_spawned?: unknown;
  };
  return data.user_spawned !== true && data.projection_key === projectionKey;
}

function isLegacyUnscopedProjectionNode(node: CanvasNode, remoteProjectionRawNodeIds: Set<string>): boolean {
  const data = (node.data ?? {}) as {
    projection_key?: unknown;
    user_spawned?: unknown;
  };
  return (
    data.user_spawned !== true &&
    typeof data.projection_key !== "string" &&
    remoteProjectionRawNodeIds.has(node.id)
  );
}

function isArchivedProjectionNode(node: CanvasNode, projectionKey: string): boolean {
  const data = (node.data ?? {}) as {
    projection_archived?: unknown;
    source_projection_key?: unknown;
  };
  return (
    data.projection_archived === true &&
    data.source_projection_key === projectionKey
  );
}

function isProjectionManagedEdge(edge: CanvasEdge, projectionKey: string): boolean {
  const data = (edge.data ?? {}) as {
    projection_key?: unknown;
    user_spawned?: unknown;
  };
  return data.user_spawned !== true && data.projection_key === projectionKey;
}

function isLegacyUnscopedProjectionEdge(edge: CanvasEdge, remoteProjectionRawEdgeIds: Set<string>): boolean {
  const data = (edge.data ?? {}) as {
    projection_key?: unknown;
    user_spawned?: unknown;
  };
  return (
    data.user_spawned !== true &&
    typeof data.projection_key !== "string" &&
    remoteProjectionRawEdgeIds.has(edge.id)
  );
}
