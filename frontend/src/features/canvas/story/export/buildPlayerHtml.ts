import type { CompiledStory } from '@/features/canvas/story/storyTypes';
import { resolveMediaUrl } from '@/lib/media-url';
import INKJS_RUNTIME from './vendor/inkjs-runtime.umd.js?raw';
import { PLAYER_STYLE, PLAYER_SCRIPT } from './playerAssets';

export interface PlayerLabels {
  defaultChoice: string;
  endingBadge: string;
  endingFallback: string;
  restart: string;
  loadError: string;
}

export interface BuildPlayerHtmlOptions {
  title?: string;
  /** 视频绝对 URL 的源（默认当前页 origin）。 */
  origin?: string;
  labels?: PlayerLabels;
}

const DEFAULT_LABELS: PlayerLabels = {
  defaultChoice: '默认',
  endingBadge: '结局',
  endingFallback: '全剧终',
  restart: '重新开始',
  loadError: '故事加载失败',
};

/** HTML 文本转义（用于 <title>）。 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** JSON 注入 <script> 的安全转义：挡 </script>、<!-- 与行分隔符。 */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .split('\u2028').join('\\u2028')
    .split('\u2029').join('\\u2029');
}

/** clip 路径烘焙为绝对 URL；空串保留；无法解析则回退原値。 */
function bakeClips(clipByNodeId: Record<string, string>, origin: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, path] of Object.entries(clipByNodeId)) {
    if (!path) { out[id] = ''; continue; }
    const resolved = resolveMediaUrl(path) ?? path;
    try {
      out[id] = new URL(resolved, origin).href;
    } catch {
      out[id] = resolved;
    }
  }
  return out;
}

/**
 * 组装自包含单 HTML 播放器：内联 inkjs runtime + 播放器脚本，注入编译产物。
 * @param compiled compileGraphToInk/compileStoryGroup 的产物
 * @param storyJson `story.ToJson()`（由调用方编译得到）
 */
export function buildPlayerHtml(
  compiled: CompiledStory,
  storyJson: string,
  opts: BuildPlayerHtmlOptions = {},
): string {
  const origin =
    opts.origin ?? (typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
  const title = (opts.title ?? '').trim() || 'Interactive Story';

  const data = {
    storyJson,
    clips: bakeClips(compiled.clipByNodeId, origin),
    choiceTime: compiled.choiceTimeByNodeId,
    defaultChoice: compiled.defaultChoiceIndexByNodeId,
    endings: compiled.endingByNodeId,
    variables: compiled.variables,
    labels: opts.labels ?? DEFAULT_LABELS,
    title,
  };

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${escapeHtml(title)}</title>
<style>${PLAYER_STYLE}</style>
</head>
<body>
<div id="app"></div>
<script>${INKJS_RUNTIME}</script>
<script>window.__STORY__=${safeJson(data)};</script>
<script>${PLAYER_SCRIPT}</script>
</body>
</html>`;
}
