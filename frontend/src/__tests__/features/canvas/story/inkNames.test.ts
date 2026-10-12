import { describe, expect, it } from 'vitest';
import { knotNameForNodeId, stateNameForVariable } from '@/features/canvas/story/inkNames';

describe('knotNameForNodeId', () => {
  it('给 UUID 加前缀并把非法字符编码', () => {
    expect(knotNameForNodeId('a1b2-c3d4')).toBe('clip_a1b2_2d_c3d4');
  });

  it('数字开头也安全(前缀保证字母开头)', () => {
    expect(knotNameForNodeId('123')).toBe('clip_123');
  });

  it('多种非法字符组合分别编码', () => {
    expect(knotNameForNodeId('x.y/z')).toBe('clip_x_2e_y_2f_z');
  });
});

describe('stateNameForVariable', () => {
  it('separates authored state names from knots, reentry knots and reserved words', () => {
    const names = ['clip_start', 'reenter_clip_start', 'END', 'DONE', 'true', 'temp'];
    for (const name of names) {
      expect(stateNameForVariable(name)).toMatch(/^state_[A-Za-z0-9_]+$/);
      expect(stateNameForVariable(name)).not.toBe(knotNameForNodeId('start'));
      expect(stateNameForVariable(name)).not.toBe(`reenter_${knotNameForNodeId('start')}`);
    }
  });

  it('keeps escape-looking names distinct and stable', () => {
    const names = ['clip_start', 'clip_5f_start', 'state_clip_start', 'state_clip_5f_start'];
    expect(new Set(names.map(stateNameForVariable)).size).toBe(names.length);
    expect(stateNameForVariable('clip_start')).toBe('state_clip_5f_start');
  });
});
