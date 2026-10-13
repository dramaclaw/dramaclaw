import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import type { CompiledStory } from '../storyTypes';
import { resolveMediaUrl } from '@/lib/media-url';
import { buildPlayerHtml } from './buildPlayerHtml';

/** Sequential, uncompressed ZIP entries: no Base64 and no full-video JS buffers. */
export async function buildStoryZip(
  compiled: CompiledStory,
  storyJson: string,
  title: string,
  onProgress?: (completed: number, total: number) => void,
): Promise<Blob> {
  const paths = [...new Set([
    ...Object.values(compiled.clipByNodeId),
    ...Object.values(compiled.choiceLoopClipByNodeId),
  ].filter(Boolean))];
  const resolved = new Map(paths.map((path) => {
    const url = resolveMediaUrl(path);
    if (!url) throw new Error('unsupported-media');
    return [path, url];
  }));
  const urls = [...new Set(resolved.values())];
  const files = new Map<string, string>();
  const writer = new ZipWriter(new BlobWriter('application/zip'), { level: 0, useWebWorkers: false });
  onProgress?.(0, urls.length);
  for (const [index, url] of urls.entries()) {
    // The response body streams into the ZIP below; a total-duration timeout
    // would abort healthy downloads of large videos on slower connections.
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('media-download-failed');
    const type = response.headers.get('content-type')?.split(';')[0].trim() ?? '';
    if ((!type.startsWith('video/') && type !== 'application/octet-stream') || !response.body) {
      await response.body?.cancel();
      throw new Error('invalid-video');
    }
    const extension = /\.(mp4|webm|mov|m4v|ogv)$/i.exec(new URL(url, window.location.origin).pathname)?.[1].toLowerCase()
      ?? ({ 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/ogg': 'ogv' }[type] ?? 'mp4');
    const name = `videos/${String(index + 1).padStart(4, '0')}.${extension}`;
    const entry = await writer.add(name, response.body);
    if (!entry.uncompressedSize) throw new Error('empty-video');
    files.set(url, name);
    onProgress?.(index + 1, urls.length);
  }
  const replace = (clips: Record<string, string>) => Object.fromEntries(
    Object.entries(clips).map(([id, path]) => [id, path ? files.get(resolved.get(path)!)! : '']),
  );
  const html = buildPlayerHtml({
    ...compiled,
    clipByNodeId: replace(compiled.clipByNodeId),
    choiceLoopClipByNodeId: replace(compiled.choiceLoopClipByNodeId),
  }, storyJson, { title, mediaPaths: 'relative' });
  await writer.add('index.html', new TextReader(html));
  // The portable archive intentionally includes instructions in both languages.
  await writer.add('README.txt', new TextReader(
    '完整解压此 ZIP，然后打开 index.html。请保留 videos 文件夹的位置。\n播放器、剧情探索和视频支持离线使用；外部链接需要网络。\n\nExtract the entire ZIP, then open index.html. Keep the videos folder beside it.\nPlayer, story exploration and videos work offline; external links require internet.\n', // i18n-exempt
  ));
  return writer.close();
}
