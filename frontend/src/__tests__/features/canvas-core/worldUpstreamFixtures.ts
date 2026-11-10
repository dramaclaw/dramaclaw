// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { CANVAS_NODE_TYPES as T, type CanvasNode, type CanvasEdge, type ThreeDWorldNodeData } from '@/features/canvas/domain/canvasNodes';

export const worldId = 'world';
function node(id: string, type: CanvasNode['type'], data: CanvasNode['data'] = {}, y = 0): CanvasNode {
  return { id, type, position: { x: 0, y }, data };
}
const image = (id: string, y = 0) => node(id, T.imageGen, { imageUrl: `https://media.example.test/${id}.png` }, y);
const text = (id: string, content = 'A field.', y = 0) => node(id, T.textAnnotation, { content }, y);
export interface WorldUpstreamFixture {
  name: string;
  canvas: { nodes: CanvasNode[]; edges: CanvasEdge[] };
  expected: { nodeId: string; kind: 'image' | 'text' } | null;
}
function graph(name: string, sources: CanvasNode[], selected: string | null, options: {
  sourceNodeId?: unknown; edges?: CanvasEdge[]; kind?: 'image' | 'text'; data?: ThreeDWorldNodeData;
} = {}): WorldUpstreamFixture {
  return { name, canvas: {
    nodes: [node(worldId, T.threeDWorld, { sourceNodeId: options.sourceNodeId, ...options.data }), ...sources],
    edges: options.edges ?? sources.map((source, i) => ({ id: `edge-${i}`, source: source.id, target: worldId })),
  }, expected: selected === null ? null : { nodeId: selected, kind: options.kind ?? 'image' } };
}
const edge = (source: string, target = worldId): CanvasEdge => ({ id: `edge-${source}`, source, target });
const noPosition = image('no-position');
Reflect.deleteProperty(noPosition, 'position');
export const worldUpstreamFixtures: WorldUpstreamFixture[] = [
  graph('no upstream', [], null),
  graph('edges to other targets only', [image('other'), text('target')], null, { edges: [edge('other', 'target')] }),
  graph('edge from missing node', [], null, { edges: [edge('missing')] }),
  graph('execution dependency excluded', [image('dependency')], null, { edges: [{ ...edge('dependency'), data: { link_type: 'dependency_for' } }] }),
  graph('image generation image URL', [image('image')], 'image'),
  graph('image generation reference URL only', [node('ref', T.imageGen, { referenceImageUrl: 'https://media.example.test/ref.png' })], 'ref'),
  graph('image generation no URL', [node('empty', T.imageGen)], null),
  graph('image generation preview URL only ignored', [node('preview', T.imageGen, { previewImageUrl: 'https://media.example.test/preview.png' })], null),
  graph('image generation preview beats selected reference at submission', [node('preview-ref', T.imageGen, { previewImageUrl: 'https://media.example.test/preview.png', referenceImageUrl: 'https://media.example.test/ref.png' })], 'preview-ref'),
  ...([T.upload, T.imageEdit, T.exportImage, T.storyboardGen]).flatMap(type => [
    graph(`${type} image URL`, [node(type, type, { imageUrl: `https://media.example.test/${type}.png` })], type),
    graph(`${type} without image URL`, [node(type, type)], null),
    graph(`${type} reference and preview URLs ignored`, [node(type, type, { referenceImageUrl: `https://media.example.test/${type}-ref.png`, previewImageUrl: `https://media.example.test/${type}-preview.png` })], null),
  ]),
  graph('unsupported upstream type', [node('video', T.video, { imageUrl: 'https://media.example.test/video.png' })], null),
  graph('empty text', [text('text', '')], null),
  graph('whitespace text', [text('text', ' \n\t ')], null),
  graph('nonempty trimmed text refusal', [text('text', '  A field.  ')], 'text', { kind: 'text' }),
  graph('images sorted by y before edge order', [image('low', 30), image('high', -10), image('middle', 5)], 'high'),
  graph('missing position treated as zero', [image('positive', 30), noPosition, image('zero', 0)], 'no-position'),
  graph('equal y keeps edge order over node order', [image('created-first', 5), image('connected-first', 5)], 'connected-first', { edges: [edge('connected-first'), edge('created-first')] }),
  graph('reference order ignored', [image('first', -10), image('second', 10)], 'first', { data: { referenceOrder: ['second', 'first'] } }),
  graph('sourceNodeId later image', [image('first', -10), image('later', 10)], 'later', { sourceNodeId: 'later' }),
  graph('sourceNodeId matching text ignored', [text('text', 'Text', -10), image('image')], 'image', { sourceNodeId: 'text' }),
  graph('sourceNodeId unusable image ignored', [image('image'), node('empty', T.imageGen)], 'image', { sourceNodeId: 'empty' }),
  graph('sourceNodeId missing ignored', [image('image')], 'image', { sourceNodeId: 'missing' }),
  graph('sourceNodeId nonstring ignored', [image('image')], 'image', { sourceNodeId: 7 }),
  graph('sourceNodeId disconnected image ignored', [image('first'), image('disconnected')], 'first', { sourceNodeId: 'disconnected', edges: [edge('first')] }),
  graph('image wins over earlier text', [text('text', 'Text', -100), image('image', 100)], 'image'),
  graph('text only first by y refusal', [text('later', 'Later', 10), text('first', 'First', -10)], 'first', { kind: 'text' }),
  graph('duplicate edges same source', [image('duplicate'), image('other')], 'duplicate', { edges: [edge('duplicate'), edge('other'), { ...edge('duplicate'), id: 'duplicate-edge' }] }),
];
// Unlike the pure selector, the worker's existing graph envelope requires positions.
export const workerWorldUpstreamFixtures = worldUpstreamFixtures.filter(f => f.canvas.nodes.every(n => n.position !== undefined));
export const invalidWorldUpstreamPayloads: unknown[] = [
  { node_id: worldId },
  { canvas: { nodes: [], edges: [] }, node_id: 7 },
  { canvas: { nodes: [], edges: [] }, node_id: worldId, extra: true },
  { canvas: { nodes: [], edges: [] }, node_id: worldId, env: { extra: true } },
  { canvas: { nodes: [], edges: [] }, node_id: worldId, env: { locale: 7 } },
  { canvas: { nodes: [], edges: [] }, node_id: worldId, env: null },
  { canvas: { nodes: [noPosition], edges: [] }, node_id: worldId },
];
