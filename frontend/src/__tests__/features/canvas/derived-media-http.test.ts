// SPDX-License-Identifier: Elastic-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api', () => ({ handleSessionExpired: vi.fn() }));
vi.mock('@/api/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/api/client')>();
  return {
    ...original,
    apiCall: (path: string, options: object) =>
      original.apiCall(path, { ...options, prefix: 'http://localhost/api/v1' }),
  };
});
vi.mock('@/api/tasks', () => ({
  awaitTaskCompletion: vi
    .fn()
    .mockResolvedValue({ result: { svg_url: '/image.svg' } }),
  isTaskPollTimeoutError: () => false,
}));
vi.mock('@/features/canvas/application/resumeGeneration', () => ({
  CLEARED_GENERATION_TASK_FIELDS: {},
  generationTaskDescriptor: () => ({}),
}));
import { generateDerivedMedia } from '@/features/canvas/application/derivedMedia';
afterEach(() => vi.unstubAllGlobals());
describe('derived media HTTP serialization', () => {
  it('posts application/json parsed by FastAPI image schema', async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: Request) => {
        requests.push(input.clone());
        return new Response(
          JSON.stringify({
            ok: true,
            data: {
              task_type: 'freezone_image_vectorize',
              task_key: 't',
              job_id: 'j',
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    await generateDerivedMedia(
      'p',
      'n',
      'svg',
      '/source.png',
      undefined,
      'canvas',
      vi.fn(),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.get('content-type')).toContain(
      'application/json',
    );
    expect(await requests[0].json()).toEqual({
      image_url: '/source.png',
      canvas_id: 'canvas',
      node_id: 'n',
    });
  });
});
