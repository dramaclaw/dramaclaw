import { describe, expect, it } from 'vitest';
import type { CanvasNode, CanvasEdge } from '@/features/canvas/domain/canvasNodes';
import { buildStoryboardProjection, normalizeBoardMetadata, orderedCards, reorderCards } from '@/features/storyboard/projection';
import { useStoryboardMetadata, useStoryboardView } from '@/features/storyboard/storyboardStore';
import { eligibleReferenceIds } from '@/features/storyboard/references';

const node = (id: string, type: string, data: Record<string, unknown>, parentId?: string) => ({ id, type, data, position: { x: 12, y: 24 }, parentId }) as CanvasNode;
const nodes = [node('g', 'groupNode', {}), node('t', 'textAnnotationNode', { content: '**Story**', createdAt: 1 }, 'g'),
  node('i', 'imageGenNode', { imageUrl: '/new.png', previewImageUrl: '/old.png', createdAt: 3 }),
  node('v', 'uploadNode', { videoUrl: '/clip.mp4', imageUrl: '/poster.jpg' }), node('a', 'uploadNode', { audioUrl: '/voice.wav' })];
const edges = [{ id: 'e', source: 't', target: 'i' }, { id: 'e2', source: 'v', target: 'i' }] as CanvasEdge[];

describe('storyboard shared graph projection', () => {
  it('classifies uploaded video/audio from actual media and excludes group containers', () => {
    const cards = buildStoryboardProjection(nodes, edges, normalizeBoardMetadata(null));
    expect(cards.map(c => c.kind)).toEqual(['text', 'image', 'video', 'audio']);
    expect(cards[1].url).toBe('/new.png');
    expect(cards[1].references).toEqual(['t', 'v']);
    expect(cards[0].text).toBe('**Story**');
  });
  it('derives changed results and references without stale copies', () => {
    const updated = nodes.map(n => n.id === 'i' ? { ...n, data: { ...n.data, imageUrl: '/latest.png' } } as CanvasNode : n);
    const card = buildStoryboardProjection(updated, [], normalizeBoardMetadata(null)).find(c => c.id === 'i')!;
    expect(card.url).toBe('/latest.png'); expect(card.references).toEqual([]);
  });
  it('normalizes old/malformed metadata, deduplicates order and ignores unknown tags', () => {
    expect(normalizeBoardMetadata({ order: { image: ['i', 'i', null] }, elementTags: { i: 'character', a: 'invalid' } })).toEqual({ version: 1, order: { text: [], image: ['i'], video: [], audio: [] }, elementTags: { i: 'character' } });
  });
  it('sorts separately, handles new/deleted nodes and never mutates graph geometry', () => {
    const graph = [...nodes, node('i2', 'imageGenNode', { createdAt: 4 }), node('i3', 'imageGenNode', { createdAt: 5 })];
    const before = JSON.stringify({ graph, edges });
    const meta = normalizeBoardMetadata({ order: { image: ['deleted', 'i', 'i2'] } });
    const cards = buildStoryboardProjection(graph, edges, meta);
    expect(orderedCards(cards, 'image', meta).map(c => c.id)).toEqual(['i3', 'i', 'i2']);
    expect(reorderCards(['i', 'i2', 'i3'], 'i3', 'i')).toEqual(['i3', 'i', 'i2']);
    expect(JSON.stringify({ graph, edges })).toBe(before);
  });
  it('hydrates without a user revision and increments only business changes', () => {
    const store = useStoryboardMetadata.getState();
    store.hydrate('project::first', null); store.reorder('image', ['i']); store.tag('i', 'character');
    expect(useStoryboardMetadata.getState().revision).toBe(2);
    const persisted = JSON.parse(JSON.stringify(useStoryboardMetadata.getState().metadata));
    store.hydrate('project::second', null);
    expect(useStoryboardMetadata.getState().metadata.elementTags).toEqual({});
    store.hydrate('project::first', persisted);
    expect(useStoryboardMetadata.getState().metadata.order.image).toEqual(['i']);
    expect(useStoryboardMetadata.getState().revision).toBe(0);
  });
  it('twenty mode changes cannot modify business state or graph data', () => {
    const before = JSON.stringify({ nodes, edges, metadata: useStoryboardMetadata.getState().metadata });
    for (let i = 0; i < 20; i++) useStoryboardView.getState().setMode(i % 2 ? 'workflow' : 'storyboard');
    expect(JSON.stringify({ nodes, edges, metadata: useStoryboardMetadata.getState().metadata })).toBe(before);
  });
  it('accepts text/image/video references for writing while rejecting self, descendants and audio', () => {
    const graph = [...nodes, node('child', 'textAnnotationNode', { content: 'child' })];
    const links = [{ id: 'child-edge', source: 't', target: 'child' }] as CanvasEdge[];
    const cards = buildStoryboardProjection(graph, links, normalizeBoardMetadata(null));
    expect([...eligibleReferenceIds(cards, links, cards.find(c => c.id === 't')!)]).toEqual(['i', 'v']);
  });
  it('respects reference order and uses video duration/cover fields', () => {
    const graph = nodes.map(n => n.id === 'i' ? { ...n, data: { ...n.data, referenceOrder: ['v', 't'] } } as CanvasNode : n.id === 'v' ? { ...n, data: { ...n.data, durationSec: 8 } } as CanvasNode : n);
    const cards = buildStoryboardProjection(graph, edges, normalizeBoardMetadata(null));
    expect(cards.find(c => c.id === 'i')!.references).toEqual(['v', 't']);
    expect(cards.find(c => c.id === 'v')).toMatchObject({ duration: 8, poster: '/poster.jpg' });
  });
  it('leaves a route without keeping storyboard shortcuts active', () => {
    useStoryboardView.getState().enterScope('preferences');
    useStoryboardView.getState().setMode('storyboard');
    useStoryboardView.getState().leaveScope();
    expect(useStoryboardView.getState()).toMatchObject({ scope: '', mode: 'workflow', host: null, historyHost: null });
  });
});
