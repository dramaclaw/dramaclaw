// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InvalidRequest } from '@/features/canvas/server/requestPayload';
import { serveTextGenerationRequest, serveTextGenerationPatch } from '@/features/canvas/server/textGeneration';
import { materializeFixtures } from './generationFixtures';
import { invalidFields } from './generationValidationFixtures';

beforeEach(() => { vi.stubGlobal('fetch', () => { throw new Error('Network is forbidden'); }); });
afterEach(() => vi.unstubAllGlobals());
const fixtures = (await materializeFixtures()).filter(f => f.op.startsWith('text_'));
const serve = (op: string, payload: unknown) => op === 'text_generation_request' ? serveTextGenerationRequest(payload) : serveTextGenerationPatch(payload);
it.each(fixtures)('matches the pure result without mutation: $name', async fixture => {
  const before = structuredClone(fixture.payload);
  expect(await serve(fixture.op, fixture.payload)).toStrictEqual(await fixture.expected());
  expect(fixture.payload).toStrictEqual(before);
});
it.each(invalidFields(fixtures))('rejects invalid field: $name', async fixture => {
  await expect(serve(fixture.op, fixture.payload)).rejects.toBeInstanceOf(InvalidRequest);
});
it.each([null, [], {}, { phase: 'other' }])('rejects invalid payload %j', async payload => {
  await expect(serveTextGenerationRequest(payload)).rejects.toBeInstanceOf(InvalidRequest);
  await expect(serveTextGenerationPatch(payload)).rejects.toBeInstanceOf(InvalidRequest);
});

it.each([
  { phase: 'outcome', outcome: { kind: 'failed', message: '' } },
  { phase: 'outcome', outcome: { kind: 'completed', content: '', isError: true } },
  { phase: 'outcome', outcome: { kind: 'other' } },
])('rejects malformed text union %j', async payload => {
  await expect(serveTextGenerationPatch(payload)).rejects.toBeInstanceOf(InvalidRequest);
});
