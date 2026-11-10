// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InvalidRequest } from '@/features/canvas/server/requestPayload';
import { serveAudioGenerationRequest, serveAudioGenerationPatch } from '@/features/canvas/server/audioGeneration';
import { audioPayload, materializeFixtures } from './generationFixtures';
import { invalidFields } from './generationValidationFixtures';

beforeEach(() => { vi.stubGlobal('fetch', () => { throw new Error('Network is forbidden'); }); });
afterEach(() => vi.unstubAllGlobals());
const fixtures = (await materializeFixtures()).filter(f => f.op.startsWith('audio_'));
const serve = (op: string, payload: unknown) => op === 'audio_generation_request' ? serveAudioGenerationRequest(payload) : serveAudioGenerationPatch(payload);
it.each(fixtures)('matches the pure result without mutation: $name', async fixture => {
  const before = structuredClone(fixture.payload);
  expect(await serve(fixture.op, fixture.payload)).toStrictEqual(await fixture.expected());
  expect(fixture.payload).toStrictEqual(before);
});
it.each(invalidFields(fixtures))('rejects invalid field: $name', async fixture => {
  await expect(serve(fixture.op, fixture.payload)).rejects.toBeInstanceOf(InvalidRequest);
});
it.each([null, [], {}, { phase: 'other' }])('rejects invalid payload %j', async payload => {
  await expect(serveAudioGenerationRequest(payload)).rejects.toBeInstanceOf(InvalidRequest);
  await expect(serveAudioGenerationPatch(payload)).rejects.toBeInstanceOf(InvalidRequest);
});

it('rejects compile metadata for a missing node', async () => {
  await expect(serveAudioGenerationPatch({ ...audioPayload(), node_id: 'missing', phase: 'compile_metadata',
    metadata: { mode: 'model', prompt: 'Music', recipeIds: [] }, compiled_at: 'caller-time' })).rejects.toBeInstanceOf(InvalidRequest);
});
it.each([
  { phase: 'action_result', hook_output: {}, hook_error: { message: '', isError: true, voicePrerequisite: false } },
  { phase: 'outcome', outcome: { kind: 'failed', message: '', isError: true } },
  { phase: 'outcome', outcome: { kind: 'completed', url: '', message: 'extra' } },
  { phase: 'outcome', outcome: { kind: 'other' } },
  { phase: 'repair', node_data: {}, now_iso: 'time' },
])('rejects malformed audio union %j', async payload => {
  await expect(serveAudioGenerationPatch(payload)).rejects.toBeInstanceOf(InvalidRequest);
});
