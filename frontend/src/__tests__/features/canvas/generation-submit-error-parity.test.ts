// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiCall } from '@/api/client';
import { backendErrorToastMessage } from '@/lib/api-errors';
import { resolveGenerationErrorDiagnostics } from '@/features/canvas/application/generationErrorReport';
import { resolveErrorContent } from '@/features/canvas/application/errorDialog';
import { referenceIssues } from '@/features/canvas/nodes/shared/ReferenceValidationDialog';
import {
  generationErrorFromSubmitFailure, describeGenerationError, describeGenerationSubmitFailure,
  type GenerationSubmitFailure,
} from '@/features/canvas/application/generationRequests/generationSubmitError';

// Only fetch is stubbed: exercise POST, ky body parsing, hooks and apiCall for real.
// No 401 fixtures: no session-expiry mock is needed.
const prefix = 'https://canvas.example/api/v1';
const path = 'projects/demo/freezone/gen';
const url = `${prefix}/${path}`;
const fallback = 'Generation failed';
const t = (key: string, options?: Record<string, unknown>) => JSON.stringify([key, options ?? null]);
type Fixture = { name: string; status: number; statusText?: string; body?: unknown; raw?: string; contentType?: string };
const fixtures: Fixture[] = [
  { name: '402 empty body', status: 402, raw: '' },
  { name: '402 JSON body', status: 402, body: { error: 'Balance too low' } },
  { name: 'nested insufficient credits code', status: 400, body: { detail: { nested: { error_code: 'INSUFFICIENT_CREDITS', message: 'Add credits' } } } },
  { name: 'billing rule code', status: 400, body: { data: { error_code: 'BILLING_RULE_NOT_CONFIGURED' }, error: 'No billing rule' } },
  { name: 'legacy billing rule message', status: 400, body: { error: 'billing rule is not configured' } },
  { name: '500 legacy insufficient credits', status: 500, body: { error: 'insufficient credits' } },
  ...['default', 'image', 'video'].flatMap(queueKind =>
    [undefined, 'project', 'user', 'channel', 'platform', 'global_lane_queue', 'unknown_scope'].map(scope => ({
      name: `429 ${queueKind} scope ${scope ?? 'absent'}`, status: 429,
      body: { error: 'Queue rejected', data: { queue_kind: queueKind, ...(scope === undefined ? {} : { limit_scope: scope }) } },
    }))),
  { name: '400 request id', status: 400, body: { error: 'Submit failed request_id=req-123' } },
  { name: '422 string detail', status: 422, body: { detail: 'Invalid input' } },
  { name: '422 detail message and hint', status: 422, body: { detail: { message: 'Invalid input', user_action_hint: 'Choose another image' } } },
  { name: '422 reference valid and invalid items', status: 422, body: { detail: { code: 'REFERENCE_MEDIA_INVALID', errors: [
    { media: 'image', index: 1, name: 'Image', code: 'missing', reference_key: 'ref.png' },
    null, {}, { media: 'image', index: '1', code: 'missing', reference_key: 'bad.png' },
    { media: 'image', index: 2, code: 9, reference_key: 'bad.png' },
    { media: 'image', index: 2, code: 'missing' },
    { index: 2, code: 'missing', reference_key: 'bad.png' },
  ] } } },
  { name: '500 plain text', status: 500, raw: 'Upstream unavailable', body: 'Upstream unavailable', contentType: 'text/plain' },
  { name: '502 empty body', status: 502, raw: '', statusText: 'Bad Gateway' },
  { name: 'invalid JSON body', status: 500, raw: '{broken' },
  { name: 'JSON null body', status: 500, body: null },
  { name: 'JSON subtype body', status: 400, body: { error: 'Problem' }, contentType: 'application/problem+json; charset=utf-8' },
  { name: 'non-JSON JSON-looking text', status: 500, raw: '{"error":"Text only"}', body: '{"error":"Text only"}', contentType: 'text/plain' },
  { name: 'HTTP empty error string', status: 400, body: { error: '' } },
  { name: 'envelope error', status: 200, body: { ok: false, error: 'Rejected envelope' } },
  { name: 'envelope missing error', status: 200, body: { ok: false } },
  { name: 'envelope empty error', status: 200, body: { ok: false, error: '' } },
];
function field(error: Error, key: string): unknown { return Reflect.get(error, key); }
function compare(real: unknown, failure: GenerationSubmitFailure) {
  expect(real).toBeInstanceOf(Error);
  if (!(real instanceof Error)) throw new Error('Expected apiCall rejection');
  const pure = generationErrorFromSubmitFailure(failure);
  // Transport errors belong to ky; their serialised form preserves name/message,
  // while HTTP and envelope errors retain the shared constructor itself.
  if (failure.kind !== 'thrown') expect(pure.constructor).toBe(real.constructor);
  for (const key of ['name', 'message', 'status', 'body', 'queueKind', 'limitScope']) {
    expect(field(pure, key), key).toStrictEqual(field(real, key));
  }
  const original = {
    name: real.name, message: real.message,
    status: typeof field(real, 'status') === 'number' ? field(real, 'status') : null,
    display: backendErrorToastMessage(real, t),
    ...resolveGenerationErrorDiagnostics(real, resolveErrorContent(real, fallback).details),
    referenceIssues: referenceIssues(real),
  };
  expect(describeGenerationError(real, t, fallback)).toStrictEqual(original);
  expect(describeGenerationSubmitFailure(failure, t, fallback)).toStrictEqual(original);
  expect(JSON.parse(JSON.stringify(original))).toStrictEqual(original);
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('submit error parity with real POST apiCall', () => {
  it.each(fixtures)('$name', async fixture => {
    const statusText = fixture.statusText ?? '';
    const fetch = vi.fn(async (_request: Request) => new Response(fixture.raw ?? JSON.stringify(fixture.body), {
      status: fixture.status, statusText, headers: { 'content-type': fixture.contentType ?? 'application/json' },
    }));
    vi.stubGlobal('fetch', fetch);
    const real = await apiCall(path, { prefix, method: 'POST', json: {} }).catch((error: unknown) => error);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0].method).toBe('POST');
    expect(fetch.mock.calls[0][0].url).toBe(url);
    const failure: GenerationSubmitFailure = fixture.status === 200
      ? { kind: 'envelope', body: fixture.body }
      : { kind: 'http', status: fixture.status, statusText, method: 'POST', url, ...(fixture.body === undefined ? {} : { body: fixture.body }) };
    compare(real, failure);
    if (fixture.name === '422 reference valid and invalid items') {
      expect(referenceIssues(real)).toHaveLength(1);
    }
  });
  it('network failure from fetch TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const real = await apiCall(path, { prefix, method: 'POST', json: {} }).catch((error: unknown) => error);
    compare(real, { kind: 'thrown', name: 'NetworkError', message: `Request failed due to a network error: POST ${url}` });
  });
  it('timeout from a pending fetch', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const pending = apiCall(path, { prefix, method: 'POST', json: {}, timeout: 10 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(11);
    compare(await pending, { kind: 'thrown', name: 'TimeoutError', message: `Request timed out: POST ${url}` });
  });
});
