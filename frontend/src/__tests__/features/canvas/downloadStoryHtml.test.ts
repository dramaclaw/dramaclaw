import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeFileName, downloadStoryHtml } from '@/features/canvas/story/export/downloadStoryHtml';

describe('safeFileName', () => {
  it('保留中英数字下划线连字符,加 .html', () => {
    expect(safeFileName('我的故事')).toBe('我的故事.html');
    expect(safeFileName('story-1_v2')).toBe('story-1_v2.html');
  });
  it('非法字符替换为下划线', () => {
    expect(safeFileName('a/b:c*d')).toBe('a_b_c_d.html');
  });
  it('空/全非法回退 interactive-story', () => {
    expect(safeFileName('')).toBe('interactive-story.html');
    expect(safeFileName('  ')).toBe('interactive-story.html');
    expect(safeFileName('***')).toBe('interactive-story.html');
  });
});

describe('downloadStoryHtml', () => {
  afterEach(() => vi.restoreAllMocks());

  it('用清洗后的文件名触发 a[download] 下载', () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    const revokeObjectURL = vi.fn();
    // jsdom 默认无 URL.createObjectURL
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadStoryHtml('<html></html>', '我的故事');

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:x');
  });
});
