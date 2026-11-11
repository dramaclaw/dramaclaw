// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';
import type { ModelOption } from '@/features/canvas/domain/modelOptions';
import { videoGenerationRefusalOutcome, videoGenerationActionResult, videoGenerationRunOutcome, videoGenerationSettleOutcome } from '@/features/canvas/application/generationRequests/videoGenerationResult';
import { describeGenerationError } from '@/features/canvas/application/generationRequests/generationSubmitError';
import { checkCapture, captureKeys, type VideoFixture } from './videoGenerationTestKit';

const t = (key: string, fallback?: unknown) => typeof fallback === 'string' ? fallback : fallback ? `${key}:${JSON.stringify(fallback)}` : key;
const startedAt = 1234567890000;
const catalog: ModelOption[] = [
  {
    id: 'video-model',
    catalogId: 'catalog-video',
    providerId: 'seedance',
    apiModel: 'seedance-2.0',
    label: 'Video',
    humanReview: true
  }
];
type Run = NonNullable<VideoFixture['runs']>[number];
const done = (result: Record<string, unknown>, fallback?: string | 'throws'): Run => ({ kind: 'completed', result, fallback });
const failed = (message: string): Run => ({ kind: 'failed', message });
const timeout: Run = { kind: 'poll_timeout' };
const cancelled: Run = { kind: 'cancelled' };
const face = 'InputImageSensitiveContentDetected.PrivateInformation';
const submitFailure = (status: number, body: unknown): Run => ({ kind: 'submit_failed', failure: {
  kind: 'http', status, statusText: 'Rejected', method: 'POST', url: 'https://canvas.example.test/api/video', body,
} });
const referenceFailure = submitFailure(422, { detail: { code: 'REFERENCE_MEDIA_INVALID', errors: [
  { media: 'image', index: 1, name: 'Reference', reference_key: 'ref.png', code: 'missing' },
] } });
const capturedFixtures: VideoFixture[] = [
  { name: 'single success output_url', runs: [done({ output_url: '/a.mp4' })] },
  { name: 'success video_url wins over output_url', runs: [done({ video_url: '/v.mp4', output_url: '/other.mp4' })] },
  { name: 'success url key', runs: [done({ url: '/u.mp4' })] },
  { name: 'job-result fallback', runs: [done({}, '/fallback.mp4')] },
  { name: 'fallback fetch fails', runs: [done({}, 'throws')] },
  { name: 'completed without URL run 0', runs: [done({})] },
  { name: 'completed without URL run 1', runs: [done({ output_url: '/a.mp4' }), done({})], order: [1, 0] },
  { name: 'run 0 no URL after sibling success', runs: [done({}), done({ url: '/b.mp4' })], order: [1, 0] },
  { name: 'three completion order 2,0,1', runs: [done({ url: '/0' }), done({ url: '/1' }), done({ url: '/2' })], order: [2, 0, 1] },
  { name: 'three completion order 0,1,2', runs: [done({ url: '/0' }), done({ url: '/1' }), done({ url: '/2' })], order: [0, 1, 2] },
  { name: 'duplicate URLs retained', runs: [done({ url: '/same' }), done({ url: '/same' })] },
  { name: 'failure after success partial toast', runs: [done({ url: '/a' }), failed('late failure')] },
  { name: 'failure before success banner cleared', runs: [done({ url: '/a' }), failed('early failure')], order: [1, 0] },
  { name: 'all fail first error by push order', runs: [failed('run zero'), failed('run one')], order: [1, 0] },
  { name: 'face blocked without human review', runs: [failed(face)] },
  { name: 'face blocked with human review', runs: [failed(face)] },
  { name: 'face blocked model without review', videoModels: [{ ...catalog[0], humanReview: false }], runs: [failed(face)] },
  { name: 'reference invalid first error', runs: [referenceFailure, failed('second failure')] },
  { name: 'reference invalid later error ordinary dialog', runs: [failed('first failure'), referenceFailure] },
  { name: 'all runs poll timeout previous URL published', runs: [timeout, timeout] },
  { name: 'poll timeout then failure', runs: [timeout, failed('failure')] },
  { name: 'failure then poll timeout', runs: [failed('failure'), timeout] },
  { name: 'timeout after success partial toast', runs: [done({ url: '/a' }), timeout] },
  { name: 'cancelled run 0 alone', runs: [cancelled] },
  { name: 'cancelled run 0 before success', runs: [cancelled, done({ url: '/b' })] },
  { name: 'cancelled run 0 after success', runs: [cancelled, done({ url: '/b' })], order: [1, 0] },
  { name: 'cancelled run 1', runs: [done({ url: '/a' }), cancelled], order: [1, 0] },
  { name: 'submit insufficient credits', runs: [submitFailure(402, { error: 'Balance too low' })] },
  { name: 'submit billing rule', runs: [submitFailure(400, { error: 'No billing rule', data: { error_code: 'BILLING_RULE_NOT_CONFIGURED' } })] },
  { name: 'submit queue limit', runs: [submitFailure(429, { error: 'Queue rejected', data: { queue_kind: 'video' } })] },
  { name: 'compile failure preserves album', compileFailure: true },
  { name: 'empty result URL falls back', runs: [done({ output_url: '' }, '/fallback')] },
  { name: 'nonstring result URLs ignored', runs: [done({ video_url: 7, output_url: false, url: null }, '/fallback')] },
  { name: 'whitespace result URL preserved', runs: [done({ output_url: ' ' })] },
  { name: 'no URL run zero then success', runs: [done({}), done({ url: '/b' })] },
  { name: 'all completed without URLs', runs: [done({}), done({})], order: [1, 0] },
  { name: 'execution single', executionMode: 'single', runs: [done({ url: '/single' })] },
  { name: 'no model refusal', videoModels: [], refusal: 'no_model', forwardRefusal: { code: 'no_model', phase: 'guard' } },
  { name: 'unsupported omni guard refusal', videoModels: [{ ...catalog[0], apiModel: 'custom-video' }], refusal: 'mode_unsupported_by_model', forwardRefusal: { code: 'mode_unsupported_by_model', phase: 'guard' } },
  { name: 'missing omni references guard refusal', refusal: 'missing_references', forwardRefusal: { code: 'missing_references', phase: 'guard' } },
  { name: 'silent refusal retains previous error', refusal: 'no_effective_prompt', forwardRefusal: { code: 'no_effective_prompt', phase: 'guard' } },
  { name: 'generation in progress refusal', refusal: 'generation_in_progress', forwardRefusal: { code: 'generation_in_progress', phase: 'guard' } },
  { name: 'no effective prompt refusal', refusal: 'no_effective_prompt', forwardRefusal: { code: 'no_effective_prompt', phase: 'guard' } },
  { name: 'no project refusal', projectId: '', refusal: 'no_project', forwardRefusal: { code: 'no_project', phase: 'guard' } },
  { name: 'missing media guard refusal', refusal: 'missing_media', forwardRefusal: { code: 'missing_media', phase: 'guard' } },
  { name: 'missing keyframe after start refusal', lastSlot: true, refusal: 'missing_media', forwardRefusal: { code: 'missing_media', phase: 'keyframes' } },
  { name: 'preview without source refusal', refusal: 'missing_media', forwardRefusal: { code: 'missing_media', phase: 'images' } },
  { name: 'reference limit refusal', videoModels: [{ ...catalog[0], referenceImageMax: 1 }], refusal: 'reference_limit_exceeded', forwardRefusal: { code: 'reference_limit_exceeded', phase: 'guard' } },
  { name: 'model capability refusal', videoModels: [{ ...catalog[0], apiModel: 'seedance-1.5-pro' }], refusal: 'model_capability_error', forwardRefusal: { code: 'model_capability_error', phase: 'guard' } },
  { name: 'inline preview missing keyframe', refusal: 'inline_media_reference', forwardRefusal: { code: 'missing_media', phase: 'keyframes' } },
  { name: 'inline preview refusal', refusal: 'inline_media_reference', forwardRefusal: { code: 'missing_media', phase: 'images' } },
  { name: 'missing edit source refusal', refusal: 'missing_source_video', forwardRefusal: { code: 'missing_source_video', phase: 'guard' } },
  { name: 'missing extend source refusal', refusal: 'missing_source_video', forwardRefusal: { code: 'missing_source_video', phase: 'guard' } },
  { name: 'missing omni references after start', refusal: 'missing_references', forwardRefusal: { code: 'missing_references', phase: 'references' } },
  { name: 'document file unsupported guard', refusal: 'model_capability_error', forwardRefusal: { code: 'model_capability_error', phase: 'guard' } },
  { name: 'document link unsupported guard', refusal: 'model_capability_error', forwardRefusal: { code: 'model_capability_error', phase: 'guard' } },
  { name: 'document file link conflict guard', refusal: 'model_capability_error', forwardRefusal: { code: 'model_capability_error', phase: 'guard' } },
  { name: 'document file type unsupported guard', videoModels: [{ ...catalog[0], referenceFileMax: 1, referenceFileTypes: ['txt'] }], refusal: 'model_capability_error', forwardRefusal: { code: 'model_capability_error', phase: 'guard' } },
  { name: 'inline link blocked guard', videoModels: [{ ...catalog[0], referenceLinkMax: 1 }], refusal: 'model_capability_error', forwardRefusal: { code: 'model_capability_error', phase: 'guard' } },
  { name: 'reference duration invalid', refusal: 'reference_duration_invalid', forwardRefusal: { code: 'reference_duration_invalid', phase: 'duration' } },
  ...([
    { name: 'upscale output_url', runs: [done({ output_url: '/hd.mp4' })] },
    { name: 'upscale fallback ignores video_url', runs: [done({ video_url: '/ignored' }, '/fallback-hd.mp4')] },
    { name: 'upscale fallback empty URL', runs: [done({})] },
    { name: 'upscale submit insufficient credits raw message', runs: [submitFailure(402, { error: 'Raw balance message' })] },
    { name: 'upscale failure publishes success', runs: [failed('raw upscale failure')] },
    { name: 'upscale fallback throws', runs: [done({}, 'throws')] },
    { name: 'upscale poll timeout', runs: [timeout] },
    { name: 'upscale no source', refusal: 'missing_upscale_source' as const, forwardRefusal: { code: 'missing_upscale_source', phase: 'guard' } },
    { name: 'upscale no project', projectId: '', refusal: 'no_project' as const, forwardRefusal: { code: 'no_project', phase: 'guard' } },
    { name: 'upscale single execution', executionMode: 'single' as const, runs: [done({ output_url: '/single-hd' })] },
  ] satisfies VideoFixture[]).map((item) => ({ ...item, upscale: true })),
];
describe('video result recorded behaviour', () => {
  it('covers exactly the recorded fixtures', () => {
    expect(captureKeys('result').sort()).toStrictEqual(capturedFixtures.map(item => item.name).sort());
  });
  it.each(capturedFixtures)('$name', item => checkCapture('result', item, catalog, t));
});
describe('pure result boundaries without a browser submission counterpart', () => {
  it.each(['not_video_node', 'extend_clip_not_prepared', 'inline_media_reference'] as const)('%s creates no synthetic writes', (code) => {
    expect(videoGenerationRefusalOutcome({ ok: false, code, message: 'Boundary refusal', phase: code === 'extend_clip_not_prepared' ? 'references' : 'guard', startedAtMs: startedAt }, t))
      .toStrictEqual({ patches: [], notice: null });
  });
  it('missing node action result', () => {
    expect(videoGenerationActionResult(undefined, 'workflow')).toStrictEqual({ status: 'success', output: {} });
  });
  it('nonstring URL omitted and empty error ignored', () => {
    expect(videoGenerationActionResult({ videoUrl: 12, generationError: '' }, 'single'))
      .toStrictEqual({ status: 'success', output: { submitted: true } });
  });
  it('run and settle do not mutate caller arrays or errors', () => {
    const input = { runIndex: 1, total: 2, completedUrls: ['/a'], outcome: { kind: 'completed' as const, result: { url: '/a' }, fallbackUrl: null } };
    const before = structuredClone(input);
    const result = videoGenerationRunOutcome(input, t);
    expect(input).toStrictEqual(before);
    expect(result.completedUrls).toStrictEqual(['/a', '/a']);
    const settle = { completedUrls: result.completedUrls, runErrors: [{ kind: 'failed' as const, error: describeGenerationError(new Error('failed'), t, 'fallback') }], total: 2, supportsHumanReview: false, humanReview: false };
    const prior = structuredClone(settle);
    videoGenerationSettleOutcome(settle, t);
    expect(settle).toStrictEqual(prior);
  });
});
