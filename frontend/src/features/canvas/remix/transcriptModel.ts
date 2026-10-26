import type { TranscriptSegment, TranscriptWord } from '@/features/canvas/domain/canvasNodes';
import type { RemixArtifactRef } from '@/api/remix';
import { projectMediaPathFromUrl } from './remixMediaPath';

export interface TranscriptSource {
  path: string;
  url?: string;
  kind: 'audio' | 'video';
}

type SourceNode = { id: string; data: Record<string, unknown> };
type SourceEdge = { source: string; target: string };

/** Only project-local remix media can be sent to the transcription worker. */
export function sourceMediaForTranscript(nodeId: string, nodes: SourceNode[] = [], edges: SourceEdge[] = []): TranscriptSource | null {
  const sources = new Set(edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source));
  const connected = nodes.filter((node) => sources.has(node.id)).map((node) => node.data.remixMedia).filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object'));
  const media = connected.find((item) => item.media_kind === 'audio' && typeof item.media_path === 'string')
    ?? connected.find((item) => item.media_kind === 'video' && item.has_audio === true && typeof item.media_path === 'string');
  if (!media) {
    const saved = nodes.find(node => node.id === nodeId)?.data;
    if (typeof saved?.sourceMediaPath === 'string' && saved.sourceMediaPath
      && typeof saved.sourceMediaHash === 'string' && saved.sourceMediaHash
      && typeof saved.sourceVideoUrl === 'string' && saved.sourceVideoUrl
      && typeof saved.sourceProjectId === 'string' && saved.sourceProjectId
      && projectMediaPathFromUrl(saved.sourceProjectId, saved.sourceVideoUrl) === saved.sourceMediaPath
      && nodes.some(node => sources.has(node.id) && node.data.videoUrl === saved.sourceVideoUrl)) {
      return { path: saved.sourceMediaPath, url: saved.sourceVideoUrl, kind: 'video' };
    }
    return null;
  }
  return { path: media.media_path as string, url: typeof media.url === 'string' ? media.url : undefined, kind: media.media_kind as 'audio' | 'video' };
}

export function sourceScriptForTranscript(nodeId: string, nodes: SourceNode[] = [], edges: SourceEdge[] = []): RemixArtifactRef | null {
  const sources = new Set(edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source));
  for (const node of nodes) {
    if (!sources.has(node.id)) continue;
    const ref = node.data.remixScriptRef;
    if (ref && typeof ref === 'object' && 'artifactId' in ref && 'revision' in ref
      && typeof ref.artifactId === 'string' && Number.isInteger(ref.revision) && (ref.revision as number) > 0) {
      return { artifactId: ref.artifactId, revision: ref.revision as number };
    }
  }
  return null;
}

interface TimelineWord extends Record<string, unknown> {
  text: string;
  start_us: number;
  end_us: number;
}

interface TimelineSegment extends Record<string, unknown> {
  text: string;
  start_us: number;
  end_us: number;
}

export interface TranscriptTimeline extends Record<string, unknown> {
  status: string;
  words: TimelineWord[];
  segments?: TimelineSegment[] | null;
  transcript?: string | null;
  mismatch?: SpeechMismatch | null;
  match_report?: SpeechMatchReport | null;
}

interface SpeechTextRange { text?: unknown; start_char?: unknown; end_char?: unknown }
interface SpeechDifference { script_range?: SpeechTextRange; asr_range?: SpeechTextRange }
export interface SpeechMatchReport {
  substitutions?: unknown;
  insertions?: unknown;
  omissions?: unknown;
  character_coverage?: unknown;
}
export interface SpeechMismatch {
  reason?: unknown;
  report?: SpeechMatchReport | null;
  untimed_script_ranges?: unknown;
}

function differences(value: unknown): SpeechDifference[] {
  return Array.isArray(value) ? value.filter((item): item is SpeechDifference => Boolean(item && typeof item === 'object')) : [];
}

function rangeText(value: SpeechTextRange | undefined): string {
  return typeof value?.text === 'string' ? value.text : '';
}

/** Turn backend comparison evidence into compact review rows without trusting ASR as truth. */
export function speechReviewItems(mismatch: SpeechMismatch | null | undefined, successfulReport?: SpeechMatchReport | null): string[] {
  const report = mismatch?.report ?? successfulReport;
  const untimed = Array.isArray(mismatch?.untimed_script_ranges)
    ? mismatch.untimed_script_ranges.filter((item): item is SpeechTextRange => Boolean(item && typeof item === 'object')) : [];
  return [
    ...differences(report?.substitutions).map((item) => `可能替换：${rangeText(item.script_range)} → ${rangeText(item.asr_range)}（ASR 低置信度）`),
    ...differences(report?.omissions).map((item) => `缺少：${rangeText(item.script_range)}`),
    ...differences(report?.insertions).map((item) => `可能多读：${rangeText(item.asr_range)}（ASR 低置信度）`),
    ...untimed.map((item) => `未对齐：${rangeText(item)}（脚本字符 ${String(item.start_char)}–${String(item.end_char)}）`),
  ];
}

export class RealignmentRequiredError extends Error {
  constructor() { super('修改可能改变发音或词边界，需要重新对齐'); this.name = 'RealignmentRequiredError'; }
}

export function timelineWords(payload: TranscriptTimeline): TranscriptWord[] {
  if (payload.status !== 'completed' || !Array.isArray(payload.words)) return [];
  return payload.words.filter((word) => typeof word.text === 'string' && Number.isFinite(word.start_us) && Number.isFinite(word.end_us))
    .map((word) => ({ text: word.text, startUs: word.start_us, endUs: word.end_us,
      startChar: Number.isInteger(word.start_char) ? Number(word.start_char) : undefined,
      endChar: Number.isInteger(word.end_char) ? Number(word.end_char) : undefined,
      confidence: typeof word.confidence === 'number' ? word.confidence : null }));
}

/**
 * Provider sentence boundaries. Empty when the artifact predates segment capture,
 * so callers fall back to the plain transcript instead of inventing sentences.
 */
export function timelineSegments(payload: TranscriptTimeline): TranscriptSegment[] {
  if (payload.status !== 'completed' || !Array.isArray(payload.segments)) return [];
  return payload.segments
    .filter((segment) => typeof segment?.text === 'string' && segment.text.trim()
      && Number.isFinite(segment.start_us) && Number.isFinite(segment.end_us) && segment.end_us > segment.start_us)
    .map((segment) => ({ text: segment.text, startUs: segment.start_us, endUs: segment.end_us }))
    // A provider can emit a boundary that runs backwards; keep reading order.
    .sort((left, right) => left.startUs - right.startUs);
}

export interface SegmentWordGroup {
  segment: TranscriptSegment;
  /** Global word index is kept so a correction still targets the whole timeline. */
  words: Array<{ word: TranscriptWord; index: number }>;
}

/**
 * Split words into the provider's sentences. A word is assigned by its midpoint
 * so a boundary that lands inside a word cannot drop it from both sentences;
 * words falling in a gap go to the closest sentence instead of a fixed end.
 */
export function segmentWordGroups(segments: TranscriptSegment[], words: TranscriptWord[]): SegmentWordGroup[] {
  if (!segments.length) return [];
  const groups: SegmentWordGroup[] = segments.map((segment) => ({ segment, words: [] }));
  words.forEach((word, index) => {
    const midpoint = word.startUs + Math.max(0, word.endUs - word.startUs) / 2;
    let target = groups.findIndex(({ segment }) => midpoint >= segment.startUs && midpoint < segment.endUs);
    if (target < 0) {
      let nearest = Infinity;
      groups.forEach(({ segment }, position) => {
        const distance = midpoint < segment.startUs ? segment.startUs - midpoint : midpoint - segment.endUs;
        if (distance < nearest) { nearest = distance; target = position; }
      });
    }
    groups[target].words.push({ word, index });
  });
  return groups;
}

/** Recover visible word boundaries in transcripts saved by the old NewAPI adapter. */
export function readableTranscript(text: string, words: TranscriptWord[]): string {
  if (words.length < 2 || text !== words.map((word) => word.text).join('')) return text;
  if (!words.some((word) => /^[A-Za-z0-9][A-Za-z0-9'’\-]+$/u.test(word.text))) return text;
  let result = words[0].text;
  for (let index = 1; index < words.length; index += 1) {
    const previous = words[index - 1];
    const current = words[index];
    const bothSingleLetters = /^[A-Za-z0-9]$/u.test(previous.text) && /^[A-Za-z0-9]$/u.test(current.text);
    const sameCharacterRun = bothSingleLetters && current.startUs - previous.endUs <= 50_000;
    if (!sameCharacterRun && /[A-Za-z0-9,.;:!?]$/u.test(previous.text) && /^[A-Za-z0-9]/u.test(current.text)) result += ' ';
    result += current.text;
  }
  return result;
}

/** Keep the transcript's punctuation and spaces while making matched words seekable. */
export function transcriptPlaybackParts(text: string, words: TranscriptWord[]): Array<{ text: string; startUs?: number; endUs?: number }> {
  const parts: Array<{ text: string; startUs?: number; endUs?: number }> = [];
  const utf16Offsets = [0];
  for (const character of text) utf16Offsets.push(utf16Offsets[utf16Offsets.length - 1] + character.length);
  let cursor = 0;
  for (const word of words) {
    const spanStart = word.startChar === undefined ? undefined : utf16Offsets[word.startChar];
    const spanEnd = word.endChar === undefined ? undefined : utf16Offsets[word.endChar];
    let position = spanStart !== undefined && spanEnd !== undefined
      && text.slice(spanStart, spanEnd) === word.text ? spanStart : -1;
    if (position < cursor) position = -1;
    if (position < 0) {
      position = text.indexOf(word.text, cursor);
      while (position >= 0 && ((/^[A-Za-z0-9]/u.test(word.text) && /[A-Za-z0-9]/u.test(text[position - 1] ?? ''))
        || (/[A-Za-z0-9]$/u.test(word.text) && /[A-Za-z0-9]/u.test(text[position + word.text.length] ?? '')))) {
        position = text.indexOf(word.text, position + 1);
      }
    }
    if (position < 0) return [{ text }];
    if (position > cursor) parts.push({ text: text.slice(cursor, position) });
    parts.push({ text: word.text, startUs: word.startUs, endUs: word.endUs });
    cursor = position + word.text.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });

  // A transcript forced through a CJK language hint can contain one timed
  // entry per Latin character. Keep that artifact editable as-is, but merge
  // adjacent Latin fragments for playback so the visible highlight follows
  // a whole spoken word rather than a single letter.
  const merged: typeof parts = [];
  let trailingLatinCharacterRun = false;
  for (const part of parts) {
    const previous = merged[merged.length - 1];
    const isTimed = part.startUs !== undefined && part.endUs !== undefined;
    const previousIsTimed = previous?.startUs !== undefined && previous.endUs !== undefined;
    const isSingleLatinCharacter = /^[A-Za-z0-9'’\-]$/u.test(part.text);
    if (isTimed && previousIsTimed && trailingLatinCharacterRun && isSingleLatinCharacter) {
      previous.text += part.text;
      previous.endUs = part.endUs;
    } else {
      merged.push({ ...part });
    }
    trailingLatinCharacterRun = isTimed && isSingleLatinCharacter;
  }
  return merged;
}

/** Keep word timing but regenerate character offsets for a corrected transcript. */
export function correctedTimeline(payload: TranscriptTimeline, correctedWords: string[], confirmedSameSpeechAndBoundaries: boolean): TranscriptTimeline {
  if (payload.status !== 'completed' || correctedWords.length !== payload.words.length) throw new Error('转写内容已变化，请重新加载');
  const source = typeof payload.transcript === 'string' ? payload.transcript : payload.words.map((word) => word.text).join('');
  let sourceOffset = 0;
  let revisedText = '';
  const words = payload.words.map((word, index) => {
    const text = correctedWords[index]?.trim();
    if (!text) throw new Error('字词不能为空');
    const changed = text !== word.text;
    const sameLength = Array.from(text).length === Array.from(word.text).length;
    const singleLatinWordCorrection = /^[A-Za-z]+[.,!?]?$/u.test(text)
      && /^[A-Za-z]+[.,!?]?$/u.test(word.text)
      && (text.match(/[.,!?]$/u)?.[0] ?? '') === (word.text.match(/[.,!?]$/u)?.[0] ?? '');
    if (changed && (!confirmedSameSpeechAndBoundaries || (!sameLength && !singleLatinWordCorrection) || /\s/u.test(text))) {
      throw new RealignmentRequiredError();
    }
    const sourceStart = Number.isInteger(word.start_char) ? Number(word.start_char) : sourceOffset;
    const sourceEnd = Number.isInteger(word.end_char) ? Number(word.end_char) : sourceStart + word.text.length;
    if (sourceStart < sourceOffset || sourceEnd > source.length || source.slice(sourceStart, sourceEnd) !== word.text) throw new Error('转写内容已变化，请重新加载');
    revisedText += source.slice(sourceOffset, sourceStart);
    const start = revisedText.length;
    revisedText += text;
    sourceOffset = sourceEnd;
    return { ...word, text, start_char: start, end_char: revisedText.length, ...(changed ? { timing_status: 'manually_verified', original_text: word.text } : {}) };
  });
  revisedText += source.slice(sourceOffset);
  return { ...payload, transcript: revisedText, words, manual_timing_review: words.some((word) => word.timing_status === 'manually_verified') };
}

function srtTime(us: number): string {
  const ms = Math.max(0, Math.floor(us / 1_000));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor(ms / 60_000) % 60;
  const seconds = Math.floor(ms / 1_000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(ms % 1_000).padStart(3, '0')}`;
}

export function transcriptSrt(words: TranscriptWord[]): string {
  return words.map((word, index) => `${index + 1}\n${srtTime(word.startUs)} --> ${srtTime(word.endUs)}\n${word.text}\n`).join('\n');
}
