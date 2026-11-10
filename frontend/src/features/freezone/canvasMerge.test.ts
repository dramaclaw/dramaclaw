// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';
import type { CanvasEdge, CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  applyCanvasPatch,
  localCanvasChanges,
  mergeCanvas,
  mergeCanvasMetadata,
  prepareRemoteCanvasChange,
  replayRemoteChangeOnSnapshot,
  type Canvas,
  type CanvasEditing,
  type CanvasMergeNotice,
} from './canvasMerge';

const node = (id = 'n1', overrides: Partial<CanvasNode> = {}): CanvasNode => ({
  id, type: 'textAnnotationNode', position: { x: 0, y: 0 }, data: { text: 'base' },
  ...overrides,
} as CanvasNode);
const edge = (id = 'e1', overrides: Partial<CanvasEdge> = {}): CanvasEdge => ({
  id, source: 'n1', target: 'n2', ...overrides,
} as CanvasEdge);
const canvas = (nodes: CanvasNode[] = [], edges: CanvasEdge[] = []): Canvas => ({ nodes, edges });

// Freeze fixtures recursively so writes to shared positions, data, or arrays fail too.
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}

describe('mergeCanvas fields', () => {
  it.each<{
    name: string; local: Partial<CanvasNode>; remote: Partial<CanvasNode>;
    editing?: CanvasEditing; expected: Partial<CanvasNode>; changed: boolean;
  }>([
    { name: 'local-only data key', local: { data: { text: 'local' } }, remote: {},
      expected: { data: { text: 'local' } }, changed: false },
    { name: 'remote-only data key', local: {}, remote: { data: { text: 'remote' } },
      expected: { data: { text: 'remote' } }, changed: true },
    { name: 'both changed without editing', local: { data: { text: 'local' } },
      remote: { data: { text: 'remote' } }, expected: { data: { text: 'remote' } }, changed: true },
    { name: 'both changed while editing', local: { data: { text: 'local' } },
      remote: { data: { text: 'remote' } }, editing: [{ nodeId: 'n1', field: 'data.text' }],
      expected: { data: { text: 'local' } }, changed: false },
    { name: 'independent data keys', local: { data: { text: 'local' } },
      remote: { data: { text: 'base', color: 'blue' } },
      expected: { data: { text: 'local', color: 'blue' } }, changed: true },
    { name: 'data key removal', local: {}, remote: { data: {} },
      expected: { data: {} }, changed: true },
    { name: 'prototype-named data keys are ordinary keys', local: {},
      remote: { data: { text: 'base', ['__proto__']: { color: 'blue' } } },
      expected: { data: { text: 'base', ['__proto__']: { color: 'blue' } } }, changed: true },
    { name: 'nested data values are atomic', local: { data: { text: 'base', config: { a: 1 } } },
      remote: { data: { text: 'base', config: { b: 2 } } },
      expected: { data: { text: 'base', config: { b: 2 } } }, changed: true },
    { name: 'remote group wins together', local: { position: { x: 5, y: 6 } },
      remote: { parentId: 'g1', extent: 'parent' },
      expected: { parentId: 'g1', extent: 'parent', position: { x: 0, y: 0 } }, changed: true },
    { name: 'dragging keeps the entire local group', local: { position: { x: 5, y: 6 }, dragging: true },
      remote: { parentId: 'g1', extent: 'parent' },
      expected: { position: { x: 5, y: 6 }, dragging: true }, changed: false },
    { name: 'data and group merge independently', local: { data: { text: 'local' } },
      remote: { position: { x: 9, y: 8 } },
      expected: { position: { x: 9, y: 8 }, data: { text: 'local' } }, changed: true },
    { name: 'resizing protects dimensions style and group',
      local: { width: 10, height: 20, style: { width: 10 }, position: { x: 1, y: 2 }, resizing: true },
      remote: { width: 30, height: 40, style: { width: 30 }, parentId: 'g1' },
      expected: { width: 10, height: 20, style: { width: 10 }, position: { x: 1, y: 2 } }, changed: false },
    { name: 'remote fields and local view state', local: { selected: true, measured: { width: 77 } },
      remote: { width: 30, height: 40, style: { height: 40 }, type: 'groupNode', selected: false },
      expected: { width: 30, height: 40, style: { height: 40 }, type: 'groupNode',
        selected: true, measured: { width: 77 } }, changed: true },
    { name: 'editing another node does not protect this field', local: { data: { text: 'local' } },
      remote: { data: { text: 'remote' } }, editing: [{ nodeId: 'n2', field: 'data.text' }],
      expected: { data: { text: 'remote' } }, changed: true },
    { name: 'editing without a local change still accepts remote', local: {},
      remote: { data: { text: 'remote' } }, editing: [{ nodeId: 'n1', field: 'data.text' }],
      expected: { data: { text: 'remote' } }, changed: true },
    { name: 'resizing without local dimension changes still accepts remote', local: { resizing: true },
      remote: { width: 30, height: 40 }, expected: { width: 30, height: 40 }, changed: true },
  ])('$name', ({ local, remote, editing = [], expected, changed }) => {
    const base = freeze(canvas([node('g1'), node()]));
    const localCanvas = freeze(canvas([node('g1'), node('n1', local)]));
    const remoteCanvas = freeze(canvas([node('g1'), node('n1', remote)]));
    const result = mergeCanvas(localCanvas, prepareRemoteCanvasChange(base, remoteCanvas), editing);
    expect(result.nodes.map(n => n.id)).toEqual(['g1', 'n1']);
    expect(result.nodes[1]).toMatchObject(expected);
    expect(result.nodes[1].data).toEqual(expected.data ?? { text: 'base' });
    expect(result.nodes[1].parentId).toBe(expected.parentId);
    expect(result.nodes[1].extent).toBe(expected.extent);
    expect(result.changed).toBe(changed);
    expect(result.notices).toEqual([]);
    expect(result.nodes[0]).toBe(localCanvas.nodes[0]);
    if (!changed) expect(result.nodes[1]).toBe(localCanvas.nodes[1]);
    else expect(result.nodes[1]).not.toBe(localCanvas.nodes[1]);
  });

  it.each([
    { name: 'view state only', base: node(), local: node('n1', { selected: true }),
      remote: node('n1', { selected: false, dragging: true, resizing: true, measured: { width: 8 } }) },
    { name: 'key order and undefined',
      base: node('n1', { data: { text: 'base', config: { a: 1, b: 2, gone: undefined }, gone: undefined } }),
      local: node('n1', { data: { text: 'base', config: { a: 1, b: 2, gone: undefined }, gone: undefined } }),
      remote: node('n1', { data: { config: { b: 2, a: 1 }, text: 'base' } }) },
  ])('preserves identity for $name', ({ base, local, remote }) => {
    const prepared = prepareRemoteCanvasChange(freeze(canvas([base])), freeze(canvas([remote])));
    const result = mergeCanvas(freeze(canvas([local])), prepared);
    expect(result.nodes[0]).toBe(local);
    expect(result.changed).toBe(false);
    expect([...prepared.nodes.changed]).toEqual([]);
    expect(result.notices).toEqual([]);
  });

  it.each([
    { name: 'arrays compare structurally',
      baseData: { text: 'base', list: [{ a: 1, gone: undefined }, 2] },
      remoteData: { list: [{ a: 1 }, 2], text: 'base' }, changed: false },
    { name: 'array order matters', baseData: { text: 'base', list: [1, 2] },
      remoteData: { text: 'base', list: [2, 1] }, changed: true },
  ])('$name', ({ baseData, remoteData, changed }) => {
    const base = freeze(canvas([node('n1', { data: baseData })]));
    const result = mergeCanvas(base, prepareRemoteCanvasChange(base,
      freeze(canvas([node('n1', { data: remoteData })]))));
    expect(result.changed).toBe(changed);
    expect(result.nodes[0].data.list).toEqual(changed ? [2, 1] : [{ a: 1, gone: undefined }, 2]);
    if (!changed) expect(result.nodes[0]).toBe(base.nodes[0]);
  });

  it.each([
    { name: 'optional content fields',
      original: node('n1', { width: 10, height: 20, style: { width: 10 }, parentId: 'g1', extent: 'parent' }),
      localData: { text: 'base' },
      remote: node(), expected: { id: 'n1', type: 'textAnnotationNode',
        position: { x: 0, y: 0 }, data: { text: 'base' }, selected: true } },
    { name: 'data key when another data key changes locally',
      original: node('n1', { data: { text: 'base', color: 'red' } }),
      localData: { text: 'local', color: 'red' },
      remote: node('n1', { data: { text: 'base' } }),
      expected: { id: 'n1', type: 'textAnnotationNode', position: { x: 0, y: 0 },
        data: { text: 'local' }, selected: true } },
    { name: 'prototype-named data keys',
      original: node('n1', { data: { text: 'base', ['__proto__']: { color: 'red' } } }),
      localData: { text: 'local', ['__proto__']: { color: 'red' } },
      remote: node('n1', { data: { text: 'base' } }),
      expected: { id: 'n1', type: 'textAnnotationNode', position: { x: 0, y: 0 },
        data: { text: 'local' }, selected: true } },
  ])('removes $name', ({ original, localData, remote, expected }) => {
    const base = freeze(canvas([node('g1'), original]));
    const local = freeze(canvas([node('g1'), { ...original, selected: true, data: localData }]));
    const result = mergeCanvas(local, prepareRemoteCanvasChange(base, freeze(canvas([node('g1'), remote]))));
    expect(result.nodes[1]).toEqual(expected);
    expect(result.changed).toBe(true);
  });
});

describe('node membership', () => {
  it.each<{
    name: string; base: CanvasNode[]; local: CanvasNode[]; remote: CanvasNode[];
    editing?: CanvasEditing; ids: string[]; texts: string[]; notices: CanvasMergeNotice[]; changed: boolean;
  }>([
    { name: 'local creation absent remotely', base: [], local: [node()], remote: [],
      ids: ['n1'], texts: ['base'], notices: [], changed: false },
    { name: 'local deletion against unchanged remote', base: [node()], local: [], remote: [node()],
      ids: [], texts: [], notices: [], changed: false },
    { name: 'local deletion against changed remote', base: [node()], local: [],
      remote: [node('n1', { data: { text: 'remote' } })], ids: [], texts: [],
      notices: [{ kind: 'localDeletedRemoteChanged', nodeId: 'n1' }], changed: false },
    { name: 'deletion ignores remote view changes', base: [node()], local: [],
      remote: [node('n1', { selected: true })], ids: [], texts: [], notices: [], changed: false },
    { name: 'both sides delete', base: [node()], local: [], remote: [],
      ids: [], texts: [], notices: [], changed: false },
    { name: 'remote new follows local order', base: [node('n2'), node()], local: [node('n2'), node()],
      remote: [node('n3'), node(), node('n2'), node('n4')],
      ids: ['n2', 'n1', 'n3', 'n4'], texts: ['base', 'base', 'base', 'base'], notices: [], changed: true },
    { name: 'same id creation favors remote', base: [], local: [node('n1', { data: { text: 'local' } })],
      remote: [node('n1', { data: { text: 'remote' } })],
      ids: ['n1'], texts: ['remote'], notices: [], changed: true },
    { name: 'same id creation respects editing', base: [], local: [node('n1', { data: { text: 'local' } })],
      remote: [node('n1', { data: { text: 'remote' } })], editing: [{ nodeId: 'n1', field: 'data.text' }],
      ids: ['n1'], texts: ['local'], notices: [], changed: false },
    { name: 'remote deletion of unchanged local', base: [node()], local: [node()], remote: [],
      ids: [], texts: [], notices: [], changed: true },
    { name: 'remote deletion of changed local', base: [node()],
      local: [node('n1', { data: { text: 'local' } })], remote: [], ids: ['n1'], texts: ['local'],
      notices: [{ kind: 'remoteDeletedLocalKept', nodeId: 'n1' }], changed: false },
    { name: 'remote deletion while editing only', base: [node()], local: [node()], remote: [],
      editing: [{ nodeId: 'n1', field: 'data.text' }], ids: ['n1'], texts: ['base'],
      notices: [{ kind: 'remoteDeletedLocalKept', nodeId: 'n1' }], changed: false },
    { name: 'remote deletion while dragging only', base: [node()], local: [node('n1', { dragging: true })], remote: [],
      ids: ['n1'], texts: ['base'], notices: [{ kind: 'remoteDeletedLocalKept', nodeId: 'n1' }], changed: false },
    { name: 'remote deletion while resizing only', base: [node()], local: [node('n1', { resizing: true })], remote: [],
      ids: ['n1'], texts: ['base'], notices: [{ kind: 'remoteDeletedLocalKept', nodeId: 'n1' }], changed: false },
  ])('$name', ({ base, local, remote, editing = [], ids, texts, notices, changed }) => {
    const result = mergeCanvas(freeze(canvas(local)),
      prepareRemoteCanvasChange(freeze(canvas(base)), freeze(canvas(remote))), editing);
    expect(result.nodes.map(n => n.id)).toEqual(ids);
    expect(result.nodes.map(n => n.data.text)).toEqual(texts);
    expect(result.notices).toEqual(notices);
    expect(result.changed).toBe(changed);
    for (const n of result.nodes) {
      const original = local.find(l => l.id === n.id);
      if (original && original.data.text === n.data.text) expect(n).toBe(original);
    }
  });

  it.each([true, false])('strips remote interaction flags when selected is %s', selected => {
    const remote = freeze(canvas([node('n1', { selected, dragging: true, resizing: true })]));
    const result = mergeCanvas(canvas(), prepareRemoteCanvasChange(canvas(), remote));
    expect(result.nodes[0]).toEqual({
      id: 'n1', type: 'textAnnotationNode', position: { x: 0, y: 0 }, data: { text: 'base' },
    });
    expect(result.changed).toBe(true);
  });

  it.each([
    { base: [node('n1'), node('n2')], local: [node('n2'), node('n3')], created: ['n3'], deleted: ['n1'] },
    { base: [], local: [], created: [], deleted: [] },
  ])('derives local membership changes: %j', ({ base, local, created, deleted }) => {
    const changes = localCanvasChanges(freeze(canvas(base)), freeze(canvas(local)));
    expect([...changes.nodes.created]).toEqual(created);
    expect([...changes.nodes.deleted]).toEqual(deleted);
  });
});

describe('parents and order', () => {
  it.each([
    { name: 'one level from base',
      base: [node('g1', { position: { x: 10, y: 20 } }), node('n1', { parentId: 'g1', extent: 'parent', position: { x: 2, y: 3 } })],
      local: [node('g1', { position: { x: 30, y: 40 } }), node('n1', { parentId: 'g1', extent: 'parent', position: { x: 2, y: 3 } })],
      remote: [node('n1', { parentId: 'g1', extent: 'parent', position: { x: 2, y: 3 } })],
      deleteLocalParent: true, expected: { x: 12, y: 23 } },
    { name: 'one level with complete local chain',
      base: [node('g1', { position: { x: 10, y: 20 } }), node('n1', { parentId: 'g1', extent: 'parent', position: { x: 2, y: 3 } })],
      local: [node('g1', { position: { x: 10, y: 20 } }), node('n1', { parentId: 'g1', extent: 'parent', position: { x: 5, y: 6 } })],
      remote: [node('n1', { parentId: 'g1', extent: 'parent', position: { x: 2, y: 3 } })],
      deleteLocalParent: false, expected: { x: 15, y: 26 } },
    { name: 'two levels from base',
      base: [node('g1', { position: { x: 10, y: 20 } }), node('g2', { parentId: 'g1', position: { x: 3, y: 4 } }),
        node('n1', { parentId: 'g2', extent: 'parent', position: { x: 1, y: 2 } })],
      local: [node('n1', { parentId: 'g2', extent: 'parent', position: { x: 1, y: 2 } })],
      remote: [node('n1', { parentId: 'g2', extent: 'parent', position: { x: 1, y: 2 } })],
      deleteLocalParent: false, expected: { x: 14, y: 26 } },
    { name: 'chain exists only remotely', base: [node('g1')], local: [],
      remote: [node('g1', { position: { x: 7, y: 8 } }),
        node('n1', { parentId: 'g1', extent: 'parent', position: { x: 2, y: 3 } })],
      deleteLocalParent: false, expected: { x: 9, y: 11 } },
  ])('detaches orphan: $name', ({ base, local, remote, deleteLocalParent, expected }) => {
    const localCanvas = freeze(canvas(deleteLocalParent ? local.filter(n => n.id !== 'g1') : local));
    const result = mergeCanvas(localCanvas, prepareRemoteCanvasChange(freeze(canvas(base)), freeze(canvas(remote))));
    expect(result.nodes.map(n => n.id)).toEqual(['n1']);
    expect(result.nodes[0].position).toEqual(expected);
    expect(result.nodes[0]).not.toHaveProperty('parentId');
    expect(result.nodes[0]).not.toHaveProperty('extent');
    expect(result.changed).toBe(true);
  });

  it.each([
    { remote: [node('n1', { parentId: 'g1' }), node('g1')], expected: ['g1', 'n1', 'n2'] },
    { remote: [node('n1', { parentId: 'g2' }), node('g2', { parentId: 'g1' }), node('g1')],
      expected: ['g1', 'g2', 'n1', 'n2'] },
  ])('places added parents before existing children: %j', ({ remote, expected }) => {
    const base = freeze(canvas([node(), node('n2')]));
    const result = mergeCanvas(base, prepareRemoteCanvasChange(base,
      freeze(canvas([...remote, node('n2')]))));
    expect(result.nodes.map(n => n.id)).toEqual(expected);
    expect(result.nodes.find(n => n.id === 'n2')).toBe(base.nodes[1]);
    expect(result.changed).toBe(true);
  });

  it.each([
    { local: [node('n1', { parentId: 'g1' }), node('g1')], expected: ['g1', 'n1'], changed: true },
    { local: [node('g1'), node('n1', { parentId: 'g1' })], expected: ['g1', 'n1'], changed: false },
  ])('reports ordering changes alone: %j', ({ local, expected, changed }) => {
    const base = freeze(canvas(local));
    const result = mergeCanvas(base, prepareRemoteCanvasChange(base, base));
    expect(result.nodes.map(n => n.id)).toEqual(expected);
    expect(result.changed).toBe(changed);
    expect(result.nodes.find(n => n.id === 'n1')).toBe(local.find(n => n.id === 'n1'));
  });
});

describe('edges', () => {
  it.each([true, false])('strips selected from remote-new edges (%s)', selected => {
    const base = canvas([node(), node('n2')]);
    const result = mergeCanvas(base, prepareRemoteCanvasChange(base,
      canvas([...base.nodes], [edge('new', { selected })])));
    expect(result.edges).toEqual([{ id: 'new', source: 'n1', target: 'n2' }]);
  });

  it.each([
    { name: 'local creation', base: [], local: [edge()], remote: [], ids: ['e1'], changed: false },
    { name: 'local deletion', base: [edge()], local: [], remote: [edge()], ids: [], changed: false },
    { name: 'remote deletion', base: [edge()], local: [edge()], remote: [], ids: [], changed: true },
    { name: 'remote new follows local order', base: [edge('e2')], local: [edge('e2'), edge('e1')],
      remote: [edge('e3'), edge('e2'), edge('e4')], ids: ['e2', 'e1', 'e3', 'e4'], changed: true },
    { name: 'same id creation keeps local edge', base: [], local: [edge('e1', { type: 'local' })],
      remote: [edge('e1', { type: 'remote' })], ids: ['e1'], changed: false },
    { name: 'view state only', base: [edge()], local: [edge('e1', { selected: true })],
      remote: [edge('e1', { selected: false })], ids: ['e1'], changed: false },
  ])('$name', ({ base, local, remote, ids, changed }) => {
    const nodes = [node(), node('n2')];
    const result = mergeCanvas(freeze(canvas(nodes, local)),
      prepareRemoteCanvasChange(freeze(canvas(nodes, base)), freeze(canvas(nodes, remote))));
    expect(result.edges.map(e => e.id)).toEqual(ids);
    expect(result.changed).toBe(changed);
    if (local.length && ids.includes(local[0].id)) expect(result.edges[0]).toBe(local[0]);
  });

  it.each([
    { name: 'local-only field', local: { sourceHandle: 'local' }, remote: {},
      expected: { sourceHandle: 'local' }, changed: false },
    { name: 'remote-only field', local: {}, remote: { targetHandle: 'remote' },
      expected: { targetHandle: 'remote' }, changed: true },
    { name: 'both changed', local: { type: 'local' }, remote: { type: 'remote' },
      expected: { type: 'remote' }, changed: true },
    { name: 'independent fields', local: { sourceHandle: 'local' }, remote: { target: 'n3', data: { a: 1 } },
      expected: { sourceHandle: 'local', target: 'n3', data: { a: 1 } }, changed: true },
    { name: 'source change', local: {}, remote: { source: 'n3' }, expected: { source: 'n3' }, changed: true },
    { name: 'nested data is a whole edge field', local: { data: { a: 1 } }, remote: { data: { b: 2 } },
      expected: { data: { b: 2 } }, changed: true },
  ])('$name', ({ local, remote, expected, changed }) => {
    const nodes = [node(), node('n2'), node('n3')];
    const localEdge = edge('e1', { selected: true, ...local });
    const result = mergeCanvas(freeze(canvas(nodes, [localEdge])),
      prepareRemoteCanvasChange(freeze(canvas(nodes, [edge()])), freeze(canvas(nodes, [edge('e1', remote)]))));
    expect(result.edges[0]).toEqual({ id: 'e1', source: 'n1', target: 'n2', selected: true, ...expected });
    expect(result.changed).toBe(changed);
    if (changed) expect(result.edges[0]).not.toBe(localEdge);
    else expect(result.edges[0]).toBe(localEdge);
  });

  it.each([
    { name: 'node deleted locally', local: [node()], remote: [node(), node('n2')] },
    { name: 'node deleted remotely', local: [node(), node('n2')], remote: [node()] },
  ])('drops every edge with a $name', ({ local, remote }) => {
    const result = mergeCanvas(freeze(canvas(local, [edge(), edge('e2')])),
      prepareRemoteCanvasChange(freeze(canvas([node(), node('n2')], [edge()])),
        freeze(canvas(remote, [edge(), edge('e3')]))));
    expect(result.nodes.map(n => n.id)).toEqual(['n1']);
    expect(result.edges).toEqual([]);
    expect(result.changed).toBe(true);
  });
});

describe('prepared remote changes', () => {
  it.each([0, 1])('indexes differences once and reuses them for snapshot %s', index => {
    const base = freeze(canvas([node(), node('n2')], [edge(), edge('e2')]));
    const remote = freeze(canvas([node('n1', { position: { x: 1, y: 2 }, data: { text: 'remote' } }), node('n3')],
      [edge('e1', { target: 'n3' }), edge('e3', { target: 'n3' })]));
    const prepared = prepareRemoteCanvasChange(base, remote);
    expect(prepared.remote).toBe(remote);
    expect([...prepared.nodes.added]).toEqual(['n3']);
    expect([...prepared.nodes.deleted]).toEqual(['n2']);
    expect([...prepared.nodes.changed.get('n1') ?? []].sort()).toEqual(['data.text', 'group']);
    expect([...prepared.edges.added]).toEqual(['e3']);
    expect([...prepared.edges.deleted]).toEqual(['e2']);
    expect([...prepared.edges.changed.get('e1') ?? []]).toEqual(['target']);
    const snapshots = [canvas([node()]), canvas([node('n1', { width: 9 })])];
    freeze(snapshots);
    const first = mergeCanvas(snapshots[index], prepared);
    const second = mergeCanvas(snapshots[index], prepared);
    expect(first).toEqual(second);
    expect(first.nodes.map(n => n.id)).toEqual(['n1', 'n3']);
    expect(first.nodes[0].data).toEqual({ text: 'remote' });
    expect(first.nodes[0].position).toEqual({ x: 1, y: 2 });
    expect(first.nodes[0].width).toBe(index === 0 ? undefined : 9);
    expect([...prepared.nodes.deleted]).toEqual(['n2']);
    const changes = localCanvasChanges(base, canvas([node()], [edge('e3')]));
    expect([...changes.edges.created]).toEqual(['e3']);
    expect([...changes.edges.deleted]).toEqual(['e1', 'e2']);
  });
});

describe('applyCanvasPatch', () => {
  it.each([
    { name: 'replace and append in patch order',
      patch: { nodes: [node('n1', { data: { text: 'patch' } }), node('n4'), node('n3')],
        edges: [edge('e1', { target: 'n3' }), edge('e3'), edge('e2')], deleted_node_ids: [], deleted_edge_ids: [] },
      ids: ['n1', 'n2', 'n4', 'n3'], texts: ['patch', 'base', 'base', 'base'], edgeIds: ['e1', 'e3', 'e2'], target: 'n3' },
    { name: 'delete wins and removes dangling edges',
      patch: { nodes: [node('n2')], edges: [edge('e2')], deleted_node_ids: ['n2'], deleted_edge_ids: ['e2'] },
      ids: ['n1'], texts: ['base'], edgeIds: [], target: undefined },
    { name: 'explicit edge deletion',
      patch: { nodes: [], edges: [], deleted_node_ids: [], deleted_edge_ids: ['e1'] },
      ids: ['n1', 'n2'], texts: ['base', 'base'], edgeIds: [], target: undefined },
  ])('$name without input mutation', ({ patch, ids, texts, edgeIds, target }) => {
    const base = freeze(canvas([node(), node('n2')], [edge()]));
    freeze(patch);
    const result = applyCanvasPatch(base, patch);
    expect(result.nodes.map(n => n.id)).toEqual(ids);
    expect(result.nodes.map(n => n.data.text)).toEqual(texts);
    expect(result.edges.map(e => e.id)).toEqual(edgeIds);
    expect(result.edges[0]?.target).toBe(target);
    expect(base.nodes.map(n => n.id)).toEqual(['n1', 'n2']);
    expect(base.nodes[0].data).toEqual({ text: 'base' });
    expect(base.edges[0].target).toBe('n2');
    expect(result.nodes[0]).toBe(ids.length === 4 ? patch.nodes[0] : base.nodes[0]);
  });
});

describe('replayRemoteChangeOnSnapshot', () => {
  it.each<{
    name: string; base: Canvas; snapshot: Canvas; remote: Canvas;
    expected: { ids: string[]; data: unknown[]; positions: { x: number; y: number }[]; edges: string[] } | null;
  }>([
    { name: 'remote text and snapshot position both survive', base: canvas([node()]),
      snapshot: canvas([node('n1', { position: { x: 7, y: 8 }, data: { text: 'snapshot' } })]),
      remote: canvas([node('n1', { data: { text: 'remote' } })]),
      expected: { ids: ['n1'], data: [{ text: 'remote' }], positions: [{ x: 7, y: 8 }], edges: [] } },
    { name: 'snapshot lacking changed node keeps lacking it', base: canvas([node()]), snapshot: canvas(),
      remote: canvas([node('n1', { data: { text: 'remote' } })]),
      expected: { ids: [], data: [], positions: [], edges: [] } },
    { name: 'remote new node added', base: canvas(), snapshot: canvas(), remote: canvas([node()]),
      expected: { ids: ['n1'], data: [{ text: 'base' }], positions: [{ x: 0, y: 0 }], edges: [] } },
    { name: 'unchanged deleted node removed along with edges', base: canvas([node(), node('n2')], [edge()]),
      snapshot: canvas([node(), node('n2')], [edge()]), remote: canvas([node('n2')]),
      expected: { ids: ['n2'], data: [{ text: 'base' }], positions: [{ x: 0, y: 0 }], edges: [] } },
    { name: 'changed deleted node conflicts', base: canvas([node()]),
      snapshot: canvas([node('n1', { data: { text: 'snapshot' } })]), remote: canvas(), expected: null },
    { name: 'view flags do not conflict or count as editing', base: canvas([node()]),
      snapshot: canvas([node('n1', { selected: true, dragging: true, resizing: true })]), remote: canvas(),
      expected: { ids: [], data: [], positions: [], edges: [] } },
  ])('$name', ({ base, snapshot, remote, expected }) => {
    const result = replayRemoteChangeOnSnapshot(freeze(snapshot),
      prepareRemoteCanvasChange(freeze(base), freeze(remote)));
    if (expected === null) {
      expect(result).toBeNull();
      return;
    }
    expect(result).not.toBeNull();
    expect(result?.nodes.map(n => n.id)).toEqual(expected.ids);
    expect(result?.nodes.map(n => n.data)).toEqual(expected.data);
    expect(result?.nodes.map(n => n.position)).toEqual(expected.positions);
    expect(result?.edges.map(e => e.id)).toEqual(expected.edges);
    expect(result).not.toHaveProperty('notices');
  });
});

describe('mergeCanvasMetadata', () => {
  it.each([
    { name: 'remote-only key', base: { a: 1 }, local: { a: 1 }, remote: { a: 2 },
      metadata: { a: 2 }, taken: ['a'], kept: [] },
    { name: 'local-only key', base: { a: 1 }, local: { a: 2 }, remote: { a: 1 },
      metadata: { a: 2 }, taken: [], kept: ['a'] },
    { name: 'both changed keeps local', base: { a: 1 }, local: { a: 2 }, remote: { a: 3 },
      metadata: { a: 2 }, taken: [], kept: ['a'] },
    { name: 'remote removes key', base: { a: 1 }, local: { a: 1 }, remote: {},
      metadata: {}, taken: ['a'], kept: [] },
    { name: 'local removes key', base: { a: 1 }, local: {}, remote: { a: 2 },
      metadata: {}, taken: [], kept: ['a'] },
    { name: 'null stays null', base: null, local: null, remote: null,
      metadata: null, taken: [], kept: [] },
    { name: 'null accepts addition', base: null, local: null, remote: { a: 1 },
      metadata: { a: 1 }, taken: ['a'], kept: [] },
    { name: 'key order and undefined are ignored', base: { a: { x: 1, y: 2 } },
      local: { a: { y: 2, x: 1, z: undefined } }, remote: { a: { x: 3 } },
      metadata: { a: { x: 3 } }, taken: ['a'], kept: [] },
    { name: 'same changes need no save', base: { a: 1 }, local: { a: 2 }, remote: { a: 2 },
      metadata: { a: 2 }, taken: [], kept: [] },
  ])('$name', ({ base, local, remote, metadata, taken, kept }) => {
    expect(mergeCanvasMetadata(freeze(base), freeze(local), freeze(remote))).toEqual({
      metadata, takenFromRemote: taken, localKeptKeys: kept,
    });
  });
});
