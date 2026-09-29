// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

export type VideoPromptSplitErrorCode =
  | 'noTimeline' | 'missingTiming' | 'ambiguousTiming' | 'alreadyShort'
  | 'shotTooLong' | 'tooLong' | 'busy' | 'unsupported' | 'multipleTimelines';

export class VideoPromptSplitError extends Error {
  constructor(public readonly code: VideoPromptSplitErrorCode) {
    super(code);
  }
}

export interface VideoPromptSegment {
  prompt: string;
  startSec: number;
  endSec: number;
  durationSec: number;
}

export interface VideoPromptSplitPlan {
  segments: VideoPromptSegment[];
  totalDurationSec: number;
}

export interface VideoPromptSplitMetadata {
  sourceNodeId: string;
  originalName: string;
  index: number;
  count: number;
  startSec: number;
  endSec: number;
  totalDurationSec: number;
  upstreamTextOverrides?: Record<string, string>;
}

export function videoSplitTextOverrides(data: Record<string, unknown>): Record<string, string> {
  const metadata = data.videoPromptSplit as VideoPromptSplitMetadata | undefined;
  const values = metadata?.upstreamTextOverrides;
  if (!values || typeof values !== 'object') return {};
  return Object.fromEntries(Object.entries(values).filter(([, text]) => typeof text === 'string'));
}

// Only structural headings are parsed. Numbers in dialogue, lens lengths and
// descriptions must never turn into accidental cuts.
const SHOT_HEADING = /^[\t ]*(?:#{1,6}[\t ]*)?(?:[【\[][\t ]*)?(?:镜头|分镜|shot|scene)[\t ]*[\d一二三四五六七八九十百]+[^\r\n]*/gim; // i18n-exempt: Chinese source-prompt grammar.
const RANGE = /(\d{1,3}:\d{2}(?:\.\d+)?|\d+(?:\.\d+)?)([\t ]*(?:秒|seconds?|secs?|s)?[\t ]*[-–—~～至][\t ]*)(\d{1,3}:\d{2}(?:\.\d+)?|\d+(?:\.\d+)?)([\t ]*(?:秒|seconds?|secs?|s))?/i; // i18n-exempt: Chinese source-prompt grammar.
const TIME_HEADING = /^[\t ]*(?:#{1,6}[\t ]*|[-*•][\t ]*)?[【\[(（]?(?:\d{1,3}:\d{2}(?:\.\d+)?|\d+(?:\.\d+)?)[\t ]*(?:秒|seconds?|secs?|s)?[\t ]*[-–—~～至][^\r\n]*/gim; // i18n-exempt: Chinese source-prompt grammar.
const DURATION = /^[\t ]*(?:\*\*)?(?:镜头时长|时长|duration)[\t ]*[:：][\t ]*(?:\*\*)?(\d+(?:\.\d+)?)[\t ]*(?:秒|seconds?|secs?|s)/im; // i18n-exempt: Chinese source-prompt grammar.

type Timing = { start: number; end: number; original: string; range?: RegExpMatchArray };
type Shot = { text: string; startMs: number; endMs: number; timing: Timing };

function milliseconds(value: string): number {
  const pieces = value.split(':').map(Number);
  if (pieces.length === 2 && pieces[1] >= 60) throw new VideoPromptSplitError('ambiguousTiming');
  return Math.round((pieces.length === 2 ? pieces[0] * 60 + pieces[1] : pieces[0]) * 1000);
}

function formatSeconds(value: number, exemplar = ''): string {
  const precision = exemplar.includes('.') ? exemplar.split('.')[1].length : 0;
  const needed = String(Number(value.toFixed(3))).split('.')[1]?.length ?? 0;
  return value.toFixed(Math.max(precision, needed));
}

function formatTime(ms: number, exemplar: string): string {
  if (!exemplar.includes(':')) return formatSeconds(ms / 1000, exemplar);
  const minutes = Math.floor(ms / 60000);
  const seconds = formatSeconds((ms % 60000) / 1000, exemplar.split(':')[1]);
  return `${String(minutes).padStart(exemplar.split(':')[0].length, '0')}:${seconds.padStart(seconds.includes('.') ? 3 + seconds.split('.')[1].length : 2, '0')}`;
}

function headings(prompt: string): RegExpMatchArray[] {
  const shots = [...prompt.matchAll(new RegExp(SHOT_HEADING))];
  return shots.length ? shots : [...prompt.matchAll(new RegExp(TIME_HEADING))];
}

export function hasVideoPromptTimeline(prompt: string): boolean {
  return headings(prompt).length > 0;
}

function readShot(text: string, cursorMs: number): Shot {
  const firstLine = text.split(/\r?\n/, 1)[0];
  const rangeLine = firstLine.match(RANGE)
    ? { text: firstLine, offset: 0 }
    : (() => {
      const line = /^(?:[\t ]*)(?:时间|时间段|时间范围|time)[\t ]*[:：][^\r\n]+/im.exec(text); // i18n-exempt: Chinese source-prompt grammar.
      return line ? { text: line[0], offset: line.index } : null;
    })();
  const range = rangeLine?.text.match(RANGE);
  if (range && (/[秒s:]/i.test(range[0]))) { // i18n-exempt: Chinese source-prompt grammar.
    const startMs = milliseconds(range[1]);
    const endMs = milliseconds(range[3]);
    if (startMs !== cursorMs || endMs <= startMs) throw new VideoPromptSplitError('ambiguousTiming');
    const start = rangeLine!.offset + range.index!;
    return { text, startMs, endMs, timing: { start, end: start + range[0].length, original: range[0], range } };
  }
  const declared = DURATION.exec(text);
  const inline = !declared ? /(?:时长[\t ]*[:：]?[\t ]*)?(\d+(?:\.\d+)?)[\t ]*(?:秒|seconds?|secs?|s)(?=[）)\]】])/i.exec(firstLine) : null; // i18n-exempt: Chinese source-prompt grammar.
  const match = declared ?? inline;
  if (!match) throw new VideoPromptSplitError('missingTiming');
  const value = match[1];
  const duration = milliseconds(value);
  if (duration <= 0) throw new VideoPromptSplitError('ambiguousTiming');
  const start = match.index + match[0].indexOf(value);
  return { text, startMs: cursorMs, endMs: cursorMs + duration, timing: { start, end: start + value.length, original: value } };
}

function patchTotal(text: string, seconds: number): string {
  return text.replace(/((?:总时长|视频总时长|视频时长|total duration)[\t ]*[:：][\t ]*)(\d+(?:\.\d+)?)([\t ]*(?:秒|seconds?|secs?|s))/gi, // i18n-exempt: Chinese source-prompt grammar.
    (_match, prefix: string, value: string, unit: string) => `${prefix}${formatSeconds(seconds, value)}${unit}`);
}

/** Whole shots stay intact so actions and dialogue are never cut mid-shot. */
export function splitTimedVideoPrompt(
  prompt: string,
  limitSeconds = 15,
): VideoPromptSplitPlan {
  const markers = headings(prompt);
  if (!markers.length) throw new VideoPromptSplitError('noTimeline');
  const prefix = prompt.slice(0, markers[0].index);
  let suffix = '';
  let cursor = 0;
  const shots = markers.map((marker, index) => {
    let text = prompt.slice(marker.index!, markers[index + 1]?.index ?? prompt.length);
    if (index === markers.length - 1) {
      const common = /^[\t ]*(?:#{1,6}[\t ]*)?(?:【)?(?:全局要求|统一要求|共用说明|通用要求|负面提示词|negative prompt)[^\r\n]*/im.exec(text); // i18n-exempt: Chinese source-prompt grammar.
      if (common) { suffix = text.slice(common.index); text = text.slice(0, common.index); }
    }
    const shot = readShot(text, cursor);
    cursor = shot.endMs;
    return shot;
  });
  const limitMs = Math.round(limitSeconds * 1000);
  if (!Number.isFinite(limitMs) || limitMs <= 0 || cursor > limitMs * 64) throw new VideoPromptSplitError('tooLong');
  if (shots.some((shot) => shot.endMs - shot.startMs > limitMs)) {
    throw new VideoPromptSplitError('shotTooLong');
  }
  if (cursor <= limitMs) throw new VideoPromptSplitError('alreadyShort');
  const groups: Shot[][] = [];
  let group: Shot[] = [];
  for (const shot of shots) {
    if (group.length && shot.endMs - group[0].startMs > limitMs) {
      groups.push(group);
      group = [];
    }
    group.push(shot);
  }
  if (group.length) groups.push(group);
  if (groups.length > 64) throw new VideoPromptSplitError('tooLong');
  const segments = groups.map((members): VideoPromptSegment => {
    const startMs = members[0].startMs;
    const endMs = members[members.length - 1].endMs;
    const parts = members.map((shot) => {
      const timing = shot.timing;
      if (!timing.range) return shot.text;
      // Rebase explicit timeline labels; shot durations and prose stay verbatim.
      const range = timing.range;
      const replacement = `${formatTime(shot.startMs - startMs, range[1])}${range[2]}${formatTime(shot.endMs - startMs, range[3])}${range[4] ?? ''}`;
      return shot.text.slice(0, timing.start) + replacement + shot.text.slice(timing.end);
    });
    const durationSec = (endMs - startMs) / 1000;
    return {
      prompt: patchTotal(prefix, durationSec) + parts.join('') + patchTotal(suffix, durationSec),
      startSec: startMs / 1000, endSec: endMs / 1000, durationSec,
    };
  });
  return { segments, totalDurationSec: cursor / 1000 };
}
