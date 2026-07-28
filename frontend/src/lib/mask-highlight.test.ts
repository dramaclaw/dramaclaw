// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';
import {
  MASK_ALPHA_THRESHOLD,
  MASK_HIGHLIGHT_RGBA,
  binarizeMaskToRed,
} from './mask-highlight';

/** 构造一个只含单像素的 RGBA 缓冲。 */
function pixel(r: number, g: number, b: number, a: number): Uint8ClampedArray {
  return new Uint8ClampedArray([r, g, b, a]);
}

describe('binarizeMaskToRed', () => {
  const { r, g, b, a } = MASK_HIGHLIGHT_RGBA;

  it('单笔涂抹区（alpha 140）→ 均匀半透明红', () => {
    const d = pixel(239, 68, 68, 140); // 0.55 笔刷
    binarizeMaskToRed(d);
    expect([...d]).toEqual([r, g, b, a]);
  });

  it('叠加区（alpha 203）输出与单笔完全相同——证明消除了深浅不均', () => {
    const single = pixel(239, 68, 68, 140);
    const overlap = pixel(239, 68, 68, 203); // ~0.80 段接头叠加
    binarizeMaskToRed(single);
    binarizeMaskToRed(overlap);
    expect([...overlap]).toEqual([...single]);
    expect([...overlap]).toEqual([r, g, b, a]);
  });

  it('未涂抹像素（alpha 0）→ 全透明', () => {
    const d = pixel(0, 0, 0, 0);
    binarizeMaskToRed(d);
    expect(d[3]).toBe(0);
  });

  it('低于阈值的抗锯齿边缘 → 全透明', () => {
    const d = pixel(239, 68, 68, MASK_ALPHA_THRESHOLD - 1);
    binarizeMaskToRed(d);
    expect(d[3]).toBe(0);
  });

  it('无论原始颜色，涂抹区一律改写为红', () => {
    const d = pixel(12, 200, 99, 60);
    binarizeMaskToRed(d);
    expect([...d]).toEqual([r, g, b, a]);
  });

  it('多像素混合缓冲：涂抹区统一红、其余透明', () => {
    const d = new Uint8ClampedArray([
      239, 68, 68, 140, // 涂抹
      239, 68, 68, 203, // 叠加
      0, 0, 0, 0, // 空
      1, 2, 3, 4, // 低于阈值
    ]);
    binarizeMaskToRed(d);
    expect([...d]).toEqual([
      r, g, b, a,
      r, g, b, a,
      0, 0, 0, 0,
      1, 2, 3, 0,
    ]);
  });
});
