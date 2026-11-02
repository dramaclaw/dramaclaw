import i18next from 'i18next';
import type { CompiledStory } from '@/features/canvas/story/storyTypes';
import { resolveMediaUrl } from '@/lib/media-url';
import { PLAYER_STYLE, PLAYER_SCRIPT } from './playerAssets';

export interface PlayerLabels {
  defaultChoice: string;
  endingBadge: string;
  endingFallback: string;
  restart: string;
  loadError: string;
  placeholderBadge: string;
  placeholderHint: string;
  automaticPlaceholderHint?: string;
  automaticPlaceholderNext?: string;
  play?: string;
  pause?: string;
  seek?: string;
  mediaError?: string;
  retry?: string;
  countdown?: string;
  flagOn?: string;
  flagOff?: string;
  replayExperience?: string;
  ctaUnconfigured?: string;
  exploration?: Record<string, string>;
  treeEnding?: string;
}

export interface BuildPlayerHtmlOptions {
  title?: string;
  /** 视频绝对 URL 的源（默认当前页 origin）。 */
  origin?: string;
  labels?: PlayerLabels;
  /** ZIP media paths must stay relative to index.html for file:// playback. */
  mediaPaths?: 'absolute' | 'relative';
}

function defaultLabels(): PlayerLabels {
  return {
    exploration: i18next.t('canvas.story.exploration', { returnObjects: true }) as Record<string, string>,
    treeEnding: i18next.t('canvas.story.tree.ending'),
    defaultChoice: i18next.t('canvas.story.defaultChoice'),
    endingBadge: i18next.t('canvas.story.messages.endingBadge'),
    endingFallback: i18next.t('canvas.story.endingFallback'),
    restart: i18next.t('canvas.story.restart'),
    loadError: i18next.t('canvas.story.messages.loadError'),
    placeholderBadge: i18next.t('canvas.story.placeholderBadge'),
    placeholderHint: i18next.t('canvas.story.placeholderHint'),
    automaticPlaceholderHint: i18next.t('canvas.story.automaticPlaceholderHint'),
    automaticPlaceholderNext: i18next.t('canvas.story.automaticPlaceholderNext'),
    play: i18next.t('canvas.story.playMode.playCurrent'),
    pause: i18next.t('canvas.story.playMode.pauseCurrent'),
    seek: i18next.t('canvas.story.playMode.seek'),
    mediaError: i18next.t('canvas.story.mediaError'),
    retry: i18next.t('canvas.story.retryMedia'),
    countdown: i18next.t('canvas.story.choiceCountdown'),
    flagOn: i18next.t('canvas.story.flagOn'),
    flagOff: i18next.t('canvas.story.flagOff'),
    replayExperience: i18next.t('canvas.story.replayExperience'),
    ctaUnconfigured: i18next.t('canvas.story.ctaUnconfigured'),
  };
}

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
 * 组装单 HTML：内联共享 React 播放器（包含 inkjs）与剧情，视频保留内嵌 data URL，普通路径转为绝对链接。
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
    explorationNodes: compiled.explorationNodes,
    clips: opts.mediaPaths === 'relative' ? compiled.clipByNodeId : bakeClips(compiled.clipByNodeId, origin),
    choiceLoops: opts.mediaPaths === 'relative' ? compiled.choiceLoopClipByNodeId : bakeClips(compiled.choiceLoopClipByNodeId, origin),
    choiceTime: compiled.choiceTimeByNodeId,
    defaultChoice: compiled.defaultChoiceIndexByNodeId,
    endings: compiled.endingByNodeId,
    placeholders: compiled.placeholderByNodeId,
    choiceFeedback: compiled.choiceFeedbackById,
    choiceStateChanges: compiled.choiceStateChangesById,
    choiceInteraction: compiled.choiceInteractionById,
    labels: { ...defaultLabels(), ...opts.labels },
    title,
  };

  return `<!doctype html>
<html lang="${i18next.resolvedLanguage?.startsWith('en') ? 'en' : i18next.resolvedLanguage?.startsWith('vi') ? 'vi' : 'zh'}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${escapeHtml(title)}</title>
<style>${PLAYER_STYLE}</style>
</head>
<body>
<div id="app"></div>
<script>window.__STORY__=${safeJson(data)};</script>
<script>${PLAYER_SCRIPT.replace(/<\/script/gi, '<\\/script')}</script>
</body>
</html>`;
}
