// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InvalidRequest } from '@/features/canvas/server/requestPayload';
import { serveGenerationErrorDescribe } from '@/features/canvas/server/generationError';
import { errorFixtures } from './generationFixtures';
import { invalidFields } from './generationValidationFixtures';
beforeEach(() => { vi.stubGlobal('fetch', () => { throw new Error('Network is forbidden'); }); });
afterEach(() => vi.unstubAllGlobals());
const fixtures = errorFixtures();
it.each(fixtures)('describes $name without mutation', async f => {
  const before = structuredClone(f.payload);
  expect(await serveGenerationErrorDescribe(f.payload)).toStrictEqual(await f.expected());
  expect(f.payload).toStrictEqual(before);
});
it.each(invalidFields(fixtures))('rejects $name', async f => {
  await expect(serveGenerationErrorDescribe(f.payload)).rejects.toBeInstanceOf(InvalidRequest);
});
it.each([null, [], {}, { locale: 1 },
  { failure: { kind: 'envelope' }, fallback_message: '' },
  { failure: { kind: 'thrown', name: '', message: '', status: 500 }, fallback_message: '' },
  { failure: { kind: 'http', status: 500, statusText: '', method: 'POST', url: '/', name: 'Error' }, fallback_message: '' },
  { failure: { kind: 'envelope', body: null, message: '' }, fallback_message: '' },
])('rejects malformed union %j', async p => {
  await expect(serveGenerationErrorDescribe(p)).rejects.toBeInstanceOf(InvalidRequest);
});
