// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InvalidRequest } from '@/features/canvas/server/requestPayload';
import { serveVideoGenerationRequest, serveVideoGenerationPatch } from '@/features/canvas/server/videoGeneration';
import { materializeFixtures } from './generationFixtures';
import { invalidFields } from './generationValidationFixtures';

beforeEach(() => { vi.stubGlobal('fetch', () => { throw new Error('Network is forbidden'); }); });
afterEach(() => vi.unstubAllGlobals());
const fixtures = (await materializeFixtures()).filter(f => f.op.startsWith('video_'));
const serve = (op: string, payload: unknown) => op === 'video_generation_request' ? serveVideoGenerationRequest(payload) : serveVideoGenerationPatch(payload);
it.each(fixtures)('matches the pure result without mutation: $name', async fixture => {
  const before = structuredClone(fixture.payload);
  expect(await serve(fixture.op, fixture.payload)).toStrictEqual(await fixture.expected());
  expect(fixture.payload).toStrictEqual(before);
});
it.each(invalidFields(fixtures))('rejects invalid field: $name', async fixture => {
  await expect(serve(fixture.op, fixture.payload)).rejects.toBeInstanceOf(InvalidRequest);
});
it.each([null, [], {}, { phase: 'other' }])('rejects invalid payload %j', async payload => {
  await expect(serveVideoGenerationRequest(payload)).rejects.toBeInstanceOf(InvalidRequest);
  await expect(serveVideoGenerationPatch(payload)).rejects.toBeInstanceOf(InvalidRequest);
});

it.each(fixtures.filter(f => f.op === 'video_generation_request' && /inline|data:/.test(f.name)))('refuses inline media: $name', async fixture => {
  const result = await serveVideoGenerationRequest(fixture.payload);
  expect(result.request).toMatchObject({ ok: false, code: 'inline_media_reference' });
  expect(result.request).not.toHaveProperty('requests');
});

it.each([
  { phase: 'failure', error: { name: 'Error', message: '' } },
  { phase: 'run_outcome', run_index: 0, total: 1, completed_urls: [], outcome: { kind: 'other' } },
  { phase: 'run_outcome', run_index: 0, total: 1, completed_urls: [], outcome: { kind: 'completed', result: null } },
  { phase: 'upscale_outcome', outcome: { kind: 'completed', result: null, fallbackUrl: null } },
  { phase: 'upscale_outcome', outcome: { kind: 'poll_timeout', message: 'extra' } },
  { phase: 'refusal', refusal: { ok: false, code: 'reference_duration_invalid', message: '', startedAtMs: 0, phase: 'duration', media: 'audio', durationLimits: {}, rejection: { kind: 'totalTooShort', clips: [] } } },
])('rejects malformed video union %j', async payload => {
  await expect(serveVideoGenerationPatch(payload)).rejects.toBeInstanceOf(InvalidRequest);
});
