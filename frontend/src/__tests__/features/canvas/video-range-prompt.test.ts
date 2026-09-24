// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  buildContinuationPrompt,
  buildEditSegments,
  buildRemakePrompt,
  formatRangeDurationLabel,
  getInsertableRemakeGaps,
  getRemakeGaps,
  initialContinuationRange,
  insertRemakeRange,
  isContinuationBindingValid,
  isContinuationRangeSupported,
  isRemakeSourceDurationSupported,
  prepareRemakeRangesForSubmission,
  resizeRemakeRange,
  validateRemakeRanges,
  SEGMENT_REMAKE_MAX_RANGES,
  SEGMENT_REMAKE_MIN_GAP_SEC,
  SEGMENT_REMAKE_MIN_RANGE_SEC,
} from '@/features/canvas/application/videoRangePrompt';

const r = (id: string, startSec: number, endSec: number, intent?: string) => ({
  id, startSec, endSec, intent,
});

describe('validateRemakeRanges', () => {
  it('accepts well-spaced ranges', () => {
    const result = validateRemakeRanges({
      ranges: [r('a', 5, 9), r('b', 14, 18)],
      sourceDurationSec: 30,
    });
    expect(result.ok).toBe(true);
    expect(result.sorted.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('rejects a source shorter than the model minimum', () => {
    const result = validateRemakeRanges({ ranges: [], sourceDurationSec: 3 });
    expect(result.rejections).toContainEqual({ code: 'source_too_short', minSec: 4 });
    expect(isRemakeSourceDurationSupported(3.99)).toBe(false);
    expect(isRemakeSourceDurationSupported(4)).toBe(true);
  });

  it('rejects a leftover sliver too short to stand on its own', () => {
    // 0-4 重拍，剩下 4-5 只有 1 秒，既不能重拍也接不回去。
    const result = validateRemakeRanges({
      ranges: [r('a', 0, 4)],
      sourceDurationSec: 5,
    });
    expect(result.rejections).toContainEqual({
      code: 'gap_too_short',
      minSec: SEGMENT_REMAKE_MIN_GAP_SEC,
    });
  });

  it('rejects a range shorter than the model minimum', () => {
    const result = validateRemakeRanges({
      ranges: [r('a', 0, 3.5)],
      sourceDurationSec: 30,
    });
    expect(result.rejections).toContainEqual({
      code: 'range_too_short',
      minSec: SEGMENT_REMAKE_MIN_RANGE_SEC,
    });
  });

  it('rejects a range longer than the model maximum', () => {
    const result = validateRemakeRanges({
      ranges: [r('a', 0, 31)],
      sourceDurationSec: 60,
    });
    expect(result.rejections).toContainEqual({ code: 'range_too_long', maxSec: 30 });
  });

  it('rejects overlapping ranges', () => {
    const result = validateRemakeRanges({
      ranges: [r('a', 0, 10), r('b', 8, 15)],
      sourceDurationSec: 40,
    });
    expect(result.rejections).toContainEqual({ code: 'ranges_overlap' });
  });

  it('rejects a range past the end of the source', () => {
    const result = validateRemakeRanges({
      ranges: [r('a', 5, 60)],
      sourceDurationSec: 30,
    });
    expect(result.rejections).toContainEqual({ code: 'range_out_of_bounds' });
  });

  it('reports every problem at once rather than the first', () => {
    const result = validateRemakeRanges({
      ranges: [r('a', 0, 10), r('b', 8, 15)],
      sourceDurationSec: 3,
    });
    expect(result.rejections.length).toBeGreaterThan(1);
  });

  it('sorts by time regardless of the order the user drew them', () => {
    const result = validateRemakeRanges({
      ranges: [r('b', 14, 18), r('a', 5, 9)],
      sourceDurationSec: 30,
    });
    expect(result.sorted.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('survives the float arithmetic that decimal seconds invite', () => {
    // 0.1+0.2 那类误差：4.2-0.2 在浮点里不是 4.0，用秒直接比较会误判为不足 4 秒。
    const result = validateRemakeRanges({
      ranges: [r('a', 0.2, 4.2)],
      sourceDurationSec: 20,
    });
    expect(result.rejections).not.toContainEqual(
      expect.objectContaining({ code: 'range_too_short' }),
    );
  });
});

describe('gaps', () => {
  it('reports head, middle and tail gaps', () => {
    expect(getRemakeGaps([r('a', 5, 9), r('b', 14, 18)], 30)).toEqual([
      { startSec: 0, endSec: 5 },
      { startSec: 9, endSec: 14 },
      { startSec: 18, endSec: 30 },
    ]);
  });

  it('hides gaps too small to host a range', () => {
    expect(getInsertableRemakeGaps([r('a', 0, 4)], 6)).toEqual([]);
    expect(getInsertableRemakeGaps([r('a', 0, 4)], 20)).toEqual([
      { startSec: 4, endSec: 20 },
    ]);
  });
});

describe('insertRemakeRange', () => {
  const insert = (ranges: ReturnType<typeof r>[], atSec: number, sourceDurationSec: number) =>
    insertRemakeRange({ ranges, atSec, sourceDurationSec, id: 'new' });

  it('centres a default-length range on the click', () => {
    expect(insert([], 10, 40)).toEqual([
      { id: 'new', startSec: 7.5, endSec: 12.5, intent: '' },
    ]);
  });

  it('takes the whole gap when what would be left cannot stand alone', () => {
    // 6 秒的空隙放一段 5 秒，剩 1 秒的碎片——与其点一下就错，不如整段吃掉。
    expect(insert([], 3, 6)).toEqual([
      { id: 'new', startSec: 0, endSec: 6, intent: '' },
    ]);
  });

  it('snaps to the gap edge rather than leaving a sliver in front', () => {
    const [range] = insert([], 1, 40);
    expect(range.startSec).toBe(0);
    expect(range.endSec).toBe(5);
  });

  it('refuses once the range budget is spent', () => {
    const full = Array.from({ length: SEGMENT_REMAKE_MAX_RANGES }, (_, index) =>
      r(`r${index}`, index * 10, index * 10 + 5),
    );
    expect(insert(full, 55, 200)).toHaveLength(SEGMENT_REMAKE_MAX_RANGES);
  });

  it('ignores a click that lands inside an existing range', () => {
    expect(insert([r('a', 0, 10)], 5, 40)).toHaveLength(1);
  });
});

describe('resizeRemakeRange', () => {
  const ranges = [r('a', 10, 20), r('b', 30, 40)];

  it('keeps a dragged edge inside the neighbouring ranges', () => {
    const next = resizeRemakeRange({
      ranges, id: 'b', edge: 'start', valueSec: 15, sourceDurationSec: 60,
    });
    expect(next.find((x) => x.id === 'b')?.startSec).toBe(20);
  });

  it('keeps the segment at least the resize floor long', () => {
    const next = resizeRemakeRange({
      ranges, id: 'a', edge: 'end', valueSec: 11, sourceDurationSec: 60,
    });
    expect(next.find((x) => x.id === 'a')?.endSec).toBe(14.1);
  });

  it('caps the segment at the model maximum', () => {
    const next = resizeRemakeRange({
      ranges: [r('a', 0, 10)], id: 'a', edge: 'end', valueSec: 55, sourceDurationSec: 60,
    });
    expect(next.find((x) => x.id === 'a')?.endSec).toBe(30);
  });

  it('leaves everything alone for an unknown id', () => {
    expect(resizeRemakeRange({
      ranges, id: 'nope', edge: 'end', valueSec: 1, sourceDurationSec: 60,
    })).toEqual(ranges);
  });
});

describe('prepareRemakeRangesForSubmission', () => {
  it('normalises a tail that overshoots by a few pixels', () => {
    const prepared = prepareRemakeRangesForSubmission({
      ranges: [r('a', 10, 20.04)],
      sourceDurationSec: 20,
    });
    expect(prepared.failedRangeIds).toEqual([]);
    expect(prepared.ranges).toEqual([
      { id: 'a', startSec: 10, endSec: 20, intent: undefined },
    ]);
  });

  it('refuses everything when a single range is bad', () => {
    const prepared = prepareRemakeRangesForSubmission({
      ranges: [r('a', 0, 5), r('b', 10, 11)],
      sourceDurationSec: 30,
    });
    expect(prepared.ranges).toEqual([]);
    expect(prepared.failedRangeIds).toEqual(['b']);
  });

  it('flags duplicate ids instead of silently deduping', () => {
    const prepared = prepareRemakeRangesForSubmission({
      ranges: [r('a', 0, 5), r('a', 10, 15)],
      sourceDurationSec: 30,
    });
    expect(prepared.failedRangeIds).toEqual(['a']);
  });
});

describe('buildRemakePrompt', () => {
  it('writes each range as a sentence the model can read', () => {
    expect(
      buildRemakePrompt({
        ranges: [r('a', 3, 7, '把黄色台灯换成白色台灯')],
        mediaToken: '这段视频',
      }),
    ).toBe('将 这段视频 的第 3 秒到第 7 秒：把黄色台灯换成白色台灯');
  });

  it('still says what to do when a range has no intent', () => {
    expect(buildRemakePrompt({ ranges: [r('a', 3, 7)], mediaToken: 'V' })).toContain('重拍这一段');
  });

  it('falls back to whole-video mode when nothing is selected', () => {
    expect(buildRemakePrompt({ ranges: [], mediaToken: 'V', wholeIntent: '换成夜景' }))
      .toBe('将 V：换成夜景');
    // 留空＝原样重跑一次，提示词里不该凭空多出要求。
    expect(buildRemakePrompt({ ranges: [], mediaToken: 'V' })).toBe('V');
  });
});

describe('buildEditSegments', () => {
  it('mirrors the prompt as a structured payload at centisecond precision', () => {
    expect(buildEditSegments([r('b', 14, 18.25, ' 改成雨天 '), r('a', 5, 9)])).toEqual([
      { timeRange: { start: 5, end: 9 }, durationSec: 4, prompt: '' },
      { timeRange: { start: 14, end: 18.25 }, durationSec: 4.25, prompt: '改成雨天' },
    ]);
  });
});

describe('formatRangeDurationLabel', () => {
  it('reads as one decimal regardless of the stored precision', () => {
    expect(formatRangeDurationLabel(r('a', 5, 9.04))).toBe('4.0s');
    expect(formatRangeDurationLabel(r('a', 5, 12.5))).toBe('7.5s');
  });
});

describe('continuation', () => {
  it('defaults to the first 30 seconds', () => {
    expect(initialContinuationRange(45)).toEqual({ startSec: 0, endSec: 30 });
    expect(initialContinuationRange(12)).toEqual({ startSec: 0, endSec: 12 });
  });

  it('refuses a source too short to continue from', () => {
    expect(initialContinuationRange(3)).toBeNull();
  });

  it('bounds the selected segment to what the model accepts', () => {
    expect(isContinuationRangeSupported({ startSec: 0, endSec: 4 })).toBe(true);
    expect(isContinuationRangeSupported({ startSec: 0, endSec: 3.9 })).toBe(false);
    expect(isContinuationRangeSupported({ startSec: 0, endSec: 31 })).toBe(false);
  });

  it('builds a prompt with and without an intent', () => {
    expect(buildContinuationPrompt({ mediaToken: '{{Video 1}}', intent: '她转身离开' }))
      .toBe('对 {{Video 1}} 进行续写：她转身离开');
    expect(buildContinuationPrompt({ mediaToken: 'V' })).toBe('对 V 进行续写');
  });
});

describe('isContinuationBindingValid', () => {
  const binding = {
    sourceNodeId: 'src',
    sourceEdgeId: 'e1',
    range: { startSec: 0, endSec: 10 },
    sourceVideoUrl: '/static/a.mp4',
  };
  const edges = [{ id: 'e1', source: 'src', target: 'tgt' }];

  it('holds while the edge, the source video and the range all still stand', () => {
    expect(
      isContinuationBindingValid({
        binding, targetNodeId: 'tgt', edges, currentSourceVideoUrl: '/static/a.mp4',
      }),
    ).toBe(true);
  });

  it('breaks when the edge is gone', () => {
    expect(
      isContinuationBindingValid({
        binding, targetNodeId: 'tgt', edges: [], currentSourceVideoUrl: '/static/a.mp4',
      }),
    ).toBe(false);
  });

  it('breaks when the source node now holds a different video', () => {
    expect(
      isContinuationBindingValid({
        binding, targetNodeId: 'tgt', edges, currentSourceVideoUrl: '/static/b.mp4',
      }),
    ).toBe(false);
  });
});
