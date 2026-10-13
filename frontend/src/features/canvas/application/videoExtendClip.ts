// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';

/**
 * 「智能续写」截取前置视频的纯逻辑。
 *
 * 续写只截**一段**——那段是要喂给模型的「前情」，多段就说不清该从哪儿往后接。
 * 所以这里只有一个区间和它的两条硬边界：
 * - 下限 4s：Seedance 2.5 不收短于 4s 的视频素材。
 * - 上限 30s：同样是它对视频素材的时长上限。
 *
 * 这两条在拖拽时是「顶住」而不是「拒绝」——顶住的那一刻由 UI 弹出提示文案，
 * 用户才知道自己不是拖不动，而是到边了。
 */

/** `00:06`。超过一小时的素材极少，按 mm:ss 显示，分钟不截断。 */
export function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export const MIN_EXTEND_CLIP_MS = 4_000;
export const MAX_EXTEND_CLIP_MS = 30_000;

export interface ExtendClipRange {
  startMs: number;
  endMs: number;
}

/** 拖拽被哪条边界顶住了。null = 没顶住，不用提示。 */
export type ExtendClipBound = 'min' | 'max' | null;

export function extendClipBoundMessage(bound: ExtendClipBound): string | null {
  if (bound === 'min') {
    return i18n.t('canvas.videoExtend.boundMin', { seconds: MIN_EXTEND_CLIP_MS / 1000 });
  }
  if (bound === 'max') {
    return i18n.t('canvas.videoExtend.boundMax', { seconds: MAX_EXTEND_CLIP_MS / 1000 });
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 打开轨道时的默认选区：贴着**片尾**取最多 30s。
 *
 * 续写是从这段的结尾往后接，所以默认该给「最近发生的那 30 秒」；从片头取会把
 * 后半段直接丢掉，用户还得自己把整条选区拖到尾巴上。素材本身不足 30s 时退化成
 * 整条，与「整段都是前情」一致。
 */
export function defaultExtendRange(totalMs: number): ExtendClipRange {
  if (!(totalMs > 0)) return { startMs: 0, endMs: 0 };
  const length = Math.min(totalMs, MAX_EXTEND_CLIP_MS);
  return { startMs: Math.max(0, totalMs - length), endMs: totalMs };
}

/** 选区是否短到不能提交（素材本身就不足 4s 时也算——那条视频续写不了）。 */
export function isExtendRangeSubmittable(range: ExtendClipRange): boolean {
  const length = range.endMs - range.startMs;
  return length >= MIN_EXTEND_CLIP_MS && length <= MAX_EXTEND_CLIP_MS;
}

export type ExtendDragMode = 'start' | 'end' | 'move';

export interface ExtendDragAnchor {
  mode: ExtendDragMode;
  /** 按下瞬间的区间。move 靠它保持长度，start/end 靠它锁住不动的那一端。 */
  startAtDown: number;
  endAtDown: number;
  /** 按下瞬间指针对应的时间码，move 用它算位移。 */
  anchorMs: number;
}

export interface ExtendDragResult extends ExtendClipRange {
  /** 这一步是被哪条边界夹住的——UI 据此决定弹哪条提示。 */
  bound: ExtendClipBound;
}

/**
 * 把指针位置换算成新区间，并顺带报出「有没有被边界夹住」。
 *
 * 夹取顺序是有讲究的：先按 4s/30s 夹长度，再按 [0, totalMs] 夹位置。反过来做的话，
 * 把起点拖过片头时会先被 0 截断、长度悄悄变短，30s 的提示就永远弹不出来。
 */
export function resolveExtendRange(
  anchor: ExtendDragAnchor,
  pointerMs: number,
  totalMs: number,
): ExtendDragResult {
  if (anchor.mode === 'move') {
    const length = anchor.endAtDown - anchor.startAtDown;
    const startMs = clamp(
      anchor.startAtDown + (pointerMs - anchor.anchorMs),
      0,
      Math.max(0, totalMs - length),
    );
    // 整体平移不改长度，永远碰不到 4s/30s，只可能撞到轨道两头——那个不用提示。
    return { startMs, endMs: startMs + length, bound: null };
  }

  if (anchor.mode === 'start') {
    const end = anchor.endAtDown;
    const lowest = Math.max(0, end - MAX_EXTEND_CLIP_MS);
    const highest = Math.max(0, end - MIN_EXTEND_CLIP_MS);
    const startMs = clamp(pointerMs, lowest, highest);
    const bound: ExtendClipBound =
      pointerMs > highest ? 'min' : pointerMs < lowest && lowest > 0 ? 'max' : null;
    return { startMs, endMs: end, bound };
  }

  const start = anchor.startAtDown;
  const lowest = Math.min(start + MIN_EXTEND_CLIP_MS, totalMs);
  const highest = Math.min(start + MAX_EXTEND_CLIP_MS, totalMs);
  const endMs = clamp(pointerMs, lowest, highest);
  const bound: ExtendClipBound =
    pointerMs < lowest ? 'min' : pointerMs > highest && highest < totalMs ? 'max' : null;
  return { startMs: start, endMs, bound };
}

/**
 * 写进 prompt 最前面的固定前缀，如
 * `对 视频 (2) 的 00:00-00:04 片段进行续写：`。
 *
 * 前缀不进 `data.prompt`——它是这个节点的**身份**而不是用户写的内容，混进正文里
 * 用户一个退格就能删掉半句，模型收到的指令随之变成残句。它只在提交时拼到最终
 * prompt 的最前面，并在输入框里渲染成一枚不可编辑的 chip。
 */
export function extendPromptPrefix(sourceName: string, range: ExtendClipRange): string {
  const name = sourceName.trim() || i18n.t('canvas.videoExtend.defaultSourceName');
  return i18n.t('canvas.videoExtend.promptPrefix', {
    name,
    start: formatTimecode(range.startMs),
    end: formatTimecode(range.endMs),
  });
}

/**
 * 选区是否只是源视频的一部分——是的话提交前要把这一段真截出来再当参考素材。
 * 不截的话喂给模型的是整条源视频：既超出它对视频素材的时长上限（源 > 30s 时选哪段
 * 都会被拦），也让模型看到了选区之外的画面。选区就是整条时不必白转一遍。
 * 源时长未知时按「需要截」处理，宁可多转一次也不把超长素材发出去。
 */
export function extendRangeNeedsTrim(range: ExtendClipRange, sourceDurationMs: number | null): boolean {
  if (!(range.endMs > range.startMs)) return false;
  if (sourceDurationMs == null || !(sourceDurationMs > 0)) return true;
  return range.startMs > EXTEND_FULL_RANGE_TOLERANCE_MS
    || range.endMs < sourceDurationMs - EXTEND_FULL_RANGE_TOLERANCE_MS;
}

/** 选区贴边的容差：拖到头的选区和探测到的时长差个一两帧，不算「只选了一部分」。 */
const EXTEND_FULL_RANGE_TOLERANCE_MS = 50;

/**
 * 选区被真截出来之后提交用的前缀：模型拿到的片段从 0 秒开始，原视频里的时间码
 * 对它已经不成立，所以只说「对 X 进行续写」。输入框里的 chip 仍显示带时间码的
 * [[extendPromptPrefix]]——那是给用户看的「我选的是哪一段」。
 */
export function extendPromptPrefixTrimmed(sourceName: string): string {
  const name = sourceName.trim() || i18n.t('canvas.videoExtend.defaultSourceName');
  return i18n.t('canvas.videoExtend.promptPrefixTrimmed', { name });
}

/** 续写节点的名字：`续写 视频 (2)`。 */
export function extendNodeDisplayName(sourceName: string): string {
  const name = sourceName.trim() || i18n.t('canvas.videoExtend.defaultLabel');
  return i18n.t('canvas.videoExtend.nodeDisplayName', { name });
}
