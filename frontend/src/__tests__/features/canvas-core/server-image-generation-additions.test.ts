// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InvalidRequest } from '@/features/canvas/server/requestPayload';
import { serveImageGenerationPatch, serveImageGenerationRequest } from '@/features/canvas/server/imageGeneration';
import { imageInlineFixture, materializeFixtures } from './generationFixtures';
import { invalidFields } from './generationValidationFixtures';
beforeEach(() => { vi.stubGlobal('fetch', () => { throw new Error('Network is forbidden'); }); });
afterEach(() => vi.unstubAllGlobals());
const fixtures = (await materializeFixtures()).filter(f => f.op === 'image_generation_patch');
it.each(fixtures)('matches pure image additions: $name', async f => {
  const before = structuredClone(f.payload);
  expect(await serveImageGenerationPatch(f.payload)).toStrictEqual(await f.expected());
  expect(f.payload).toStrictEqual(before);
});
it.each(invalidFields(fixtures))('rejects $name', async f => {
  await expect(serveImageGenerationPatch(f.payload)).rejects.toBeInstanceOf(InvalidRequest);
});
it('refuses inline image media without returning a request body', async () => {
  const f = await imageInlineFixture();
  expect(await serveImageGenerationRequest(f.payload)).toStrictEqual(f.expected);
  expect(f.expected.request).toMatchObject({ ok: false, code: 'inline_media_reference' });
});

it.each([
  { phase: 'action_result', error_message: '', settled: [] },
  { phase: 'action_result', settle_outcome: { kind: 'rethrow', runIndex: 0 }, settled: [] },
  { phase: 'settle', completion_mode: 'other', completed_urls: [], accepted_refs: [], settled: [] },
  { phase: 'settle', completion_mode: 'completed', completed_urls: [], accepted_refs: [], settled: [{ status: 'fulfilled', value: 'other' }] },
  { phase: 'settle', completion_mode: 'completed', completed_urls: [], accepted_refs: [], settled: [{ status: 'other' }] },
])('rejects malformed image additions %j', async payload => {
  await expect(serveImageGenerationPatch(payload)).rejects.toBeInstanceOf(InvalidRequest);
});
