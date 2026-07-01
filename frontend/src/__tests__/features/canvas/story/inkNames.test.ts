import { describe, expect, it } from 'vitest';
import { knotNameForNodeId } from '@/features/canvas/story/inkNames';

describe('knotNameForNodeId', () => {
  it('给 UUID 加前缀并把非法字符转下划线', () => {
    expect(knotNameForNodeId('a1b2-c3d4')).toBe('clip_a1b2_c3d4');
  });

  it('数字开头也安全(前缀保证字母开头)', () => {
    expect(knotNameForNodeId('123')).toBe('clip_123');
  });

  it('多种非法字符组合都转成下划线', () => {
    expect(knotNameForNodeId('x.y/z')).toBe('clip_x_y_z');
  });
});
