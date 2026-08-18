// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  MAX_EXTEND_CLIP_MS,
  MIN_EXTEND_CLIP_MS,
  defaultExtendRange,
  extendClipBoundMessage,
  extendNodeDisplayName,
  extendPromptPrefix,
  isExtendRangeSubmittable,
  resolveExtendRange,
} from '@/features/canvas/application/videoExtendClip';

describe('defaultExtendRange', () => {
  it('长素材贴着片尾取 30s —— 续写是从这段结尾往后接', () => {
    expect(defaultExtendRange(90_000)).toEqual({ startMs: 60_000, endMs: 90_000 });
  });

  it('素材不足 30s 时退化成整条', () => {
    expect(defaultExtendRange(15_070)).toEqual({ startMs: 0, endMs: 15_070 });
  });

  it('时长还没读出来时给个空区间，别算出负的起点', () => {
    expect(defaultExtendRange(0)).toEqual({ startMs: 0, endMs: 0 });
    expect(defaultExtendRange(Number.NaN)).toEqual({ startMs: 0, endMs: 0 });
  });
});

describe('isExtendRangeSubmittable', () => {
  it('4s 和 30s 都算合法（闭区间）', () => {
    expect(isExtendRangeSubmittable({ startMs: 0, endMs: MIN_EXTEND_CLIP_MS })).toBe(true);
    expect(isExtendRangeSubmittable({ startMs: 0, endMs: MAX_EXTEND_CLIP_MS })).toBe(true);
  });

  it('差 1ms 就不给提交', () => {
    expect(isExtendRangeSubmittable({ startMs: 0, endMs: 3_999 })).toBe(false);
    expect(isExtendRangeSubmittable({ startMs: 0, endMs: 30_001 })).toBe(false);
  });
});

describe('resolveExtendRange', () => {
  const anchorAt = (mode: 'start' | 'end' | 'move', startMs: number, endMs: number) => ({
    mode,
    startAtDown: startMs,
    endAtDown: endMs,
    anchorMs: mode === 'start' ? startMs : endMs,
  });

  it('拖终点缩到 4s 以下会被顶住，并报 min', () => {
    const next = resolveExtendRange(anchorAt('end', 10_000, 20_000), 11_000, 60_000);
    expect(next).toEqual({ startMs: 10_000, endMs: 14_000, bound: 'min' });
    expect(extendClipBoundMessage(next.bound)).toBe('所选视频最短不小于 4 秒');
  });

  it('拖终点撑过 30s 会被顶住，并报 max', () => {
    const next = resolveExtendRange(anchorAt('end', 10_000, 20_000), 55_000, 60_000);
    expect(next).toEqual({ startMs: 10_000, endMs: 40_000, bound: 'max' });
    expect(extendClipBoundMessage(next.bound)).toBe('所选视频最长不大于 30 秒');
  });

  it('拖到片尾（不是 30s）不算撞上限，不弹提示', () => {
    const next = resolveExtendRange(anchorAt('end', 10_000, 20_000), 99_000, 25_000);
    expect(next).toEqual({ startMs: 10_000, endMs: 25_000, bound: null });
  });

  it('拖起点同样两头都夹，长度先夹、位置后夹', () => {
    expect(resolveExtendRange(anchorAt('start', 10_000, 50_000), 48_000, 60_000)).toEqual({
      startMs: 46_000,
      endMs: 50_000,
      bound: 'min',
    });
    expect(resolveExtendRange(anchorAt('start', 10_000, 50_000), 1_000, 60_000)).toEqual({
      startMs: 20_000,
      endMs: 50_000,
      bound: 'max',
    });
  });

  it('起点拖过片头只是被 0 截住，那不是 30s 上限', () => {
    const next = resolveExtendRange(anchorAt('start', 5_000, 20_000), -3_000, 60_000);
    expect(next).toEqual({ startMs: 0, endMs: 20_000, bound: null });
  });

  it('整体平移不改长度，撞轨道两头也不提示', () => {
    const anchor = { mode: 'move' as const, startAtDown: 10_000, endAtDown: 20_000, anchorMs: 15_000 };
    expect(resolveExtendRange(anchor, 20_000, 60_000)).toEqual({
      startMs: 15_000,
      endMs: 25_000,
      bound: null,
    });
    expect(resolveExtendRange(anchor, 0, 60_000)).toEqual({
      startMs: 0,
      endMs: 10_000,
      bound: null,
    });
    expect(resolveExtendRange(anchor, 999_000, 60_000)).toEqual({
      startMs: 50_000,
      endMs: 60_000,
      bound: null,
    });
  });
});

describe('前缀与节点名', () => {
  it('前缀带上源视频名和时间码', () => {
    expect(extendPromptPrefix('视频 (2)', { startMs: 0, endMs: 4_000 })).toBe(
      '对 视频 (2) 的 00:00-00:04 片段进行续写：',
    );
  });

  it('源视频没名字时有兜底，不会拼出「对  的」', () => {
    expect(extendPromptPrefix('   ', { startMs: 0, endMs: 4_000 })).toBe(
      '对 原视频 的 00:00-00:04 片段进行续写：',
    );
    expect(extendNodeDisplayName('  ')).toBe('续写 视频');
  });

  it('节点名就是「续写 + 源视频名」', () => {
    expect(extendNodeDisplayName('视频 (2)')).toBe('续写 视频 (2)');
  });
});
