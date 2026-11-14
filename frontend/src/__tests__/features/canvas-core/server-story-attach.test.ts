// SPDX-License-Identifier: Elastic-2.0
import { beforeEach, expect, it } from 'vitest';
import i18next from 'i18next';
import en from '../../../../public/locales/en/translation.json';
import { useCanvasStore } from '@/stores/canvasStore';
import { attachCompletedStoryFrame, attachCompletedStoryAsset, syncStoryVideoReferencePrompt } from '@/features/canvas/application/videoContinuity';
import { serveStoryAttach } from '@/features/canvas/server/storyAttach';
import { InvalidRequest } from '@/features/canvas/server/requestPayload';
import type { CanvasNode, CanvasEdge } from '@/features/canvas/domain/canvasNodes';

function canvas() {
  const node = (id: string, type: CanvasNode['type'], data: CanvasNode['data'], parentId?: string): CanvasNode =>
    ({ id, type, position: { x: 0, y: 0 }, data, ...(parentId ? { parentId } : {}) });
  return { nodes: [
    node('group', 'groupNode', { storyGroup: true, interactiveStoryId: 'story', storyCharacters: [{ id: 'hero' }] }),
    node('video', 'videoNode', { storySegmentId: 'segment', continuityMode: 'independent', prompt: 'A shot', storyCharacterIds: ['hero'] }, 'group'),
    node('frame', 'imageGenNode', { imageUrl: '/static/frame.png', storyFrameTarget: { storyId: 'story', segmentId: 'segment', videoNodeId: 'video', referenceNodeIds: ['ref'] } }),
    node('ref', 'imageGenNode', { imageUrl: '/static/ref.png' }),
    node('asset', 'imageGenNode', { imageUrl: '/static/asset.png', storyAssetTarget: { storyId: 'story', kind: 'subject', entityId: 'hero', segmentIds: ['segment'] } }),
  ], edges: [] as CanvasEdge[] };
}
const comparable = (edges: CanvasEdge[]) => edges.map(({ source, target, data }) => ({ source, target, data }));
beforeEach(async () => { await i18next.init({ lng: 'en', resources: { en: { translation: en } }, initAsync: false }); });

it('attaches the same frame, reference, asset and prompt as browser wrappers, then replays without changes', async () => {
  const input = canvas();
  useCanvasStore.getState().setCanvasData(structuredClone(input.nodes), []);
  for (const id of ['frame', 'asset']) {
    expect(attachCompletedStoryFrame(id)).toBeNull();
    expect(attachCompletedStoryAsset(id)).toBeNull();
    for (const edge of useCanvasStore.getState().edges.filter(edge => edge.source === id)) syncStoryVideoReferencePrompt(edge.target);
  }
  const browser = useCanvasStore.getState();
  const result = await serveStoryAttach({ canvas: input, image_node_ids: ['frame', 'asset'], env: { locale: 'en' } });
  expect(result.ok).toBe(true);
  expect(result.warnings).toEqual([]);
  expect(comparable(result.edges)).toEqual(comparable(browser.edges));
  expect(result.edges.map(edge => [edge.source, edge.target, edge.data?.edgeKind, edge.data?.link_type])).toEqual([
    ['ref', 'video', 'story_visual_reference', 'media_input_for'],
    ['frame', 'video', 'story_frame_reference', 'media_input_for'],
    ['asset', 'video', 'story_visual_reference', 'media_input_for'],
  ]);
  expect(result.node_patches).toEqual([{ node_id: 'video', patch: {
    prompt: browser.nodes.find(node => node.id === 'video')?.data.prompt,
    storyReferenceSignature: browser.nodes.find(node => node.id === 'video')?.data.storyReferenceSignature,
  } }]);
  for (const { node_id, patch } of result.node_patches) Object.assign(input.nodes.find(node => node.id === node_id)!.data, patch);
  input.edges.push(...result.edges);
  expect(await serveStoryAttach({ canvas: input, image_node_ids: ['frame', 'asset'], env: { locale: 'en' } })).toEqual({ ok: true, edges: [], node_patches: [], warnings: [] });
});
it('warns when the original segment changed', async () => {
  const input = canvas();
  input.nodes.find(node => node.id === 'video')!.data.storySegmentId = 'changed';
  const result = await serveStoryAttach({ canvas: input, image_node_ids: ['frame'], env: { locale: 'en' } });
  expect(result.edges).toEqual([]);
  expect(result.warnings).toEqual([i18next.t('canvas.story.messages.storyboardTargetChanged')]);
});
it('reserves auto continuity for its tail frame', async () => {
  const input = canvas();
  input.nodes.find(node => node.id === 'video')!.data.continuityMode = 'auto';
  const result = await serveStoryAttach({ canvas: input, image_node_ids: ['frame'] });
  expect(result.edges.map(edge => edge.source)).toEqual(['ref']);
});
it('applies the reference limit of the video model in the given catalog', async () => {
  const input = canvas();
  input.nodes.find(node => node.id === 'video')!.data.model = 'two-images';
  const catalogs = { video: [{ id: 'two-images', providerId: 'newapi', apiModel: 'two-images',
    label: 'Two images', referenceImageMax: 2 }] };
  const limited = await serveStoryAttach({ canvas: input, image_node_ids: ['frame', 'asset'], env: { locale: 'en', catalogs } });
  expect(limited.edges.map(edge => edge.source)).toEqual(['ref', 'frame']);
  expect(limited.warnings).toEqual([i18next.t('canvas.story.messages.referenceLimit', { segmentId: 'segment' })]);
  const fallback = await serveStoryAttach({ canvas: input, image_node_ids: ['frame', 'asset'], env: { locale: 'en' } });
  expect(fallback.edges.map(edge => edge.source)).toEqual(['ref', 'frame', 'asset']);
});
it.each([null, {}, { canvas: canvas(), image_node_ids: [1] }, { canvas: canvas(), image_node_ids: 'frame' },
  { canvas: canvas(), image_node_ids: [], env: { locale: 1 } }, { canvas: canvas(), image_node_ids: [], env: { catalogs: [] } },
  { canvas: { nodes: [{}], edges: [] }, image_node_ids: [] }])('rejects invalid payload %#', async payload => {
  await expect(serveStoryAttach(payload)).rejects.toBeInstanceOf(InvalidRequest);
});
