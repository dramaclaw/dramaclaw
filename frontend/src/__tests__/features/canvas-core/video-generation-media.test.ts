// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';
import i18next from 'i18next';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type { ModelOption } from '@/features/canvas/domain/modelOptions';
import { buildVideoGenerationRequest, videoPromptCompileInput, videoReferenceDurationProbe, videoEditImageOverflow, type VideoGenerationRequestContext } from '@/features/canvas/application/generationRequests/videoGenerationRequest';
import { checkCapture, captureKeys, type VideoFixture } from './videoGenerationTestKit';

const t = (key: string, options?: Record<string, unknown>) => String(i18next.t(key, options));
const catalog: ModelOption[] = [{
  id: 'video-model', providerId: 'seedance', apiModel: 'seedance-2.0', label: 'Video',
  catalogId: 'catalog-video', humanReview: true,
  supportedModes: ['text_to_video', 'first_frame', 'image_to_video', 'image_reference', 'video_edit', 'video_extend', 'all_reference'],
  referenceFileMax: 1, referenceLinkMax: 1,
}];
function videoNode(data: Record<string, unknown> = {}): CanvasNode {
  return { id: 'vid-1', type: CANVAS_NODE_TYPES.video, position: { x: 0, y: 0 }, data: {
    prompt: 'A cat jumps', model: 'video-model', genMode: 'textToVideo', aspectRatio: '16:9',
    quality: '720p', durationSec: 5, count: 1, generateAudio: false, isGenerating: false, ...data,
  } };
}
function source(id: string, data: Record<string, unknown>, type: CanvasNode['type'] = CANVAS_NODE_TYPES.upload): CanvasNode {
  return { id, type, position: { x: 0, y: 0 }, data };
}
const imageA = source('a', { imageUrl: 'https://media.example.test/a.png?version=1' });
function sources(...nodes: CanvasNode[]): Pick<VideoGenerationRequestContext, 'nodes' | 'edges'> {
  return { nodes, edges: nodes.map((node) => ({ id: node.id, source: node.id, target: 'vid-1' })) };
}
type Fixture = VideoGenerationRequestContext & { name: string };
function fixture(name: string, data: Record<string, unknown> = {}, overrides: Partial<VideoGenerationRequestContext> = {},
  extra: Partial<Fixture> = {}): Fixture {
  return { name, nodes: [videoNode(data), ...(overrides.nodes ?? [])], edges: [], nodeId: 'vid-1',
    projectId: `video-parity/${name}`, canvasId: 'canvas-7', videoModels: catalog, cameraTemplates: null, translate: (key, options) => String(i18next.t(key, options)),
    executionSource: 'workflow', productOperation: null, ...overrides,
    // Source overrides contain only sources; retain the target.
    ...(overrides.nodes ? { nodes: [videoNode(data), ...overrides.nodes] } : {}), ...extra };
}
const video = source('video', { videoUrl: '/static/source.mp4', durationMs: 10000 }, CANVAS_NODE_TYPES.video);
const audio = (id: string, data: Record<string, unknown> = {}) => source(id, { audioUrl: `/static/${id}.mp3`, durationMs: 3000, ...data }, CANVAS_NODE_TYPES.audio);
const withModel = (model: Partial<ModelOption>) => ({ videoModels: [{ ...catalog[0], ...model }] });
const durationModel = withModel({ referenceVideoMaxSeconds: 8 });
const extension = { genMode: 'allReference', isExtendMode: true, extendStartMs: 0, extendEndMs: 10000, extendSourceName: 'Source' };
const capturedFixtures: VideoFixture[] = [
  { name: 'edit source video' },
  { name: 'edit source upload video' },
  { name: 'edit first video wins', videoModels: [{ ...catalog[0], referenceVideoMax: 2 }] },
  { name: 'edit images within cap' },
  { name: 'edit audio source filename', videoModels: [{ ...catalog[0], referenceAudioMax: 3 }] },
  { name: 'edit audio display name', videoModels: [{ ...catalog[0], referenceAudioMax: 3 }] },
  { name: 'edit audio fallback label', videoModels: [{ ...catalog[0], referenceAudioMax: 3 }] },
  { name: 'edit audio cap zero normalizes before action' },
  { name: 'edit model params review' },
  { name: 'edit no source video', refusal: 'missing_source_video', forwardRefusal: { code: 'missing_source_video', phase: 'guard' } },
  { name: 'edit audio node duration wins', videoModels: [{ ...catalog[0], referenceAudioMax: 3 }], mediaDurationsMs: { '/static/music.mp3': 99999 } },
  { name: 'edit audio probe map', videoModels: [{ ...catalog[0], referenceAudioMax: 3 }], mediaDurationsMs: { '/static/music.mp3': 4000 } },
  { name: 'edit audio probe failure', videoModels: [{ ...catalog[0], referenceAudioMax: 3 }] },
  { name: 'edit audio duration rejection', rejection: { media: 'audio', kind: 'tooShort' }, videoModels: [{ ...catalog[0], referenceAudioMax: 3 }], refusal: 'reference_duration_invalid', forwardRefusal: { code: 'reference_duration_invalid', phase: 'duration' } },
  { name: 'extend source video' },
  { name: 'extend clamp params review' },
  { name: 'extend no source video', refusal: 'missing_source_video', forwardRefusal: { code: 'missing_source_video', phase: 'guard' } },
  { name: 'omni mixed edge order dependency ignored' },
  { name: 'omni per type caps', videoModels: [{ ...catalog[0], referenceImageMax: 1, referenceVideoMax: 1, referenceAudioMax: 1 }] },
  { name: 'omni over type cap silent success', videoModels: [{ ...catalog[0], referenceImageMax: 1 }], refusal: 'reference_limit_exceeded', forwardRefusal: { code: 'reference_limit_exceeded', phase: 'guard' } },
  { name: 'omni legacy total cap twelve' },
  { name: 'omni configured total cap sum exceeds twelve', videoModels: [{ ...catalog[0], referenceImageMax: 9, referenceVideoMax: 3, referenceAudioMax: 3 }] },
  { name: 'omni reference order' },
  { name: 'omni audio wire labels' },
  { name: 'omni file with name' },
  { name: 'omni link' },
  { name: 'omni file link conflict blocks before priority', refusal: 'model_capability_error', forwardRefusal: { code: 'model_capability_error', phase: 'guard' } },
  { name: 'omni no references', refusal: 'missing_references', forwardRefusal: { code: 'missing_references', phase: 'guard' } },
  { name: 'omni unsupported model normalizes before action', videoModels: [{ ...catalog[0], supportedModes: [ 'text_to_video', 'image_reference' ] }] },
  { name: 'omni audio rejection first', rejection: { media: 'audio', kind: 'tooShort' }, videoModels: [{ ...catalog[0], referenceVideoMaxSeconds: 8 }], refusal: 'reference_duration_invalid', forwardRefusal: { code: 'reference_duration_invalid', phase: 'duration' } },
  { name: 'omni video duration rejection', rejection: { media: 'video', kind: 'tooLong' }, videoModels: [{ ...catalog[0], referenceVideoMaxSeconds: 8 }], refusal: 'reference_duration_invalid', forwardRefusal: { code: 'reference_duration_invalid', phase: 'duration' } },
  { name: 'omni video duration probe', videoModels: [{ ...catalog[0], referenceVideoMaxSeconds: 8 }], mediaDurationsMs: { '/static/probe.mp4': 7000 } },
  { name: 'omni video probe failure skips total minimum', videoModels: [{ ...catalog[0], referenceVideoTotalMinSeconds: 20 }] },
  { name: 'omni audio too long', rejection: { media: 'audio', kind: 'tooLong' }, refusal: 'reference_duration_invalid', forwardRefusal: { code: 'reference_duration_invalid', phase: 'duration' } },
  { name: 'omni audio total too long', rejection: { media: 'audio', kind: 'totalTooLong' }, refusal: 'reference_duration_invalid', forwardRefusal: { code: 'reference_duration_invalid', phase: 'duration' } },
  { name: 'omni audio total too short', rejection: { media: 'audio', kind: 'totalTooShort' }, videoModels: [{ ...catalog[0], referenceAudioTotalMinSeconds: 5 }], refusal: 'reference_duration_invalid', forwardRefusal: { code: 'reference_duration_invalid', phase: 'duration' } },
  { name: 'omni video too short', rejection: { media: 'video', kind: 'tooShort' }, videoModels: [{ ...catalog[0], referenceVideoMinSeconds: 11 }], refusal: 'reference_duration_invalid', forwardRefusal: { code: 'reference_duration_invalid', phase: 'duration' } },
  { name: 'omni video total too short', rejection: { media: 'video', kind: 'totalTooShort' }, videoModels: [{ ...catalog[0], referenceVideoTotalMinSeconds: 11 }], refusal: 'reference_duration_invalid', forwardRefusal: { code: 'reference_duration_invalid', phase: 'duration' } },
  { name: 'omni video total too long', rejection: { media: 'video', kind: 'totalTooLong' }, videoModels: [{ ...catalog[0], referenceVideoTotalMaxSeconds: 15 }], refusal: 'reference_duration_invalid', forwardRefusal: { code: 'reference_duration_invalid', phase: 'duration' } },
  { name: 'omni configured audio limits override family', videoModels: [{ ...catalog[0], referenceAudioMaxSeconds: 30, referenceAudioTotalMaxSeconds: 30 }] },
  { name: 'omni other model has no audio fallback', videoModels: [{ ...catalog[0], apiModel: 'custom-video' }] },
  { name: 'omni source classification video before audio and image' },
  { name: 'omni file only' },
  { name: 'omni file unsupported silent success', videoModels: [{ ...catalog[0], referenceFileMax: 0 }], refusal: 'model_capability_error', forwardRefusal: { code: 'model_capability_error', phase: 'guard' } },
  { name: 'omni file type unsupported silent success', videoModels: [{ ...catalog[0], referenceFileTypes: [ 'txt' ] }], refusal: 'model_capability_error', forwardRefusal: { code: 'model_capability_error', phase: 'guard' } },
  { name: 'omni link unsupported silent success', videoModels: [{ ...catalog[0], referenceLinkMax: 0 }], refusal: 'model_capability_error', forwardRefusal: { code: 'model_capability_error', phase: 'guard' } },
  { name: 'omni count three' },
  { name: 'extension full range timecodes' },
  { name: 'extension partial known duration', videoModels: [{ ...catalog[0], referenceVideoMaxSeconds: 8 }], trim: { url: '/static/prepared.mp4', durationMs: 5000 } },
  { name: 'extension partial unknown duration', trim: { url: '/static/prepared.mp4', durationMs: 5000 } },
  { name: 'extension probe duration does not determine trim', mediaDurationsMs: { '/static/unknown.mp4': 10000 }, trim: { url: '/static/prepared.mp4', durationMs: 10000 } },
  { name: 'extension reference order selects trim source', trim: { url: '/static/prepared.mp4', durationMs: 5000 } },
  { name: 'extension prefix satisfies prompt guard' },
  { name: 'extension default source name' },
  { name: 'extension prepared duration validated', rejection: { media: 'video', kind: 'tooLong' }, videoModels: [{ ...catalog[0], referenceVideoMaxSeconds: 8 }], trim: { url: '/static/prepared.mp4', durationMs: 9000 }, refusal: 'reference_duration_invalid', forwardRefusal: { code: 'reference_duration_invalid', phase: 'duration' } },
  { name: 'upscale valid resolution bypasses model and busy', videoModels: [] },
  { name: 'upscale invalid resolution fallback' },
  { name: 'upscale strips query' },
  { name: 'upscale missing source published error', refusal: 'missing_upscale_source', forwardRefusal: { code: 'missing_upscale_source', phase: 'guard' } },
  { name: 'upscale missing project silent success', projectId: '', refusal: 'no_project', forwardRefusal: { code: 'no_project', phase: 'guard' } },
  { name: 'upscale product attempt', productOperation: { projectId: 'p', operationId: 'op', generationAttemptId: 'attempt' } },
  { name: 'upscale product without attempt', productOperation: { projectId: 'p', operationId: 'op' } },
  { name: 'inline omni image browser forwards', refusal: 'inline_media_reference' },
  { name: 'inline omni video browser forwards', refusal: 'inline_media_reference' },
  { name: 'inline omni audio browser forwards', refusal: 'inline_media_reference' },
  { name: 'inline edit image browser forwards', videoModels: [{ ...catalog[0], referenceAudioMax: 3 }], refusal: 'inline_media_reference' },
  { name: 'inline edit video browser forwards', videoModels: [{ ...catalog[0], referenceAudioMax: 3 }], refusal: 'inline_media_reference' },
  { name: 'inline edit audio browser forwards', videoModels: [{ ...catalog[0], referenceAudioMax: 3 }], refusal: 'inline_media_reference' },
  { name: 'inline extend video browser forwards', refusal: 'inline_media_reference' },
  { name: 'inline file browser forwards', refusal: 'inline_media_reference' },
  { name: 'inline link browser blocks', refusal: 'model_capability_error', forwardRefusal: { code: 'model_capability_error', phase: 'guard' } },
  { name: 'inline upscale browser forwards', refusal: 'inline_media_reference' },
  { name: 'inline prepared clip browser forwards', trim: { url: 'data:video/mp4;base64,AA==', durationMs: 5000 }, refusal: 'inline_media_reference' },
];
describe('video media recorded behaviour', () => {
  it('covers exactly the recorded fixtures', () => {
    expect(captureKeys('media').sort()).toStrictEqual(capturedFixtures.map(item => item.name).sort());
  });
  it.each(capturedFixtures)('$name', item => checkCapture('media', item, catalog, t));
});
describe('pure media preparation boundaries', () => {
  const partial = () => fixture('pure partial', { ...extension, extendStartMs: 2000, extendEndMs: 7000 }, sources(video));
  it('trim clip missing', () => expect(buildVideoGenerationRequest({ ...partial(), prompt: 'Continue' })).toMatchObject({ ok: false, code: 'extend_clip_not_prepared' }));
  it.each([
    { sourceUrl: '/static/other.mp4' }, { startMs: 1000 }, { endMs: 8000 },
  ])('trim clip mismatch %j', (override) => {
    expect(buildVideoGenerationRequest({ ...partial(), prompt: 'Continue', preparedExtendClip: { sourceUrl: '/static/source.mp4', startMs: 2000, endMs: 7000, url: '/static/prepared.mp4', durationMs: 5000, ...override } })).toMatchObject({ ok: false, code: 'extend_clip_not_prepared' });
  });
  it('unsupported omni boundary', () => {
    const ctx = fixture('unsupported', { genMode: 'allReference' }, { ...sources(imageA), ...withModel({ supportedModes: ['text_to_video', 'image_reference'] }) });
    expect(buildVideoGenerationRequest({ ...ctx, prompt: 'Test' })).toMatchObject({ ok: false, code: 'mode_unsupported_by_model' });
  });
  it('edit zero audio cap guard', () => {
    const ctx = fixture('pure zero audio', { genMode: 'videoEdit' }, sources(video, audio('music')));
    expect(buildVideoGenerationRequest({ ...ctx, prompt: 'Test' })).toMatchObject({ ok: false, code: 'reference_limit_exceeded' });
  });
  it('extension requires translator', () => expect(() => videoPromptCompileInput({ ...partial(), translate: undefined })).toThrow(/translat/i));
  it('inputs not mutated and request bodies independent', () => {
    const ctx = fixture('pure count', { genMode: 'allReference', count: 3 }, sources(imageA, video, audio('music')));
    const before = structuredClone({ ...ctx, translate: undefined });
    videoPromptCompileInput(ctx);
    const result = buildVideoGenerationRequest({ ...ctx, prompt: 'Test' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.requests[0].body).not.toBe(result.requests[1].body);
    expect(result.requests[0].body.references).not.toBe(result.requests[1].body.references);
    result.requests[0].body.prompt = 'Changed';
    expect(result.requests[1].body.prompt).toBe('Test');
    expect({ ...ctx, translate: undefined }).toStrictEqual(before);
  });
});

describe('edit overflow and staged duration probes', () => {
  const images = Array.from({ length: 6 }, (_, i) => source(`image-${i}`, { imageUrl: `/image-${i}.png` }));
  it('edit overflow at default cap', () => expect(videoEditImageOverflow(fixture('over', { genMode: 'videoEdit' }, sources(video, ...images)))).toStrictEqual({ limit: 5, ignored: 1 }));
  it('edit at cap', () => expect(videoEditImageOverflow(fixture('at', { genMode: 'videoEdit' }, sources(video, ...images.slice(0, 5))))).toBeNull());
  it('catalog cap counts source images only', () => expect(videoEditImageOverflow(fixture('catalog', { genMode: 'videoEdit' }, { ...sources(video, ...images, source('preview', { previewImageUrl: '/preview.png' })), ...withModel({ referenceImageMax: 2 }) }))).toStrictEqual({ limit: 2, ignored: 4 }));
  it('non edit or no model', () => {
    expect(videoEditImageOverflow(fixture('other'))).toBeNull();
    expect(videoEditImageOverflow(fixture('no model', { genMode: 'videoEdit' }, { videoModels: [] }))).toBeNull();
  });
  const unknownAudio = audio('probe', { durationMs: null });
  const unknownVideo = source('probe-video', { videoUrl: '/probe.mp4' });
  const omni = () => fixture('probe', { genMode: 'allReference' }, { ...sources(unknownVideo, unknownAudio), ...durationModel });
  it('edit audio only', () => expect(videoReferenceDurationProbe(fixture('edit', { genMode: 'videoEdit' }, { ...sources(unknownVideo, unknownAudio), ...withModel({ referenceAudioMax: 1, referenceVideoMaxSeconds: 8 }) }))).toStrictEqual({ media: 'audio', urls: ['/static/probe.mp3'] }));
  it('omni audio before video', () => {
    expect(videoReferenceDurationProbe(omni())).toStrictEqual({ media: 'audio', urls: ['/static/probe.mp3'] });
    expect(videoReferenceDurationProbe({ ...omni(), mediaDurationsMs: { '/static/probe.mp3': 3000 } })).toStrictEqual({ media: 'video', urls: ['/probe.mp4'] });
  });
  it('no video probe after audio rejection', () => expect(videoReferenceDurationProbe({ ...omni(), mediaDurationsMs: { '/static/probe.mp3': 1000 } })).toBeNull());
  it('prepared clip not probed', () => expect(videoReferenceDurationProbe(fixture('prepared', { ...extension, extendStartMs: 2000, extendEndMs: 7000 }, { ...sources(unknownVideo), ...durationModel, preparedExtendClip: { sourceUrl: '/probe.mp4', startMs: 2000, endMs: 7000, url: '/prepared.mp4', durationMs: 5000 } }))).toBeNull());
  it('positive stored duration not probed', () => expect(videoReferenceDurationProbe(fixture('known', { genMode: 'allReference' }, sources(audio('known'))))).toBeNull());
  it('null records failed probe and advances', () => expect(videoReferenceDurationProbe({ ...omni(), mediaDurationsMs: { '/static/probe.mp3': null } })).toStrictEqual({ media: 'video', urls: ['/probe.mp4'] }));
  it('model without limits not probed', () => expect(videoReferenceDurationProbe(fixture('no limits', { genMode: 'allReference' }, { ...sources(unknownAudio, unknownVideo), ...withModel({ apiModel: 'custom-video' }) }))).toBeNull());
});
