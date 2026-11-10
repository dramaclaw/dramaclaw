// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { selectWorldGenerationUpstream } from '@/features/canvas/application/generationRequests';
import { serveWorldGenerationUpstream } from '@/features/canvas/server/worldGeneration';
import { InvalidRequest } from '@/features/canvas/server/requestPayload';
import { workerWorldUpstreamFixtures, invalidWorldUpstreamPayloads, worldId } from './worldUpstreamFixtures';

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected fetch'); })); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
it.each(workerWorldUpstreamFixtures)('returns pure selection without mutation: $name', async ({ canvas, expected }) => {
  for (const env of [undefined, {}, { locale: 'en' }, { locale: 'zh' }]) {
    const payload = { canvas: structuredClone(canvas), node_id: worldId, ...(env === undefined ? {} : { env }) };
    const snapshot = structuredClone(payload);
    const pure = selectWorldGenerationUpstream({ ...canvas, nodeId: worldId });
    expect(pure.upstream).toStrictEqual(expected);
    expect(await serveWorldGenerationUpstream(payload)).toStrictEqual(pure);
    expect(payload).toStrictEqual(snapshot);
    expect(canvas).toStrictEqual(snapshot.canvas);
  }
});
it.each(invalidWorldUpstreamPayloads)('rejects invalid envelope %j', async payload => {
  await expect(serveWorldGenerationUpstream(payload)).rejects.toBeInstanceOf(InvalidRequest);
});
