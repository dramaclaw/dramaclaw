// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  addReshootClip,
  canAddReshootClip,
  clipTimecodeToken,
  formatClipDuration,
  formatTimecode,
  MAX_RESHOOT_CLIPS,
  MAX_RESHOOT_TOTAL_MS,
  MIN_RESHOOT_CLIP_MS,
  pruneReshootClipsByPrompt,
  removeReshootClip,
  resizeReshootClip,
  syncReshootPrompt,
  totalReshootMs,
  type VideoReshootClip,
} from '@/features/canvas/application/videoReshootClips';

const TOTAL = 30_000;
/** 顶预算的用例要用长素材：30s 的视频自己就把 30s 预算封死了，测不出边界。 */
const LONG_TOTAL = 120_000;

function ids() {
  let n = 0;
  return () => `c${++n}`;
}

function clip(id: string, startMs: number, endMs: number): VideoReshootClip {
  return { id, startMs, endMs };
}

describe('formatTimecode / clipTimecodeToken', () => {
  it('renders mm:ss and the prompt token', () => {
    expect(formatTimecode(0)).toBe('00:00');
    expect(formatTimecode(6_000)).toBe('00:06');
    expect(formatTimecode(75_000)).toBe('01:15');
    expect(clipTimecodeToken(clip('a', 1_000, 6_000))).toBe('00:01-00:06');
    expect(formatClipDuration(clip('a', 1_000, 5_000))).toBe('4.0s');
  });
});

describe('addReshootClip', () => {
  it('cuts a default 4s clip at the click point', () => {
    const next = addReshootClip([], 5_000, TOTAL, ids());
    expect(next).toEqual([{ id: 'c1', startMs: 5_000, endMs: 9_000 }]);
  });

  it('pins the clip inside the track when clicking near the end', () => {
    const next = addReshootClip([], 29_000, TOTAL, ids());
    // 右侧只剩 1s，整体左移贴住轨道尾部而不是溢出。
    expect(next).toEqual([{ id: 'c1', startMs: 26_000, endMs: 30_000 }]);
  });

  it('never overlaps an existing clip', () => {
    const existing = [clip('a', 4_000, 8_000)];
    // 点在已有片段上：顺延到它右边的空档，而不是拒绝或压上去。
    const next = addReshootClip(existing, 6_000, TOTAL, ids());
    expect(next).toEqual([existing[0], { id: 'c1', startMs: 8_000, endMs: 12_000 }]);
  });

  it('keeps clips ordered by start time', () => {
    const existing = [clip('a', 20_000, 24_000)];
    const next = addReshootClip(existing, 2_000, TOTAL, ids())!;
    expect(next.map((c) => c.id)).toEqual(['c1', 'a']);
  });

  it('refuses past the 5-clip cap and when no gap is left', () => {
    const makeId = ids();
    const full = Array.from({ length: MAX_RESHOOT_CLIPS }, (_, index) =>
      clip(`f${index}`, index * 5_000, index * 5_000 + 4_000),
    );
    expect(addReshootClip(full, 26_000, TOTAL, makeId)).toBeNull();
    // 满轨道（单个片段占满）也放不下第二个。
    expect(addReshootClip([clip('a', 0, TOTAL)], 1_000, TOTAL, makeId)).toBeNull();
    // 时长未知时不允许截取，否则会截出 0 长度的片段。
    expect(addReshootClip([], 0, 0, makeId)).toBeNull();
  });
});

describe('resizeReshootClip', () => {
  it('drags either edge', () => {
    const clips = [clip('a', 4_000, 8_000)];
    expect(resizeReshootClip(clips, 'a', 'start', 2_000, TOTAL)[0].startMs).toBe(2_000);
    expect(resizeReshootClip(clips, 'a', 'end', 12_000, TOTAL)[0].endMs).toBe(12_000);
  });

  it('clamps at the neighbours instead of overlapping them', () => {
    const clips = [clip('a', 0, 4_000), clip('b', 6_000, 10_000)];
    expect(resizeReshootClip(clips, 'b', 'start', 1_000, TOTAL)[1].startMs).toBe(4_000);
    expect(resizeReshootClip(clips, 'a', 'end', 9_000, TOTAL)[0].endMs).toBe(6_000);
  });

  it('clamps at the track bounds and the minimum length', () => {
    const clips = [clip('a', 4_000, 8_000)];
    expect(resizeReshootClip(clips, 'a', 'start', -5_000, TOTAL)[0].startMs).toBe(0);
    expect(resizeReshootClip(clips, 'a', 'end', 999_000, TOTAL)[0].endMs).toBe(TOTAL);
    expect(resizeReshootClip(clips, 'a', 'start', 7_900, TOTAL)[0].startMs).toBe(
      8_000 - MIN_RESHOOT_CLIP_MS,
    );
    expect(resizeReshootClip(clips, 'a', 'end', 4_100, TOTAL)[0].endMs).toBe(
      4_000 + MIN_RESHOOT_CLIP_MS,
    );
  });

  it('leaves the list untouched for an unknown id', () => {
    const clips = [clip('a', 4_000, 8_000)];
    expect(resizeReshootClip(clips, 'nope', 'start', 0, TOTAL)).toBe(clips);
  });
});

// 这些片段最后是 Seedance 2.5 的视频素材：单段不得短于 4s，所有段加起来不得超过
// 30s。轨道上就得拦住，别等提交被模型退回来。
describe('Seedance 2.5 素材限制', () => {
  it('pins the limits at 4s / 30s', () => {
    expect(MIN_RESHOOT_CLIP_MS).toBe(4_000);
    expect(MAX_RESHOOT_TOTAL_MS).toBe(30_000);
  });

  it('refuses a gap shorter than 4s', () => {
    // 两段中间只剩 3s 的缝：点进去也截不出合法片段，直接不给。
    const clips = [clip('a', 0, 10_000), clip('b', 13_000, 20_000)];
    expect(addReshootClip(clips, 11_000, 20_000, ids())).toBeNull();
  });

  it('refuses a new clip once the 30s budget cannot fit one', () => {
    // 27s 已用，轨道后面空得很，但预算只剩 3s。
    const clips = [
      clip('a', 0, 9_000),
      clip('b', 10_000, 19_000),
      clip('c', 20_000, 29_000),
    ];
    expect(totalReshootMs(clips)).toBe(27_000);
    expect(canAddReshootClip(clips)).toBe(false);
    expect(addReshootClip(clips, 60_000, LONG_TOTAL, ids())).toBeNull();
  });

  it('still allows the clip that lands exactly on 30s', () => {
    const clips = [clip('a', 0, 13_000), clip('b', 20_000, 33_000)];
    expect(canAddReshootClip(clips)).toBe(true);
    const next = addReshootClip(clips, 60_000, LONG_TOTAL, ids())!;
    expect(totalReshootMs(next)).toBe(MAX_RESHOOT_TOTAL_MS);
  });

  it('clamps a drag at the remaining budget instead of overshooting 30s', () => {
    const clips = [clip('a', 0, 20_000), clip('b', 30_000, 36_000)];
    // 往右拖到天边：b 最多只能拉到 10s，总数正好 30s。
    const next = resizeReshootClip(clips, 'b', 'end', 110_000, LONG_TOTAL);
    expect(next[1]).toEqual({ id: 'b', startMs: 30_000, endMs: 40_000 });
    expect(totalReshootMs(next)).toBe(MAX_RESHOOT_TOTAL_MS);
    // 另一端同理：往左拖也只多得到剩下那 4s。
    const left = resizeReshootClip(clips, 'b', 'start', 0, LONG_TOTAL);
    expect(left[1].startMs).toBe(26_000);
    expect(totalReshootMs(left)).toBe(MAX_RESHOOT_TOTAL_MS);
  });
});

describe('syncReshootPrompt', () => {
  const a = clip('a', 1_000, 6_000);
  const b = clip('b', 10_000, 14_000);

  it('appends the timecode of a freshly cut clip', () => {
    expect(syncReshootPrompt('', [], [a])).toBe('00:01-00:06');
    expect(syncReshootPrompt('把黄色台灯换成白色台灯', [], [a])).toBe(
      '把黄色台灯换成白色台灯\n00:01-00:06',
    );
  });

  it('rewrites the token in place when the clip is dragged', () => {
    const moved = { ...a, endMs: 9_000 };
    expect(
      syncReshootPrompt('把黄色台灯换成白色台灯\n00:01-00:06', [a], [moved]),
    ).toBe('把黄色台灯换成白色台灯\n00:01-00:09');
  });

  it('removes the token and its line when the clip is deleted', () => {
    const prompt = syncReshootPrompt('镜头改成推近', [], [a, b]);
    expect(prompt).toBe('镜头改成推近\n00:01-00:06\n00:10-00:14');
    expect(syncReshootPrompt(prompt, [a, b], [b])).toBe('镜头改成推近\n00:10-00:14');
    expect(syncReshootPrompt(prompt, [a, b], [])).toBe('镜头改成推近');
  });

  it('keeps hand-written text untouched when a token is missing', () => {
    // 用户自己把时间码删了 —— 再删片段时不该殃及旁边的正文。
    expect(syncReshootPrompt('只保留这句话', [a], [])).toBe('只保留这句话');
  });
});

describe('removeReshootClip', () => {
  it('drops only the requested clip', () => {
    const clips = [clip('a', 0, 4_000), clip('b', 6_000, 10_000)];
    expect(removeReshootClip(clips, 'a').map((c) => c.id)).toEqual(['b']);
  });
});

describe('pruneReshootClipsByPrompt — 输入框删掉时间码 → 轨道同步撤段', () => {
  const a = clip('a', 1_000, 6_000);
  const b = clip('b', 10_000, 14_000);

  it('drops the clip whose token is gone from the prompt', () => {
    expect(
      pruneReshootClipsByPrompt('镜头改成推近\n00:10-00:14', [a, b]).map((c) => c.id),
    ).toEqual(['b']);
    expect(pruneReshootClipsByPrompt('镜头改成推近', [a, b])).toEqual([]);
  });

  it('returns the very same array when nothing is missing', () => {
    // 引用相等是调用方判断「无事发生」的依据 —— 变成新数组会让每敲一个字都写一次 store。
    const clips = [a, b];
    expect(
      pruneReshootClipsByPrompt('镜头改成推近\n00:01-00:06\n00:10-00:14', clips),
    ).toBe(clips);
    expect(pruneReshootClipsByPrompt('', [])).toEqual([]);
  });

  it('keeps a clip whose token sits inline in hand-written text', () => {
    // 时间码不一定独占一行：用户可能把它拖进句子里，那也算还在。
    expect(pruneReshootClipsByPrompt('把 00:01-00:06 这段重拍', [a])).toEqual([a]);
  });
});
