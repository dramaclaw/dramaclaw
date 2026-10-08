import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({ handleSessionExpired: vi.fn() }));
vi.mock('@/api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, apiClient: actual.apiClient.extend({ prefix: 'http://localhost/api/v1' }) };
});

import { streamFreezoneH3 } from '@/api/ops';
import { errorFromBackendBody } from '@/lib/api-errors';

afterEach(() => vi.unstubAllGlobals());

const payload = {
  prompt: '{{Mixed 14}}: keep the original camera.', model: 'ark::doubao-seed-evolving',
  references: Array.from({ length: 14 }, (_, i) => ({ node_id: `ref-${i}`, image_url: `/static/${i}.png` })),
  h3Options: { mode: 'allReference', duration_sec: 15, reference_order: Array<'image'>(14).fill('image') },
};

describe('H3 HTTP request contract', () => {
  it('preserves the provider model and every reference before streaming', async () => {
    let sent: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async (request: Request) => {
      sent = await request.json();
      return new Response('data: {"type":"delta","text":"original"}\n\n'
        + 'data: {"type":"done","generated_text":"original","model":"ark::doubao-seed-evolving"}\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
    }));
    const onText = vi.fn();
    const result = await streamFreezoneH3('project', payload, onText, new AbortController().signal);
    expect(sent.model).toBe(payload.model);
    expect(sent.references).toEqual(payload.references);
    expect(sent.h3_options).toEqual(payload.h3Options);
    expect(result.generated_text).toBe('original');
    expect(onText).toHaveBeenCalledWith('original');
  });

  it('shows a 422 field error without exposing the rejected input', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ detail: [{
      loc: ['body', 'h3_options', 'reference_order'], type: 'too_long',
      msg: 'List should have at most 64 items after validation, not 65',
      input: ['PRIVATE_INPUT_DO_NOT_DISPLAY'],
    }] }), { status: 422, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const failure = await streamFreezoneH3('project', payload, vi.fn(), new AbortController().signal).catch(error => error);
    expect(failure).toMatchObject({ status: 422 });
    expect(failure.message).toContain('body.h3_options.reference_order');
    expect(failure.message).toContain('at most 64');
    expect(failure.message).not.toContain('PRIVATE_INPUT');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('keeps ordinary request errors readable too', () => {
    const error = errorFromBackendBody(422, { detail: [
      { loc: ['body', 'references', 2, 'node_id'], msg: 'String should have at least 1 character', input: '' },
      null, { loc: [], input: 'PRIVATE' },
    ] }, 'Unprocessable Entity');
    expect(error?.message).toBe('body.references.2.node_id: String should have at least 1 character');
  });

  it('surfaces binding validation errors before any SSE data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'H3 reference order does not match attachments' }),
      { status: 400, headers: { 'content-type': 'application/json' } })));
    const onText = vi.fn();
    await expect(streamFreezoneH3('project', payload, onText, new AbortController().signal))
      .rejects.toThrow('H3 reference order does not match attachments');
    expect(onText).not.toHaveBeenCalled();
  });
});
