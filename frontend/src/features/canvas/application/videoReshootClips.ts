// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 「片段重拍」时间轨道的纯逻辑：片段增删改 + 把时间码同步进 prompt。
 *
 * 全部是纯函数，UI（VideoReshootTimeline）只负责把手势换算成毫秒再调这里 ——
 * 重叠避让、最短时长、5 个上限这些规则一旦散进组件里就没法单测，而它们恰恰是
 * 最容易在拖拽边界上写错的部分。
 */

export interface VideoReshootClip {
  id: string;
  startMs: number;
  endMs: number;
}

/** 轨道最多截 5 个片段 —— 与节点上「n/5 个片段」的计数一致。 */
export const MAX_RESHOOT_CLIPS = 5;
/** 点击轨道时新片段的默认长度。 */
export const DEFAULT_RESHOOT_CLIP_MS = 4000;
/**
 * 单段下限 4s：这些片段最后是喂给 Seedance 2.5 的视频素材，它不收短于 4s 的视频。
 * 所以这里跟默认长度取同一个值 —— 点一下截出来的那段就已经是合法的最短片段，
 * 往里拖只会被顶住，不会拖出一段送上去才被拒的片段。
 */
export const MIN_RESHOOT_CLIP_MS = 4000;
/**
 * 所有片段时长加起来的上限 30s —— 同样是 Seedance 2.5 对视频素材的总量限制。
 * 5 段 × 4s 才 20s，所以这条只有在把片段拖长之后才会顶到。
 */
export const MAX_RESHOOT_TOTAL_MS = 30_000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function byStart(a: VideoReshootClip, b: VideoReshootClip): number {
  return a.startMs - b.startMs;
}

/** `00:06`。超过一小时的素材极少，按 mm:ss 显示，分钟不截断。 */
export function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** `4.0s`。片段块上的时长、以及轨道右侧的总时长都用它。 */
export function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 片段块上显示的时长，如 `4.0s`。 */
export function formatClipDuration(clip: VideoReshootClip): string {
  return formatSeconds(clip.endMs - clip.startMs);
}

/** 所有片段时长之和 —— 顶着 30s 上限的就是这个数。 */
export function totalReshootMs(clips: VideoReshootClip[]): number {
  return clips.reduce((sum, clip) => sum + (clip.endMs - clip.startMs), 0);
}

/**
 * 还能再截一段吗：片段数没满、且 30s 预算里还剩得下一段最短片段。
 * 轨道用它决定光标形状和是否响应按下，别在组件里重算一遍口径。
 */
export function canAddReshootClip(clips: VideoReshootClip[]): boolean {
  return (
    clips.length < MAX_RESHOOT_CLIPS &&
    MAX_RESHOOT_TOTAL_MS - totalReshootMs(clips) >= MIN_RESHOOT_CLIP_MS
  );
}

/** 写进 prompt 的片段引用，如 `00:01-00:06`。 */
export function clipTimecodeToken(clip: VideoReshootClip): string {
  return `${formatTimecode(clip.startMs)}-${formatTimecode(clip.endMs)}`;
}

/**
 * 轨道上未被占用的区间。片段互不重叠是这套交互的前提 —— 重叠的时间码写进
 * prompt 只会让模型收到自相矛盾的指令。
 */
function freeGaps(
  clips: VideoReshootClip[],
  totalMs: number,
): { startMs: number; endMs: number }[] {
  const gaps: { startMs: number; endMs: number }[] = [];
  let cursor = 0;
  for (const clip of [...clips].sort(byStart)) {
    if (clip.startMs - cursor >= MIN_RESHOOT_CLIP_MS) {
      gaps.push({ startMs: cursor, endMs: clip.startMs });
    }
    cursor = Math.max(cursor, clip.endMs);
  }
  if (totalMs - cursor >= MIN_RESHOOT_CLIP_MS) {
    gaps.push({ startMs: cursor, endMs: totalMs });
  }
  return gaps;
}

/**
 * 在 `atMs` 处截一个默认长度的片段。点击位置落在已有片段上、或右侧不够 4s 时，
 * 落到最近的空档里而不是拒绝 —— 用户点下去总该多出一块，位置差几百毫秒可以再拖。
 * 返回 null 表示确实放不下（满 5 个、30s 预算不够再来一段、或已无 ≥4s 的空档）。
 */
export function addReshootClip(
  clips: VideoReshootClip[],
  atMs: number,
  totalMs: number,
  makeId: () => string,
): VideoReshootClip[] | null {
  if (!canAddReshootClip(clips)) return null;
  if (!(totalMs > 0)) return null;

  const gaps = freeGaps(clips, totalMs);
  if (gaps.length === 0) return null;

  // 命中哪个空档：包含点击点的优先，否则取离点击点最近的那个。gaps 已按时间升序，
  // 比较用 `<=` 是为了让「点在已有片段正中间」这种等距情况向右顺延 —— 新片段冒在
  // 点击处右边，比忽然跳回轨道开头更符合预期。
  const target =
    gaps.find((gap) => atMs >= gap.startMs && atMs < gap.endMs) ??
    gaps.reduce((best, gap) => {
      const distance = Math.min(
        Math.abs(atMs - gap.startMs),
        Math.abs(atMs - gap.endMs),
      );
      const bestDistance = Math.min(
        Math.abs(atMs - best.startMs),
        Math.abs(atMs - best.endMs),
      );
      return distance <= bestDistance ? gap : best;
    });

  const gapLength = target.endMs - target.startMs;
  // 预算也参与取小：默认长度目前正好等于下限，但哪天默认调长了，最后一段也不该
  // 把总时长顶出 30s。
  const length = Math.min(
    DEFAULT_RESHOOT_CLIP_MS,
    gapLength,
    MAX_RESHOOT_TOTAL_MS - totalReshootMs(clips),
  );
  // 以点击点为起点，右侧不够就整体左移贴住空档尾部。
  const startMs = clamp(
    atMs >= target.startMs && atMs < target.endMs ? atMs : target.startMs,
    target.startMs,
    target.endMs - length,
  );

  return [
    ...clips,
    { id: makeId(), startMs: Math.round(startMs), endMs: Math.round(startMs + length) },
  ].sort(byStart);
}

/**
 * 拖片段两端。边界依次受：视频时长、相邻片段、最短时长、30s 总预算约束 ——
 * 拖过头是夹住而不是拒绝，手感上「推不动」比「突然跳回」好。
 */
export function resizeReshootClip(
  clips: VideoReshootClip[],
  id: string,
  edge: 'start' | 'end',
  ms: number,
  totalMs: number,
): VideoReshootClip[] {
  const sorted = [...clips].sort(byStart);
  const index = sorted.findIndex((clip) => clip.id === id);
  if (index < 0) return clips;

  const current = sorted[index];
  const prev = sorted[index - 1];
  const next = sorted[index + 1];

  // 这一段还能拉多长：30s 减去别的片段已经占掉的。兜底到下限是防守 —— 万一存量
  // 数据本来就超预算，也不能反过来把这段夹成 0 长度。
  const maxLengthMs = Math.max(
    MIN_RESHOOT_CLIP_MS,
    MAX_RESHOOT_TOTAL_MS - (totalReshootMs(sorted) - (current.endMs - current.startMs)),
  );

  if (edge === 'start') {
    const startMs = clamp(
      ms,
      Math.max(prev ? prev.endMs : 0, current.endMs - maxLengthMs),
      current.endMs - MIN_RESHOOT_CLIP_MS,
    );
    sorted[index] = { ...current, startMs: Math.round(startMs) };
  } else {
    const endMs = clamp(
      ms,
      current.startMs + MIN_RESHOOT_CLIP_MS,
      Math.min(next ? next.startMs : totalMs, current.startMs + maxLengthMs),
    );
    sorted[index] = { ...current, endMs: Math.round(endMs) };
  }
  return sorted;
}

export function removeReshootClip(
  clips: VideoReshootClip[],
  id: string,
): VideoReshootClip[] {
  return clips.filter((clip) => clip.id !== id);
}

/** 把 token 连同它孤零零留下的那个换行一起摘掉，别在 prompt 里留空行。 */
function dropToken(prompt: string, token: string): string {
  const index = prompt.indexOf(token);
  if (index < 0) return prompt;
  const before = prompt.slice(0, index);
  const after = prompt.slice(index + token.length);
  if (before.endsWith('\n')) return before.slice(0, -1) + after;
  if (after.startsWith('\n')) return before + after.slice(1);
  return before + after;
}

function appendToken(prompt: string, token: string): string {
  const trimmed = prompt.replace(/\s+$/, '');
  return trimmed ? `${trimmed}\n${token}` : token;
}

/**
 * 片段变动同步回 prompt：新增追加时间码、删除摘掉、拖动改写。用户在时间轨道上
 * 截的片段就是要交给模型的指令，多一步「手动引用」只会让人忘记引用。
 *
 * 只按 id 差分、逐 token 改写，不整体重生成 —— prompt 里用户自己写的话
 * （「把黄色台灯换成白色台灯」）必须原样保留。
 */
export function syncReshootPrompt(
  prompt: string,
  prevClips: VideoReshootClip[],
  nextClips: VideoReshootClip[],
): string {
  const prevById = new Map(prevClips.map((clip) => [clip.id, clip]));
  const nextById = new Map(nextClips.map((clip) => [clip.id, clip]));
  let result = prompt;

  for (const clip of prevClips) {
    if (!nextById.has(clip.id)) {
      result = dropToken(result, clipTimecodeToken(clip));
    }
  }
  for (const clip of nextClips) {
    const before = prevById.get(clip.id);
    const token = clipTimecodeToken(clip);
    if (!before) {
      result = appendToken(result, token);
      continue;
    }
    const previousToken = clipTimecodeToken(before);
    if (previousToken !== token && result.includes(previousToken)) {
      result = result.replace(previousToken, token);
    }
  }
  return result;
}

/**
 * 反向同步：prompt 里被用户手动删掉的时间码，对应的片段也从轨道上撤掉。
 *
 * 时间码 chip 上有个 ×，退格也能把整块吃掉 —— 两条路都只改 prompt，不经过轨道。
 * 不撤的话轨道上那段还在，用户一拖它又把时间码写回去，等于删不掉。
 *
 * 没有任何片段需要撤时**原样返回入参数组**，调用方靠引用相等就能判断「无事发生」，
 * 不会每次 prompt 变动都写一次 store。
 */
export function pruneReshootClipsByPrompt(
  prompt: string,
  clips: VideoReshootClip[],
): VideoReshootClip[] {
  const kept = clips.filter((clip) => prompt.includes(clipTimecodeToken(clip)));
  return kept.length === clips.length ? clips : kept;
}
