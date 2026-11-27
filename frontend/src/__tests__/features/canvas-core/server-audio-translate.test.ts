// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InvalidRequest } from '@/features/canvas/server/requestPayload';
import { serveAudioTranslateRequest, serveAudioTranslatePatch } from '@/features/canvas/server/audioTranslate';
import { toolFixtures } from './toolFixtures';
import { invalidToolFields, malformedToolUnions } from './toolValidationFixtures';

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected fetch'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
const fixtures = (await toolFixtures()).filter(f => f.op.startsWith('audio_translate_'));
const serve = (op: string, payload: unknown) => op === 'audio_translate_request' ? serveAudioTranslateRequest(payload) : serveAudioTranslatePatch(payload);
it.each(fixtures)('matches the pure result without mutation: $name', async fixture => {
  const before = structuredClone(fixture.payload);
  expect(await serve(fixture.op, fixture.payload)).toStrictEqual(await fixture.expected());
  expect(fixture.payload).toStrictEqual(before);
});
it.each(invalidToolFields(fixtures))('rejects invalid field: $name', async fixture => {
  await expect(serve(fixture.op, fixture.payload)).rejects.toBeInstanceOf(InvalidRequest);
});
it.each(malformedToolUnions.filter(f => f.op.startsWith('audio_translate_')))('rejects malformed union %j', async fixture => {
  await expect(serve(fixture.op, fixture.payload)).rejects.toBeInstanceOf(InvalidRequest);
});
it.each([null, [], {}, { phase: 'unknown' }])('rejects invalid payload %j', async payload => {
  await expect(serveAudioTranslateRequest(payload)).rejects.toBeInstanceOf(InvalidRequest);
  await expect(serveAudioTranslatePatch(payload)).rejects.toBeInstanceOf(InvalidRequest);
});
