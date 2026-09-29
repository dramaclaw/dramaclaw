// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';
import { splitTimedVideoPrompt } from '@/features/canvas/application/videoPromptSplit';
import { placeVideoSplitSegments } from '@/features/canvas/application/videoSplitPlacement';

const common = 'Common characters {{Mixed 1}}, audio {{Mixed 2}}.\n';
const shots = (durations: number[]) => durations.map((seconds, i) =>
  `【镜头${i + 1}】Original shot ${i + 1}\n时长：${seconds}秒\nOriginal dialogue ${i + 1}\nAI视频提示词：\n${seconds}秒，Original action ${i + 1}\n\n`);

describe('whole-shot video prompt splitting', () => {
  it('reproduces the reported 56-second prompt as five intact segments', () => {
    const blocks = shots([5, 7, 7, 4, 5, 4, 7, 6, 6, 5]);
    const result = splitTimedVideoPrompt(common + blocks.join(''));
    expect(result.totalDurationSec).toBe(56);
    expect(result.segments.map(s => s.durationSec)).toEqual([12, 11, 9, 13, 11]);
    expect(result.segments.map(s => s.prompt)).toEqual([0, 2, 4, 6, 8].map(i => common + blocks.slice(i, i + 2).join('')));
  });
  it('packs consecutive whole shots up to 15 seconds', () => {
    const result = splitTimedVideoPrompt(common + shots([6, 3, 5, 5, 8, 4]).join(''));
    expect(result.segments.map(s => s.durationSec)).toEqual([14, 13, 4]);
    expect(result.segments.map(s => [s.startSec, s.endSec])).toEqual([[0, 14], [14, 27], [27, 31]]);
  });
  it('splits a real 30-second script into two complete 15-second segments', () => {
    expect(splitTimedVideoPrompt(shots([8, 7, 9, 6]).join('')).segments.map(s => s.durationSec)).toEqual([15, 15]);
  });
  it('preserves fractional shot durations without crossing the limit', () => {
    expect(splitTimedVideoPrompt(shots([7.5, 7.5, 4.2, 10.8]).join('')).segments.map(s => s.durationSec)).toEqual([15, 15]);
  });
  it('rebases explicit ranges and preserves common instructions and total labels', () => {
    const result = splitTimedVideoPrompt('总时长：24秒\nShared\n00:00–00:08 A\n00:08–00:15 B\n00:15–00:24 C\n全局要求：Keep character\n');
    expect(result.segments[1].prompt).toBe('总时长：9秒\nShared\n00:00–00:09 C\n全局要求：Keep character\n');
    expect(result.segments.map(s => s.durationSec)).toEqual([15, 9]);
  });
  it.each([
    [shots([16, 4]).join(''), 'shotTooLong'],
    [shots([10, 5]).join(''), 'alreadyShort'],
    ['No shot timing', 'noTimeline'],
    ['【镜头1】No timing\n', 'missingTiming'],
    ['00:00–00:10 A\n00:09–00:20 B\n', 'ambiguousTiming'],
    ['00:00–00:10 A\n00:11–00:20 B\n', 'ambiguousTiming'],
  ])('rejects invalid or unnecessary split: %s', (prompt, code) => {
    expect(() => splitTimedVideoPrompt(prompt)).toThrow(code);
  });
});

describe('split placement', () => {
  const size = { width: 622, height: 350 };
  it('uses adjacent right-side space in sequence, at the source height', () => {
    expect(placeVideoSplitSegments({ x: 2542, y: 360 }, size, 3, [])).toEqual([
      { x: 2542, y: 360 }, { x: 3212, y: 360 }, { x: 3882, y: 360 },
    ]);
  });
  it('reproduces the screenshot collision and skips right, never down', () => {
    const obstacles = [
      { x: 1872, y: 360, ...size },
      { x: 2964, y: 636, ...size },
      { x: 3693, y: 636, width: 625, height: 350 },
      { x: 1872, y: 912, ...size },
    ];
    const before = structuredClone(obstacles);
    const result = placeVideoSplitSegments({ x: 2542, y: 360 }, size, 4, obstacles);
    expect(result).toEqual([4366, 5036, 5706, 6376].map(x => ({ x, y: 360 })));
    expect(obstacles).toEqual(before);
    for (const position of result) for (const box of obstacles) {
      expect(position.x < box.x + box.width && position.x + size.width > box.x
        && position.y < box.y + box.height && position.y + size.height > box.y).toBe(false);
    }
  });
  it('ignores nodes below the source row', () => {
    expect(placeVideoSplitSegments({ x: 2542, y: 360 }, size, 1,
      [{ x: 2542, y: 912, ...size }])).toEqual([{ x: 2542, y: 360 }]);
  });
});
