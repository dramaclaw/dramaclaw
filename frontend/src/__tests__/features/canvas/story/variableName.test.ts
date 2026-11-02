import { describe, expect, it } from 'vitest';
import { slugifyName } from '@/features/canvas/story/variableName';

describe('slugifyName', () => {
  it('保留合法标识符', () => {
    expect(slugifyName('fav')).toBe('fav');
  });
  it('去掉非法字符', () => {
    expect(slugifyName('lin fav!')).toBe('linfav');
  });
  it('数字/中文开头回退 var 前缀', () => {
    expect(slugifyName('123')).toBe('var_123');
    expect(slugifyName('好感度')).toBe('var');
  });
});
