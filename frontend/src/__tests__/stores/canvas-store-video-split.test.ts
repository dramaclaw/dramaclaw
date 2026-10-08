// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from 'vitest';
import type { CanvasNode, CanvasEdge } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import { videoSplitTextOverrides } from '@/features/canvas/application/videoPromptSplit';

const prompt = (durations = [5, 7, 7, 4, 5, 4, 7, 6, 6, 5]) =>
  'Shared {{Mixed 1}} {{Mixed 2}}\n' + durations.map((s, i) => `【镜头${i + 1}】\n时长：${s}秒\nAction ${i + 1}\n`).join('');
const node = (id: string, type: string, data: Record<string, unknown>, x = 0, y = 0) =>
  ({ id, type, data, position: { x, y }, width: 622, height: 350 }) as CanvasNode;
const source = () => node('source', 'videoNode', {
  prompt: prompt(), model: 'MiniMax-H3', durationSec: 30, videoUrl: '/old.mp4',
  previewImageUrl: '/old.jpg', durationMs: 30080, displayName: 'Video',
  referenceOrder: ['img', 'audio', 'ref-video'],
  liblibImport: { sourceUrl: 'https://example.com/old.mp4', importedLocalUrl: '/old.mp4', references: ['img'] },
}, 1872, 360);
const refs = () => [node('img', 'imageGenNode', { imageUrl: '/ref.png' }),
  node('audio', 'audioNode', { audioUrl: '/ref.wav' }),
  node('ref-video', 'videoNode', { videoUrl: '/ref.mp4' })];
const edges = () => refs().map(n => ({ id: `e-${n.id}`, source: n.id, target: 'source', sourceHandle: 'output', targetHandle: 'input' })) as CanvasEdge[];
const store = () => useCanvasStore.getState();

describe('video prompt split graph operation', () => {
  beforeEach(() => store().setCanvasData([], []));
  it('preserves references and originals, lays out horizontally, and undoes in one step', () => {
    store().setCanvasData([source(), ...refs(), node('obstacle', 'videoNode', {}, 2964, 636)], edges());
    const before = structuredClone({ nodes: store().nodes, edges: store().edges });
    const result = store().splitVideoNodeByPrompt('source');
    expect(result.totalDurationSec).toBe(56);
    expect(result.segments).toHaveLength(5);
    const parts = store().nodes.filter(n => n.data.videoPromptSplit);
    expect(parts).toHaveLength(5);
    expect(parts.map(n => n.position.y)).toEqual([360, 360, 360, 360, 360]);
    expect(parts.map(n => n.position.x)).toEqual([1872, 3634, 4304, 4974, 5644]);
    expect(parts.map(n => n.data.durationSec)).toEqual([12, 11, 9, 13, 11]);
    for (const part of parts) {
      expect(part.data.model).toBe('MiniMax-H3');
      expect(part.data.referenceOrder).toEqual(['img', 'audio', 'ref-video']);
      expect(store().edges.filter(e => e.target === part.id).map(e => [e.source, e.sourceHandle, e.targetHandle]))
        .toEqual(edges().map(e => [e.source, e.sourceHandle, e.targetHandle]));
    }
    expect(parts[0].data.videoUrl).toBe('/old.mp4');
    for (const part of parts.slice(1)) {
      expect(part.data.liblibImport).toMatchObject({ sourceUrl: '', importedLocalUrl: '', references: ['img'] });
    }
    expect(parts.slice(1).every(n => n.data.videoUrl === null && n.data.previewImageUrl === null)).toBe(true);
    for (const old of before.nodes.filter(n => n.id !== 'source')) {
      expect(store().nodes.find(n => n.id === old.id)?.position).toEqual(old.position);
    }
    store().undo();
    expect(store().nodes).toEqual(before.nodes);
    expect(store().edges).toEqual(before.edges);
    store().redo();
    expect(store().nodes.filter(n => n.data.videoPromptSplit)).toHaveLength(5);
  });
  it('preserves per-segment upstream text through serialization without editing source text', () => {
    const video = source(); video.data.prompt = 'Use the referenced screenplay';
    const text = node('text', 'textAnnotationNode', { content: prompt([8, 7, 9, 6]) });
    store().setCanvasData([video, text], [{ id: 'text-edge', source: 'text', target: 'source' }] as CanvasEdge[]);
    store().splitVideoNodeByPrompt('source');
    const saved = JSON.parse(JSON.stringify({ nodes: store().nodes, edges: store().edges }));
    store().setCanvasData(saved.nodes, saved.edges);
    expect(store().nodes.find(n => n.id === 'text')?.data.content).toBe(text.data.content);
    const parts = store().nodes.filter(n => n.data.videoPromptSplit);
    expect(parts).toHaveLength(2);
    expect(videoSplitTextOverrides(parts[0].data).text).toContain('Action 1');
    expect(videoSplitTextOverrides(parts[0].data).text).not.toContain('Action 3');
    expect(videoSplitTextOverrides(parts[1].data).text).toContain('Action 3');
    expect(videoSplitTextOverrides(parts[1].data).text).not.toContain('Action 1');
  });
  it('rejects a shot above the limit without any graph mutations', () => {
    const video = source(); video.data.prompt = prompt([16, 4]);
    store().setCanvasData([video], []);
    const before = store();
    expect(() => store().splitVideoNodeByPrompt('source')).toThrow('shotTooLong');
    expect(store()).toBe(before);
  });
  it('starts outside a parent group using absolute row coordinates', () => {
    const group = node('group', 'groupNode', {}, 1000, 500); group.width = 1200; group.height = 700;
    const video = source(); video.parentId = 'group'; video.position = { x: 60, y: 40 };
    store().setCanvasData([group, video], []);
    store().splitVideoNodeByPrompt('source');
    const second = store().nodes.filter(n => n.data.videoPromptSplit)[1];
    expect(second.parentId).toBeUndefined();
    expect(second.position).toEqual({ x: 2248, y: 540 });
    expect(store().nodes.find(n => n.id === 'group')?.width).toBe(1200);
  });
});
