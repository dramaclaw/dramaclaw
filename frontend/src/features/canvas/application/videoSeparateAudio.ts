// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  fetchFreezoneAudioSeparateResult,
  submitFreezoneAudioSeparate,
} from '@/api/ops';
import { awaitTaskCompletion, isTaskPollTimeoutError } from '@/api/tasks';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { notifyTaskStillRunning } from './errorDialog';

/** 音频 / 静音视频结果节点的落位尺寸（与 NodeActionToolbar 原实现一致）。 */
const AUDIO_LAYOUT_WIDTH = 480;
const AUDIO_LAYOUT_HEIGHT = 180;
const SILENT_LAYOUT_WIDTH = 480;
const SILENT_LAYOUT_HEIGHT = 270;

const AUDIO_EXT_RE = /\.(mp3|m4a|aac|wav|flac|ogg|opus)(\?|$)/i;
const VIDEO_EXT_RE = /\.(mp4|mov|webm|mkv|avi|m4v)(\?|$)/i;

/**
 * Walk an arbitrary JSON tree and pull every string that looks like a
 * URL/path. Backend hasn't typed the result schema, so we can't rely on key
 * names alone.
 */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (value.length > 0) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStrings(item, out);
    }
  }
}

/**
 * Fallback only: some legacy results carry a backend filesystem path (e.g.
 * `/data/output/<user>/<project>/...`) instead of a servable URL. Rewriting
 * `<...>/output/` into `/static/<user>/<project>/...` yields the LEGACY scheme,
 * which production now rejects with 410 — so this is used strictly as a last
 * resort when no `*_url` field exists.
 */
function toStaticUrl(raw: string): string {
  if (!raw) return raw;
  if (
    raw.startsWith('/static/') ||
    raw.startsWith('http://') ||
    raw.startsWith('https://') ||
    raw.startsWith('blob:') ||
    raw.startsWith('data:')
  ) {
    return raw;
  }
  const outputIdx = raw.lastIndexOf('/output/');
  if (outputIdx >= 0) {
    return `/static/${raw.slice(outputIdx + '/output/'.length)}`;
  }
  return raw;
}

function pickUrlField(
  source: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * 从「分离音视频」任务结果里挑出音频轨与静音视频的地址（从 NodeActionToolbar 的
 * `classify` 内联闭包原样搬出，语义零变化）。
 *
 * 优先取后端给的规范字段：结果同时带文件系统 `*_path`
 * （`/data/output/<user>/<project>/...`）与可直接访问的 `*_url`
 * （`/static/projects/<project_id>/...`），只有 `*_url` 在线可达
 * （OpenResty 对历史 `/static/<user>/<project>/...` 返回 410），
 * 因此绝不从 `*_path` 反推 URL。
 *
 * 没有显式 URL 字段时才走兜底启发式：遍历整棵树按扩展名/关键词挑，
 * 并把已可直接访问的 `/static`、http(s) 串排在裸文件系统路径前面。
 */
export function classifyAudioSeparateResult(
  source: Record<string, unknown> | null | undefined,
): { audio: string | null; video: string | null } {
  if (!source) return { audio: null, video: null };

  let audio = pickUrlField(source, ['audio_url', 'audioUrl']);
  let video = pickUrlField(source, ['mute_video_url', 'muteVideoUrl']);

  if (!audio || !video) {
    const strings: string[] = [];
    collectStrings(source, strings);
    const isServable = (s: string) =>
      s.startsWith('/static/') || s.startsWith('http://') || s.startsWith('https://');
    strings.sort((a, b) => Number(isServable(b)) - Number(isServable(a)));
    for (const s of strings) {
      if (!audio && (AUDIO_EXT_RE.test(s) || /audio|sound/i.test(s))) {
        audio = s;
      } else if (
        !video &&
        (VIDEO_EXT_RE.test(s) || /silent|mute|no[_-]?audio|video/i.test(s))
      ) {
        video = s;
      }
      if (audio && video) break;
    }
  }

  return {
    audio: audio ? toStaticUrl(audio) : null,
    video: video ? toStaticUrl(video) : null,
  };
}

/**
 * 结果节点的标题前缀：优先源文件名，其次展示名，都没有就 `video`；去掉扩展名
 * （与 NodeActionToolbar 原实现一致）。
 */
export function resolveSeparateBaseName(data: Record<string, unknown>): string {
  const rawName =
    typeof data.sourceFileName === 'string' && data.sourceFileName.trim().length > 0
      ? data.sourceFileName
      : typeof data.displayName === 'string' && data.displayName.trim().length > 0
        ? data.displayName
        : 'video';
  return rawName.replace(/\.[^/.]+$/, '');
}

export interface VideoSeparateAudioResult {
  /** 新建的音频节点 id；未成功时为 null。 */
  audioNodeId: string | null;
  /** 新建的静音视频节点 id；未成功时为 null。 */
  videoNodeId: string | null;
  /** 失败原因；成功或「结果里找不到地址」时为 null（后者只记 warn，同原实现）。 */
  error: string | null;
}

/**
 * 分离音视频编排（从 NodeActionToolbar 的 handleAudioSeparate 内联闭包原样搬出，
 * 语义零变化；建边策略后调整，见下）：源节点置 isSeparatingAv → 提交
 * /freezone/video/audio-separate → 等任务完成 → 从 SSE 结果里挑音频/静音视频
 * 地址（挑不全再打一次 job result 接口兜底）→ 在源节点下游各建一个音频节点与
 * 静音视频节点；静音视频 video→video 合法，连边；音频节点撞白名单，不连边、
 * 只靠 findNodePosition 落在源附近（见下方注释）。无论成功失败都在最后清掉
 * isSeparatingAv。
 */
export async function separateVideoAudio(
  sourceNodeId: string,
  opts: { sourceUrl: string },
): Promise<VideoSeparateAudioResult> {
  const empty: VideoSeparateAudioResult = {
    audioNodeId: null,
    videoNodeId: null,
    error: null,
  };
  if (!opts.sourceUrl) return empty;
  const projectId = readUrl().project;
  if (!projectId) {
    console.error('[audio-separate] no project in URL');
    return empty;
  }
  const store = useCanvasStore.getState();
  const node = store.nodes.find((candidate) => candidate.id === sourceNodeId);
  if (!node) return empty;
  const baseName = resolveSeparateBaseName(node.data as Record<string, unknown>);

  store.updateNodeData(sourceNodeId, { isSeparatingAv: true });
  try {
    const ref = await submitFreezoneAudioSeparate(projectId, {
      sourceUrl: opts.sourceUrl,
    });
    const completed = await awaitTaskCompletion(ref.task_key, projectId, {
      taskType: ref.task_type,
    });
    console.info('[audio-separate] task completed', completed.result);

    let { audio: audioOutputUrl, video: silentVideoOutputUrl } =
      classifyAudioSeparateResult(
        (completed.result ?? null) as Record<string, unknown> | null,
      );

    // Fallback: hit the dedicated job-result endpoint when SSE result didn't
    // carry the URLs (some freezone task types surface artifacts only via
    // /jobs/.../result).
    if (!audioOutputUrl || !silentVideoOutputUrl) {
      try {
        const jobResult = await fetchFreezoneAudioSeparateResult(projectId, ref.job_id);
        console.info('[audio-separate] job result', jobResult);
        const classified = classifyAudioSeparateResult(jobResult);
        audioOutputUrl = audioOutputUrl ?? classified.audio;
        silentVideoOutputUrl = silentVideoOutputUrl ?? classified.video;
      } catch (jobErr) {
        console.warn('[audio-separate] job result fetch failed', jobErr);
      }
    }

    if (!audioOutputUrl || !silentVideoOutputUrl) {
      console.warn('[audio-separate] could not resolve audio/video urls', {
        sseResult: completed.result,
      });
      return empty;
    }
    console.info('[audio-separate] resolved urls', {
      audioOutputUrl,
      silentVideoOutputUrl,
    });

    const audioTitle = `${baseName}_背景音`;
    const silentTitle = `${baseName}_无声`;

    const done = useCanvasStore.getState();
    const audioPos = done.findNodePosition(
      sourceNodeId,
      AUDIO_LAYOUT_WIDTH,
      AUDIO_LAYOUT_HEIGHT,
    );
    const audioNodeId = done.addNode(CANVAS_NODE_TYPES.audio, audioPos, {
      audioUrl: audioOutputUrl,
      sourceFileName: audioTitle,
      displayName: audioTitle,
    } as unknown as Parameters<typeof done.addNode>[2]);
    // 音频节点刻意不连回源视频：store 的上游白名单里 audio 只接受
    // textAnnotation 作为源（UPSTREAM_SOURCE_WHITELIST），video→audio 这条边
    // 建了也会被拒、静默失效——用户拍板不为此改白名单语义，音频节点只靠
    // findNodePosition 落在源节点附近，不建边。

    const silentPos = done.findNodePosition(
      sourceNodeId,
      SILENT_LAYOUT_WIDTH,
      SILENT_LAYOUT_HEIGHT,
    );
    const videoNodeId = done.addNode(CANVAS_NODE_TYPES.video, silentPos, {
      videoUrl: silentVideoOutputUrl,
      sourceFileName: `${silentTitle}.mp4`,
      displayName: silentTitle,
    } as unknown as Parameters<typeof done.addNode>[2]);
    done.addEdge(sourceNodeId, videoNodeId);

    return { audioNodeId, videoNodeId, error: null };
  } catch (error) {
    if (isTaskPollTimeoutError(error)) {
      console.warn('[audio-separate] detached from a still-running job', {
        taskKey: error.taskKey,
        idleMs: error.idleMs,
      });
      notifyTaskStillRunning();
      return empty;
    }
    console.error('[audio-separate] failed', error);
    return {
      audioNodeId: null,
      videoNodeId: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    useCanvasStore.getState().updateNodeData(sourceNodeId, { isSeparatingAv: false });
  }
}
