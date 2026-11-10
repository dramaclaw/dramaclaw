// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { InvalidRequest } from '@/features/canvas/server/requestPayload';
import { serveImageToolRequest, serveImageToolPatch } from '@/features/canvas/server/imageTool';
import { actions, imagePayload, source, toolFixtures } from './toolFixtures';
import { invalidToolFields, malformedToolUnions } from './toolValidationFixtures';

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected fetch'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
const fixtures = (await toolFixtures()).filter(f => f.op.startsWith('image_tool_'));
const serve = (op: string, payload: unknown) => op === 'image_tool_request' ? serveImageToolRequest(payload) : serveImageToolPatch(payload);
it.each(fixtures)('matches the pure result without mutation: $name', async fixture => {
  const before = structuredClone(fixture.payload);
  expect(await serve(fixture.op, fixture.payload)).toStrictEqual(await fixture.expected());
  expect(fixture.payload).toStrictEqual(before);
});
it.each(invalidToolFields(fixtures))('rejects invalid field: $name', async fixture => {
  await expect(serve(fixture.op, fixture.payload)).rejects.toBeInstanceOf(InvalidRequest);
});
it.each(malformedToolUnions.filter(f => f.op.startsWith('image_tool_')))('rejects malformed union %j', async fixture => {
  await expect(serve(fixture.op, fixture.payload)).rejects.toBeInstanceOf(InvalidRequest);
});
it.each([null, [], {}, { phase: 'unknown' }])('rejects invalid payload %j', async payload => {
  await expect(serveImageToolRequest(payload)).rejects.toBeInstanceOf(InvalidRequest);
  await expect(serveImageToolPatch(payload)).rejects.toBeInstanceOf(InvalidRequest);
});

it.each(actions.flatMap(action => ['data:image/png;base64,AA==', 'blob:https://media.example.test/image'].map(imageUrl => ({ action, imageUrl }))))(
  'returns the pure inline refusal: $action $imageUrl', async ({ action, imageUrl }) => {
    const p = imagePayload(action); p.canvas.nodes = [source({ imageUrl })];
    expect(await serveImageToolRequest(p)).toStrictEqual({ ok: false, message: 'Inline image sources must be prepared before building an image tool request.' });
  });
