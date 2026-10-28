import { render, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StoryStatsPanel } from '@/components/canvas/StoryStatsPanel';
import { readStoryStats, type StoryStats } from '@/features/canvas/story/storyStats';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const KEY = 'st.story.stats.cvs.grp';

function seed(stats: StoryStats) {
  localStorage.setItem(KEY, JSON.stringify(stats));
}

describe('StoryStatsPanel', () => {
  beforeEach(() => localStorage.clear());

  it('渲染结局达成率与选择分布的文案及百分比', () => {
    seed({
      totalRuns: 4,
      endings: {
        e1: { title: '宠冠后宫', label: 'GE', count: 3 },
        e2: { title: '打入冷宫', label: 'BE', count: 1 },
      },
      points: {
        p1: { label: '岔路口', options: { 0: { text: '走左边', count: 3 }, 1: { text: '走右边', count: 1 } } },
      },
    });
    const { container } = render(<StoryStatsPanel statsKey={KEY} onClose={() => {}} />);
    const text = container.textContent ?? '';

    expect(text).toContain('宠冠后宫');
    expect(text).toContain('GE');
    expect(text).toContain('75% · 3'); // 结局 e1 = 3/4
    expect(text).toContain('岔路口');
    expect(text).toContain('走左边');
    expect(text).toContain('25% · 1'); // 选项「走右边」= 1/4
  });

  it('无数据时显示空态,不显示清空按钮', () => {
    const { container, queryByText } = render(<StoryStatsPanel statsKey={KEY} onClose={() => {}} />);
    expect(container.textContent).toContain('canvas.story.stats.empty');
    expect(queryByText('canvas.story.stats.clear')).toBeNull();
  });

  it('点清空后统计被抹掉', () => {
    seed({ totalRuns: 1, endings: { e1: { title: '结局', label: 'GE', count: 1 } }, points: {} });
    const { getByText } = render(<StoryStatsPanel statsKey={KEY} onClose={() => {}} />);
    fireEvent.click(getByText('canvas.story.stats.clear'));
    expect(readStoryStats(KEY)).toEqual({ totalRuns: 0, points: {}, endings: {} });
  });
});
