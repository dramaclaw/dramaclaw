import { afterEach, expect, it } from 'vitest';
import { reconcileDraftWithUpstream } from '@/features/canvas/compose/VideoComposeModal';
import { buildComposePayload, type ComposeTimelineState } from '@/features/canvas/compose/timelineModel';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

function music(id: string): CanvasNode {
  return { id, type: CANVAS_NODE_TYPES.audio, position: { x: 0, y: 0 }, data: {
    audioUrl: `/${id}.wav`, durationMs: 10000, audioKind: 'music',
    workflowPlanNodeId: 'bgm', workflowCatalog: { timelineRole: 'background_music' },
  } };
}
function draft(): ComposeTimelineState {
  return { resolution: '1080p', tracks: [{ id: 'music', kind: 'audio', clips: [{
    id: 'clip', nodeId: 'bgm', kind: 'audio', sourceUrl: '', displayName: null, thumbUrl: null,
    durationMs: null, timelineStartMs: 0, trimStartMs: 0, trimEndMs: 8000,
    volume: .7, muted: false, speed: 1, fadeOutMs: 2000,
  }] }] };
}
afterEach(() => useCanvasStore.getState().setCanvasData([], []));
it('binds a connected plan reference and preserves its mix on reload', () => {
  useCanvasStore.getState().setCanvasData([music('actual'), music('unconnected')], []);
  const resolved = reconcileDraftWithUpstream(draft(), ['actual']);
  const clip = resolved.tracks[0].clips[0];
  expect(clip).toMatchObject({ nodeId: 'actual', sourceUrl: '/actual.wav', volume: .7, trimEndMs: 8000, fadeOutMs: 2000 });
  const reloaded = reconcileDraftWithUpstream(JSON.parse(JSON.stringify(resolved)), ['actual']);
  expect(buildComposePayload(reloaded).tracks[0].items[0]).toMatchObject({ volume: .7, timelineStart: 0, sourceEnd: 8, fadeOut: 2 });
  const regenerated = music('actual');
  regenerated.data.audioUrl = '/regenerated.wav';
  useCanvasStore.getState().setCanvasData([regenerated], []);
  const rebound = reconcileDraftWithUpstream(reloaded, ['actual']);
  expect(buildComposePayload(rebound).tracks[0].items[0]).toMatchObject({ sourceUrl: '/regenerated.wav', volume: .7, fadeOut: 2 });
});
it('rejects missing and ambiguous planned references instead of defaulting', () => {
  useCanvasStore.getState().setCanvasData([music('one'), music('two')], []);
  expect(() => reconcileDraftWithUpstream(draft(), [])).toThrow();
  expect(() => reconcileDraftWithUpstream(draft(), ['one', 'two'])).toThrow();
});
