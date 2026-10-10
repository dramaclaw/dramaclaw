import { afterEach, expect, it, vi } from 'vitest';
import { type FileEntry, BlobReader, ZipReader, TextWriter, Uint8ArrayWriter } from '@zip.js/zip.js';
import { buildStoryZip } from '@/features/canvas/story/export/buildStoryZip';
import type { CompiledStory } from '@/features/canvas/story/storyTypes';
const compiled = {
  ink: '', clipByNodeId: { a: '/static/a.mp4', empty: '' },
  choiceLoopClipByNodeId: { a: '/static/a.mp4', b: '/static/loop.webm' },
  explorationNodes: [{ id: 'a', label: '开场', successors: [], isEnding: true }],
  knotByNodeId: {}, choiceTimeByNodeId: {}, defaultChoiceIndexByNodeId: {},
  endingByNodeId: {}, placeholderByNodeId: {}, choiceFeedbackById: {},
  choiceStateChangesById: {}, choiceInteractionById: {}, warnings: [], variables: [],
} satisfies CompiledStory;
afterEach(() => vi.unstubAllGlobals());
it('writes an extractable ZIP with unchanged video bytes, deduplication and a self-contained relative-path player', async () => {
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(new Uint8Array([0, 1, 128, 255]), {
    headers: { 'content-type': 'video/mp4', 'content-length': '536870912' },
  })));
  vi.stubGlobal('fetch', fetchMock);
  const progress = vi.fn();
  const zip = await buildStoryZip(compiled, '{}', '测试故事', progress);
  const reader = new ZipReader(new BlobReader(zip), { useWebWorkers: false });
  const entries = (await reader.getEntries()).filter((entry): entry is FileEntry => !entry.directory);
  expect(entries.map((entry) => entry.filename)).toEqual(['videos/0001.mp4', 'videos/0002.webm', 'index.html', 'README.txt']);
  for (const entry of entries.slice(0, 2)) {
    expect(await entry.getData!(new Uint8ArrayWriter(), { checkSignature: true })).toEqual(new Uint8Array([0, 1, 128, 255]));
    expect(entry.compressionMethod).toBe(0);
  }
  const html = await entries[2].getData!(new TextWriter(), { checkSignature: true });
  const payload = JSON.parse(html.match(/window\.__STORY__=(\{[\s\S]*?\});<\/script>/)![1]);
  expect(payload.clips).toEqual({ a: 'videos/0001.mp4', empty: '' });
  expect(payload.choiceLoops).toEqual({ a: 'videos/0001.mp4', b: 'videos/0002.webm' });
  expect(payload.explorationNodes).toEqual(compiled.explorationNodes);
  expect(html).not.toContain('data:video/');
  expect(html).not.toContain('/static/a.mp4');
  expect(html).not.toContain('<script src=');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(progress).toHaveBeenLastCalledWith(2, 2);
  expect(compiled.clipByNodeId.a).toBe('/static/a.mp4');
  await reader.close();
});
it.each([[403, 'video/mp4', 'bad'], [200, 'text/html', 'login'], [200, 'video/mp4', '']])(
  'does not return a partial archive for invalid media', async (status, type, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status, headers: { 'content-type': type } })));
    await expect(buildStoryZip(compiled, '{}', 'test')).rejects.toThrow();
  },
);
it('rejects foreign media before downloading', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await expect(buildStoryZip({ ...compiled, clipByNodeId: { a: 'https://foreign.example/a.mp4' } }, '{}', 'test')).rejects.toThrow('unsupported-media');
  expect(fetchMock).not.toHaveBeenCalled();
});
