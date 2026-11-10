// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * The per-element reconcile idea follows Excalidraw (MIT license,
 * https://github.com/excalidraw/excalidraw, reconcileElements), adapted to a
 * base-copy three-way merge. No Excalidraw code is copied.
 */
import type { CanvasEdge, CanvasNode } from '@/features/canvas/domain/canvasNodes';

export interface Canvas {
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
}

export type CanvasEditing = ReadonlyArray<{ nodeId: string; field: string }>;
export type CanvasNodeField = 'group' | 'type' | 'width' | 'height' | 'style' | `data.${string}`;
export type CanvasEdgeField = 'source' | 'target' | 'sourceHandle' | 'targetHandle' | 'type' | 'data';

export type CanvasMergeNotice =
  | { kind: 'localDeletedRemoteChanged'; nodeId: string }
  | { kind: 'remoteDeletedLocalKept'; nodeId: string };

export interface CanvasMergeResult {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  notices: CanvasMergeNotice[];
  changed: boolean;
}

export interface LocalElementChanges {
  readonly created: ReadonlySet<string>;
  readonly deleted: ReadonlySet<string>;
}

export interface LocalCanvasChanges {
  readonly nodes: LocalElementChanges;
  readonly edges: LocalElementChanges;
}

export interface PreparedElementChange<T, Field extends string> {
  readonly baseById: ReadonlyMap<string, T>;
  readonly remoteById: ReadonlyMap<string, T>;
  readonly added: ReadonlySet<string>;
  readonly deleted: ReadonlySet<string>;
  readonly changed: ReadonlyMap<string, ReadonlySet<Field>>;
}

export interface PreparedRemoteCanvasChange {
  readonly base: Canvas;
  readonly remote: Canvas;
  readonly nodes: PreparedElementChange<CanvasNode, CanvasNodeField>;
  readonly edges: PreparedElementChange<CanvasEdge, CanvasEdgeField>;
}

export interface CanvasPatch {
  readonly nodes: readonly CanvasNode[];
  readonly edges: readonly CanvasEdge[];
  readonly deleted_node_ids: readonly string[];
  readonly deleted_edge_ids: readonly string[];
}

export function localCanvasChanges(base: Canvas, local: Canvas): LocalCanvasChanges {
  return { nodes: membershipChanges(base.nodes, local.nodes), edges: membershipChanges(base.edges, local.edges) };
}

export function prepareRemoteCanvasChange(base: Canvas, remote: Canvas): PreparedRemoteCanvasChange {
  return {
    base, remote,
    nodes: prepareElements(base.nodes, remote.nodes, changedNodeFields),
    edges: prepareElements(base.edges, remote.edges, changedEdgeFields),
  };
}

export function mergeCanvas(
  local: Canvas,
  prepared: PreparedRemoteCanvasChange,
  editing: CanvasEditing = [],
): CanvasMergeResult {
  return reconcile(local, prepared, editing, false);
}

export function applyCanvasPatch(base: Canvas, patch: CanvasPatch): Canvas {
  const nodes = patchElements(base.nodes, patch.nodes, patch.deleted_node_ids);
  const nodeIds = new Set(nodes.map(node => node.id));
  const edges = patchElements(base.edges, patch.edges, patch.deleted_edge_ids)
    .filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  return { nodes, edges };
}

export function replayRemoteChangeOnSnapshot(
  snapshot: Canvas,
  prepared: PreparedRemoteCanvasChange,
): Canvas | null {
  for (const node of snapshot.nodes) {
    const base = prepared.nodes.baseById.get(node.id);
    if (base && prepared.nodes.deleted.has(node.id) && changedNodeFields(base, node).size > 0) {
      return null;
    }
  }
  const { nodes, edges } = reconcile(snapshot, prepared, [], true);
  return { nodes, edges };
}

function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) {
      if (!equal(a[index], b[index])) return false;
    }
    return true;
  }
  const aKeys = Object.keys(a).filter(key => Reflect.get(a, key) !== undefined);
  const bKeys = Object.keys(b).filter(key => Reflect.get(b, key) !== undefined);
  return aKeys.length === bKeys.length && aKeys.every(key =>
    Object.prototype.hasOwnProperty.call(b, key) && equal(Reflect.get(a, key), Reflect.get(b, key)));
}

export function mergeCanvasMetadata(
  base: Record<string, unknown> | null,
  local: Record<string, unknown> | null,
  remote: Record<string, unknown> | null,
): { metadata: Record<string, unknown> | null; takenFromRemote: string[]; localKeptKeys: string[] } {
  const keys = new Set([...Object.keys(base ?? {}), ...Object.keys(local ?? {}), ...Object.keys(remote ?? {})]);
  const metadata: Record<string, unknown> = {};
  const takenFromRemote: string[] = [];
  const localKeptKeys: string[] = [];
  for (const key of keys) {
    const read = (value: Record<string, unknown> | null) =>
      value && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
    const original = read(base);
    const ours = read(local);
    const theirs = read(remote);
    const takeRemote = !equal(original, theirs) && equal(original, ours);
    const value = takeRemote ? theirs : ours;
    if (takeRemote) takenFromRemote.push(key);
    if (!equal(value, theirs)) localKeptKeys.push(key);
    if (value !== undefined) {
      Object.defineProperty(metadata, key, { value, enumerable: true, writable: true, configurable: true });
    }
  }
  return {
    metadata: local === null && remote === null && Object.keys(metadata).length === 0 ? null : metadata,
    takenFromRemote, localKeptKeys,
  };
}

function membershipChanges<T extends { id: string }>(
  base: readonly T[], local: readonly T[],
): LocalElementChanges {
  const baseIds = new Set(base.map(item => item.id));
  const localIds = new Set(local.map(item => item.id));
  return {
    created: new Set([...localIds].filter(id => !baseIds.has(id))),
    deleted: new Set([...baseIds].filter(id => !localIds.has(id))),
  };
}

const nodeScalarFields = ['type', 'width', 'height', 'style'] as const;
const edgeFields: readonly CanvasEdgeField[] = ['source', 'target', 'sourceHandle', 'targetHandle', 'type', 'data'];

function groupEqual(a: CanvasNode | undefined, b: CanvasNode): boolean {
  return a === b || (equal(a?.parentId, b.parentId)
    && equal(a?.position, b.position) && equal(a?.extent, b.extent));
}

function dataValue(node: CanvasNode | undefined, key: string): unknown {
  return node && Object.prototype.hasOwnProperty.call(node.data, key) ? node.data[key] : undefined;
}

function nodeFieldEqual(a: CanvasNode | undefined, b: CanvasNode, field: CanvasNodeField): boolean {
  switch (field) {
    case 'group': return groupEqual(a, b);
    case 'type':
    case 'width':
    case 'height':
    case 'style': return equal(a?.[field], b[field]);
    default: return equal(dataValue(a, field.slice(5)), dataValue(b, field.slice(5)));
  }
}

function changedNodeFields(base: CanvasNode | undefined, node: CanvasNode): Set<CanvasNodeField> {
  const fields = new Set<CanvasNodeField>();
  if (base === node) return fields;
  if (!groupEqual(base, node)) fields.add('group');
  for (const field of nodeScalarFields) {
    if (!equal(base?.[field], node[field])) fields.add(field);
  }
  if (base?.data !== node.data) {
    const keys = new Set([...Object.keys(base?.data ?? {}), ...Object.keys(node.data)]);
    for (const key of keys) {
      if (!equal(dataValue(base, key), dataValue(node, key))) fields.add(`data.${key}`);
    }
  }
  return fields;
}

function changedEdgeFields(base: CanvasEdge | undefined, edge: CanvasEdge): Set<CanvasEdgeField> {
  return new Set(base === edge ? [] : edgeFields.filter(field => !equal(base?.[field], edge[field])));
}

function prepareElements<T extends { id: string }, Field extends string>(
  base: readonly T[], remote: readonly T[], differences: (base: T | undefined, remote: T) => Set<Field>,
): PreparedElementChange<T, Field> {
  const baseById = new Map(base.map(item => [item.id, item]));
  const remoteById = new Map(remote.map(item => [item.id, item]));
  const membership = membershipChanges(base, remote);
  const changed = new Map<string, ReadonlySet<Field>>();
  for (const item of remote) {
    const original = baseById.get(item.id);
    if (original) {
      const fields = differences(original, item);
      if (fields.size) changed.set(item.id, fields);
    }
  }
  return { baseById, remoteById, added: membership.created, deleted: membership.deleted, changed };
}

function copyProperty<T, Key extends keyof T>(target: T, source: T, key: Key): void {
  if (source[key] === undefined) delete target[key];
  else target[key] = source[key];
}

function mergeNode(
  local: CanvasNode,
  base: CanvasNode | undefined,
  remote: CanvasNode,
  remoteFields: ReadonlySet<CanvasNodeField>,
  edited: ReadonlySet<string>,
): CanvasNode {
  let result = local;
  for (const field of remoteFields) {
    if (edited.has(field) && !nodeFieldEqual(base, local, field)) continue;
    if (nodeFieldEqual(local, remote, field)) continue;
    if (result === local) result = { ...local };
    switch (field) {
      case 'group':
        copyProperty(result, remote, 'parentId');
        copyProperty(result, remote, 'position');
        copyProperty(result, remote, 'extent');
        break;
      case 'type':
      case 'width':
      case 'height':
      case 'style':
        copyProperty(result, remote, field);
        break;
      default: {
        const key = field.slice(5);
        if (result.data === local.data) result.data = { ...local.data };
        const value = dataValue(remote, key);
        if (value === undefined) delete result.data[key];
        else Object.defineProperty(result.data, key, { value, enumerable: true, writable: true, configurable: true });
      }
    }
  }
  return result;
}

function mergeEdge(local: CanvasEdge, remote: CanvasEdge, fields: ReadonlySet<CanvasEdgeField>): CanvasEdge {
  let result = local;
  for (const field of fields) {
    if (equal(local[field], remote[field])) continue;
    if (result === local) result = { ...local };
    copyProperty(result, remote, field);
  }
  return result;
}

function reconcile(
  local: Canvas, prepared: PreparedRemoteCanvasChange, editing: CanvasEditing, snapshot: boolean,
): CanvasMergeResult {
  const localChanges = localCanvasChanges(prepared.base, local);
  const localById = new Map(local.nodes.map(node => [node.id, node]));
  const editedById = new Map<string, Set<string>>();
  for (const { nodeId, field } of editing) {
    const fields = editedById.get(nodeId) ?? new Set<string>();
    fields.add(field);
    editedById.set(nodeId, fields);
  }
  const nodes: CanvasNode[] = [];
  const notices: CanvasMergeNotice[] = [];
  for (const node of local.nodes) {
    const base = prepared.nodes.baseById.get(node.id);
    const remote = prepared.nodes.remoteById.get(node.id);
    const edited = new Set(editedById.get(node.id));
    if (!snapshot) {
      if (node.dragging === true) edited.add('group');
      if (node.resizing === true) ['group', 'width', 'height', 'style'].forEach(field => edited.add(field));
    }
    if (!remote) {
      if (!base) nodes.push(node);
      else if (changedNodeFields(base, node).size || edited.size) {
        nodes.push(node);
        if (!snapshot) notices.push({ kind: 'remoteDeletedLocalKept', nodeId: node.id });
      }
      continue;
    }
    const fields = base ? prepared.nodes.changed.get(node.id) ?? new Set<CanvasNodeField>()
      : changedNodeFields(remote, node);
    nodes.push(mergeNode(node, base, remote, fields, edited));
  }
  for (const node of prepared.remote.nodes) {
    if (localChanges.nodes.deleted.has(node.id)) {
      if (!snapshot && prepared.nodes.changed.has(node.id)) {
        notices.push({ kind: 'localDeletedRemoteChanged', nodeId: node.id });
      }
    } else if (!localById.has(node.id) && prepared.nodes.added.has(node.id)) {
      const added = { ...node };
      delete added.selected;
      delete added.dragging;
      delete added.resizing;
      nodes.push(added);
    }
  }
  const detached = detachOrphans(nodes, [localById, prepared.nodes.baseById, prepared.nodes.remoteById]);
  const ordered = parentsFirst(detached);
  const nodeIds = new Set(ordered.map(node => node.id));
  const edges: CanvasEdge[] = [];
  const localEdgeIds = new Set(local.edges.map(edge => edge.id));
  for (const edge of local.edges) {
    if (localChanges.edges.created.has(edge.id)) edges.push(edge);
    else {
      const remote = prepared.edges.remoteById.get(edge.id);
      if (remote) edges.push(mergeEdge(edge, remote, prepared.edges.changed.get(edge.id) ?? new Set()));
    }
  }
  for (const edge of prepared.remote.edges) {
    if (prepared.edges.added.has(edge.id) && !localEdgeIds.has(edge.id)) {
      const added = { ...edge };
      delete added.selected;
      edges.push(added);
    }
  }
  const connectedEdges = edges.filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  return {
    nodes: ordered, edges: connectedEdges, notices,
    changed: !sameItems(local.nodes, ordered) || !sameItems(local.edges, connectedEdges),
  };
}

function absolutePosition(nodeId: string, nodes: ReadonlyMap<string, CanvasNode>): CanvasNode['position'] | null {
  let node = nodes.get(nodeId);
  const visited = new Set<string>();
  const position = { x: 0, y: 0 };
  while (node && !visited.has(node.id)) {
    visited.add(node.id);
    position.x += node.position.x;
    position.y += node.position.y;
    if (!node.parentId) return position;
    node = nodes.get(node.parentId);
  }
  return null;
}

function detachOrphans(
  nodes: CanvasNode[], sources: readonly ReadonlyMap<string, CanvasNode>[],
): CanvasNode[] {
  const ids = new Set(nodes.map(node => node.id));
  return nodes.map(node => {
    if (!node.parentId || ids.has(node.parentId)) return node;
    let position = node.position;
    for (const source of sources) {
      const absolute = absolutePosition(node.id, source);
      if (absolute) {
        position = absolute;
        break;
      }
    }
    const detached = { ...node, position };
    delete detached.parentId;
    delete detached.extent;
    return detached;
  });
}

function parentsFirst(nodes: CanvasNode[]): CanvasNode[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const visited = new Set<string>();
  const ordered: CanvasNode[] = [];
  function visit(node: CanvasNode): void {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) visit(parent);
    ordered.push(node);
  }
  nodes.forEach(visit);
  return ordered;
}

function sameItems<T>(local: readonly T[], merged: readonly T[]): boolean {
  return local.length === merged.length && local.every((item, index) => item === merged[index]);
}

function patchElements<T extends { id: string }>(
  base: readonly T[], updates: readonly T[], deletedIds: readonly string[],
): T[] {
  const byId = new Map(base.map(item => [item.id, item]));
  for (const item of updates) byId.set(item.id, item);
  for (const id of deletedIds) byId.delete(id);
  return [...byId.values()];
}
