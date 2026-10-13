import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearStoryStats,
  emptyStoryStats,
  readStoryStats,
  recordChoice,
  recordEnding,
  statsKeyFromSaveKey,
} from '@/features/canvas/story/storyStats';

const KEY = 'st.story.stats.cvs.grp';

describe('storyStats', () => {
  beforeEach(() => localStorage.clear());

  it('statsKeyFromSaveKey 把 save key 换成 stats key(同 st.story. 前缀)', () => {
    expect(statsKeyFromSaveKey('st.story.save.cvs.grp')).toBe('st.story.stats.cvs.grp');
    expect(statsKeyFromSaveKey(null)).toBeNull();
  });

  it('无数据时 readStoryStats 返回空统计', () => {
    expect(readStoryStats(KEY)).toEqual(emptyStoryStats());
  });

  it('recordChoice 累加同一选择点各选项的次数,并记住选项文案与选择点标签', () => {
    recordChoice(KEY, { nodeId: 'p1', index: 0, text: '走左边', pointLabel: '岔路口' });
    recordChoice(KEY, { nodeId: 'p1', index: 0, text: '走左边', pointLabel: '岔路口' });
    recordChoice(KEY, { nodeId: 'p1', index: 1, text: '走右边', pointLabel: '岔路口' });

    const stats = readStoryStats(KEY);
    expect(stats.points.p1.label).toBe('岔路口');
    expect(stats.points.p1.options['0']).toEqual({ text: '走左边', count: 2 });
    expect(stats.points.p1.options['1']).toEqual({ text: '走右边', count: 1 });
  });

  it('recordEnding 累加结局次数并递增 totalRuns', () => {
    recordEnding(KEY, { nodeId: 'e1', title: '宠冠后宫', label: 'GE' });
    recordEnding(KEY, { nodeId: 'e1', title: '宠冠后宫', label: 'GE' });
    recordEnding(KEY, { nodeId: 'e2', title: '打入冷宫', label: 'BE' });

    const stats = readStoryStats(KEY);
    expect(stats.totalRuns).toBe(3);
    expect(stats.endings.e1).toEqual({ title: '宠冠后宫', label: 'GE', count: 2 });
    expect(stats.endings.e2).toEqual({ title: '打入冷宫', label: 'BE', count: 1 });
  });

  it('clearStoryStats 抹掉统计', () => {
    recordEnding(KEY, { nodeId: 'e1', title: '结局', label: 'GE' });
    clearStoryStats(KEY);
    expect(readStoryStats(KEY)).toEqual(emptyStoryStats());
  });

  it('损坏的 localStorage 数据被当作空统计(不抛)', () => {
    localStorage.setItem(KEY, '{not json');
    expect(readStoryStats(KEY)).toEqual(emptyStoryStats());
  });
});
