// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type { ModelOption } from '@/features/canvas/domain/modelOptions';
import { buildVideoGenerationRequest, videoPromptCompileInput, videoUpscaleInput, videoUpscaleWireRequest, videoContinuityCompileInput, type VideoGenerationRequestContext } from '@/features/canvas/application/generationRequests/videoGenerationRequest';
import { checkCapture, captureKeys, type VideoFixture } from './videoGenerationTestKit';

const t = (key: string, fallback?: unknown) => typeof fallback === 'string' ? fallback : key;
const catalog: ModelOption[] = [{
  id: 'video-model', providerId: 'seedance', apiModel: 'seedance-2.0', label: 'Video', catalogId: 'catalog-video', humanReview: true,
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
const imageB = source('b', { imageUrl: 'https://media.example.test/b.png?version=2' });
function sources(...nodes: CanvasNode[]): Pick<VideoGenerationRequestContext, 'nodes' | 'edges'> {
  return { nodes, edges: nodes.map((node) => ({ id: node.id, source: node.id, target: 'vid-1' })) };
}
type Fixture = VideoGenerationRequestContext & { name: string };
function fixture(name: string, data: Record<string, unknown> = {}, overrides: Partial<VideoGenerationRequestContext> = {},
  extra: Partial<Fixture> = {}): Fixture {
  return { name, nodes: [videoNode(data), ...(overrides.nodes ?? [])], edges: [], nodeId: 'vid-1',
    projectId: `video-parity/${name}`, canvasId: 'canvas-7', videoModels: catalog, cameraTemplates: null,
    executionSource: 'workflow', productOperation: null, ...overrides,
    // Source overrides contain only sources; retain the target.
    ...(overrides.nodes ? { nodes: [videoNode(data), ...overrides.nodes] } : {}), ...extra };
}
const capturedFixtures: VideoFixture[] = [
  { name: 'fresh text-to-video default' },
  { name: 'unknown model fallback' },
  { name: 'missing model fallback' },
  { name: 'catalog identity selection', videoModels: [catalog[0], { ...catalog[0], id: 'second', catalogId: 'catalog-second' }] },
  { name: 'catalog ratio resolution duration clamp', videoModels: [{ ...catalog[0], ratioOptions: [ ' 1:1 ', '16:9' ], resolutionOptions: [ ' 1080P ', '720p' ], minDuration: 3, maxDuration: 8 }] },
  { name: 'fallback ratio snapping duration rounding' },
  { name: 'duration lower clamp quality fallback' },
  { name: 'auto ratio from dimensions' },
  { name: 'auto ratio without dimensions' },
  { name: 'catalog auto ratio', videoModels: [{ ...catalog[0], ratioOptions: [ 'auto', '1:1' ] }] },
  { name: 'generate audio on' },
  { name: 'generate audio off' },
  { name: 'generate audio missing defaults on' },
  { name: 'generate audio unsupported', videoModels: [{ ...catalog[0], supportsGenerateAudio: false }] },
  { name: 'human review ignored for text' },
  { name: 'scene optimize catalog', videoModels: [{ ...catalog[0], sceneOptimizeOptions: [ 'anime', 'realistic' ] }] },
  { name: 'scene optimize fallback preset', videoModels: [{ ...catalog[0], apiModel: 'newapi_seedance-2.0-fast-value' }] },
  { name: 'scene optimize unsupported omitted' },
  { name: 'camera catalog template', cameraTemplates: [ { id: 'custom', label: 'Custom', promptFragment: 'Slow pan', videoUrl: null } ] },
  { name: 'camera fallback preset' },
  { name: 'camera fragment precedes ordered upstream text', cameraTemplates: [ { id: 'custom', label: 'Custom', promptFragment: 'Slow pan', videoUrl: null } ] },
  { name: 'unknown camera id retained' },
  { name: 'model params' },
  { name: 'product operation with attempt', productOperation: { projectId: 'p', operationId: 'op-1', generationAttemptId: 'attempt-1' } },
  { name: 'product operation without attempt', productOperation: { projectId: 'p', operationId: 'op-1' } },
  { name: 'count three' },
  { name: 'count upper clamp' },
  { name: 'count lower clamp' },
  { name: 'single action still completes', executionMode: 'single' },
  { name: 'upstream text edge order dependency ignored' },
  { name: 'first frame query preserved' },
  { name: 'first last keyframe slots' },
  { name: 'image to video reference cap slicing', videoModels: [{ ...catalog[0], referenceImageMax: 9 }] },
  { name: 'image reference manual order' },
  { name: 'human review supported' },
  { name: 'human review unsupported', videoModels: [{ ...catalog[0], humanReview: false }] },
  { name: 'legacy model alias selection' },
  { name: 'model without catalog id uses id', videoModels: [{ ...catalog[0], catalogId: undefined }] },
  { name: 'scene optimize invalid uses catalog default', videoModels: [{ ...catalog[0], sceneOptimizeOptions: [ 'anime' ], defaultSceneOptimize: 'realistic' }] },
  { name: 'scene optimize value default anime', videoModels: [{ ...catalog[0], apiModel: 'huimeng_seedance-2.0-value' }] },
  { name: 'quality first option fallback invalid bounds', videoModels: [{ ...catalog[0], resolutionOptions: [ ' 4K ', '2K' ], minDuration: -1, maxDuration: -2 }] },
  { name: 'blank catalog options use defaults', videoModels: [{ ...catalog[0], ratioOptions: [ ' ' ], resolutionOptions: [ ' ' ] }] },
  { name: 'dependency image ignored' },
  { name: 'story choice image ignored' },
  { name: 'first last edge order fallback' },
  { name: 'last keyframe only' },
  { name: 'image references retain duplicates' },
  { name: 'image submission prefers source over preview' },
  { name: 'image generation reference fallback' },
  { name: 'text upstream satisfies required prompt' },
  { name: 'no model refusal', videoModels: [], refusal: 'no_model', forwardRefusal: { code: 'no_model', phase: 'guard' } },
  { name: 'ambiguous model alias refusal', videoModels: [catalog[0], { ...catalog[0], id: 'other', catalogId: 'other' }], refusal: 'no_model', forwardRefusal: { code: 'no_model', phase: 'guard' } },
  { name: 'camera only does not satisfy prompt guard', refusal: 'no_effective_prompt', forwardRefusal: { code: 'no_effective_prompt', phase: 'guard' } },
  { name: 'model capability refusal', videoModels: [{ ...catalog[0], apiModel: 'seedance-1.5-pro' }], refusal: 'model_capability_error', forwardRefusal: { code: 'model_capability_error', phase: 'guard' } },
  { name: 'video reference capability refusal', videoModels: [{ ...catalog[0], apiModel: 'custom', supportedModes: [ 'image_reference', 'text_to_video' ] }], refusal: 'model_capability_error', forwardRefusal: { code: 'model_capability_error', phase: 'guard' } },
  { name: 'generation in progress refusal', refusal: 'generation_in_progress', forwardRefusal: { code: 'generation_in_progress', phase: 'guard' } },
  { name: 'compiled empty prompt preserved', compiledPrompt: '' },
  { name: 'compiled recipe with metadata', metadata: { mode: 'model', prompt: 'Recipe compiled video', recipeIds: [ 'recipe-1' ] } },
  { name: 'no prompt refusal', refusal: 'no_effective_prompt', forwardRefusal: { code: 'no_effective_prompt', phase: 'guard' } },
  { name: 'no media refusal', refusal: 'missing_media', forwardRefusal: { code: 'missing_media', phase: 'guard' } },
  { name: 'over cap refusal', videoModels: [{ ...catalog[0], referenceImageMax: 1 }], refusal: 'reference_limit_exceeded', forwardRefusal: { code: 'reference_limit_exceeded', phase: 'guard' } },
  { name: 'inline preview reference refusal', refusal: 'inline_media_reference', forwardRefusal: { code: 'missing_media', phase: 'images' } },
  { name: 'inline source forwarded by browser', refusal: 'inline_media_reference' },
  { name: 'first frame last slot refusal', refusal: 'missing_media', forwardRefusal: { code: 'missing_media', phase: 'keyframes' } },
  { name: 'preview without source refusal', refusal: 'missing_media', forwardRefusal: { code: 'missing_media', phase: 'images' } },
];
describe('video request recorded behaviour', () => {
  it('covers exactly the recorded fixtures', () => {
    expect(captureKeys('request').sort()).toStrictEqual(capturedFixtures.map(item => item.name).sort());
  });
  it.each(capturedFixtures)('$name', item => checkCapture('request', item, catalog, t));
});
describe('pure video request boundaries', () => {
  it('wrong node type', () => {
    const ctx = { ...fixture('boundary'), nodes: [imageA], nodeId: imageA.id };
    expect(buildVideoGenerationRequest({ ...ctx, prompt: 'Test' })).toMatchObject({ ok: false, code: 'not_video_node' });
    expect(() => videoPromptCompileInput(ctx)).toThrow();
  });
  it('no model', () => expect(buildVideoGenerationRequest({ ...fixture('boundary'), videoModels: [], prompt: 'Test' })).toMatchObject({ ok: false, code: 'no_model' }));
  it.each([
    ['videoEdit', 'missing_source_video'], ['videoExtend', 'missing_source_video'], ['allReference', 'missing_references'],
  ])('%s without media references', (genMode, code) => {
    expect(buildVideoGenerationRequest({ ...fixture('no media', { genMode }), prompt: 'Test' })).toMatchObject({ ok: false, code });
  });
  it('upscale without source', () => expect(buildVideoGenerationRequest({ ...fixture('upscale', { isUpscaleNode: true }), prompt: 'Test' })).toMatchObject({ ok: false, code: 'missing_upscale_source' }));
  it('inline source reference requires upload', () => expect(buildVideoGenerationRequest({ ...fixture('inline', { genMode: 'imageReference' }, sources(source('inline', { imageUrl: 'data:image/png;base64,AA==' }))), prompt: 'Test' })).toMatchObject({ ok: false, code: 'inline_media_reference' }));
  it('resolved task activity overrides node flag', () => {
    expect(buildVideoGenerationRequest({ ...fixture('boundary'), isGenerating: true, prompt: 'Test' })).toMatchObject({ ok: false, code: 'generation_in_progress' });
    expect(buildVideoGenerationRequest({ ...fixture('stale flag', { isGenerating: true }), isGenerating: false, prompt: 'Test' }).ok).toBe(true);
  });
  it('missing project', () => expect(buildVideoGenerationRequest({ ...fixture('boundary'), projectId: '', prompt: 'Test' })).toMatchObject({ ok: false, code: 'no_project' }));
  it('single image cap cannot be overridden by catalog', () => expect(buildVideoGenerationRequest({
    ...fixture('structural cap', { genMode: 'imageToVideo' }, { ...sources(imageA, imageB), videoModels: [{ ...catalog[0], referenceImageMax: 9 }] }), prompt: 'Test',
  })).toMatchObject({ ok: false, code: 'reference_limit_exceeded' }));
  it('manual execution still makes separate count submissions', () => {
    const ctx = { ...fixture('manual', { count: 3 }), executionSource: 'manual' as const, prompt: 'Test' };
    const result = buildVideoGenerationRequest(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.requests).toHaveLength(3);
    expect(result.requests[0].body).not.toHaveProperty('variant_count');
  });
  it('inputs not mutated', () => {
    const ctx = structuredClone(fixture('order', { genMode: 'imageReference', referenceOrder: ['b', 'a'] }, sources(imageA, imageB)));
    const before = structuredClone(ctx);
    videoPromptCompileInput(ctx); buildVideoGenerationRequest({ ...ctx, prompt: 'Test' });
    expect(ctx).toStrictEqual(before);
  });
});

describe('video submission helpers', () => {
  it.each([
    [{ upscaleSourceUrl: '/v.mp4', upscaleResolution: '2k' }, { sourceUrl: '/v.mp4', resolution: '2k' }],
    [{ upscaleSourceUrl: 7, upscaleResolution: 'unknown' }, { sourceUrl: '', resolution: '1080p' }],
    [{}, { sourceUrl: '', resolution: '1080p' }],
  ])('normalizes upscale input %j', (data, expected) => {
    expect(videoUpscaleInput(data)).toStrictEqual(expected);
  });
  it.each([true, false])('upscale wire preserves order with attempt=%s', attempt => {
    const request = videoUpscaleWireRequest({ projectId: 'project/a b', canvasId: 'canvas-1', nodeId: 'vid-1',
      sourceUrl: '/static/v.mp4?version=2', resolution: '1080p',
      productOperation: { projectId: 'p', operationId: 'op-1', ...(attempt ? { generationAttemptId: 'attempt-1' } : {}) } });
    const body = { source_url: '/static/v.mp4', resolution: '1080p', slowdown: 'auto',
      smart_interpolation: true, scene: 'realistic', face_enhance: false, canvas_id: 'canvas-1', node_id: 'vid-1',
      ...(attempt ? { product_operation_id: 'op-1', generation_attempt_id: 'attempt-1' } : {}) };
    expect(request).toStrictEqual({ method: 'POST', path: 'projects/project%2Fa%20b/freezone/video/upscale', body });
    expect(JSON.stringify(request.body)).toBe(JSON.stringify(body));
  });
  it('continuity uses live prompt and ordered upstream text with camera prefix', () => {
    const ctx = fixture('continuity', { prompt: ' Render ', cameraMovement: 'custom' }, {
      ...sources(source('t1', { content: 'First' }, CANVAS_NODE_TYPES.textAnnotation),
        source('t2', { content: 'Second' }, CANVAS_NODE_TYPES.textAnnotation)),
      cameraTemplates: [{ id: 'custom', label: 'Custom', promptFragment: 'Slow pan', videoUrl: null }],
    });
    expect(videoContinuityCompileInput(ctx, ' Live ').nodePrompt).toBe('Live');
    expect(videoContinuityCompileInput(ctx, ' Live ').upstreamText).toBe('First\n\nSecond');
    expect(videoContinuityCompileInput(ctx, ' Live ').fallbackPrompt).toBe('Slow pan，First\n\nSecond\n\nLive');
    expect(videoContinuityCompileInput(ctx, undefined).nodePrompt).toBe('Render');
    expect(videoContinuityCompileInput(ctx, undefined).fallbackPrompt).toBe('Slow pan，First\n\nSecond\n\nRender');
  });
  it('empty continuity preserves extension fallback', () => {
    const ctx = fixture('continuity', { prompt: '', genMode: 'allReference', isExtendMode: true,
      extendStartMs: 2000, extendEndMs: 7000 }, { translate: t });
    expect(videoContinuityCompileInput(ctx, '').fallbackPrompt).toBe('canvas.videoExtend.promptPrefixTrimmed');
    expect(videoContinuityCompileInput(ctx, '').fallbackPrompt).toBe(videoPromptCompileInput(ctx).fallbackPrompt);
  });
});
