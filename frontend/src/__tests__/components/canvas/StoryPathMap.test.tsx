import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

import { StoryPathMap } from '@/components/canvas/StoryPathMap';
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import type { StoryStats } from '@/features/canvas/story/storyStats';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const GROUP = 'g';
const STATS_KEY = 'st.story.stats.cvs.g';

/** 造一个组内故事:start → 走过分支(mid→goodEnd) / 未走分支(badEnd)。 */
function seedGraph() {
  const store = useCanvasStore.getState();
  const video = (id: string, displayName: string, extra: Record<string, unknown> = {}) => ({
    id,
    type: CANVAS_NODE_TYPES.video,
    parentId: GROUP,
    position: { x: 0, y: 0 },
    data: { displayName, videoUrl: '', aspectRatio: '16:9', ...extra },
  });
  store.setCanvasData(
    [
      { id: GROUP, type: CANVAS_NODE_TYPES.group, position: { x: 0, y: 0 }, data: { storyGroup: true } },
      video('start', '开场', { storyRole: 'start' }),
      video('mid', '中段'),
      video('goodEnd', '好结局', { endingLabel: 'GE' }),
      video('badEnd', '坏结局', { endingLabel: 'BE' }),
    ] as never,
    [],
  );
  store.addStoryChoiceEdge('start', 'mid', '走这边');
  store.addStoryChoiceEdge('start', 'badEnd', '走那边');
  store.addStoryChoiceEdge('mid', 'goodEnd', '继续');
}

function seedStats(stats: StoryStats) {
  localStorage.setItem(STATS_KEY, JSON.stringify(stats));
}

describe('StoryPathMap — 路径回顾图', () => {
  beforeEach(() => {
    localStorage.clear();
    seedGraph();
  });
  afterEach(() => localStorage.clear());

  it('叠加统计:探索率与结局达成率、已达成结局带计数', () => {
    // 走过 start→mid→goodEnd;badEnd 未走。
    seedStats({
      totalRuns: 1,
      points: {
        start: { options: { 0: { text: '走这边', count: 1 } } },
        mid: { options: { 0: { text: '继续', count: 1 } } },
      },
      endings: { goodEnd: { title: '好结局', label: 'GE', count: 2 } },
    });
    const { container } = render(
      <StoryPathMap groupId={GROUP} statsKey={STATS_KEY} onClose={() => {}} />,
    );
    const text = container.textContent ?? '';

    // 节点 start,mid,goodEnd,badEnd = 4;已探索 start,mid,goodEnd = 3。
    expect(text).toContain('3/4');
    // 结局 goodEnd,badEnd = 2;已达成 1。
    expect(text).toContain('1/2');
    // 已达成结局显示计数。
    expect(text).toContain('×2');
    // 所有节点名都在图里(走过的与没走的都列出)。
    expect(text).toContain('开场');
    expect(text).toContain('坏结局');
  });

  it('无统计(statsKey=null)时仍展示结构,覆盖为 0', () => {
    const { container } = render(
      <StoryPathMap groupId={GROUP} statsKey={null} onClose={() => {}} />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('0/4'); // 探索 0/4
    expect(text).toContain('0/2'); // 结局 0/2
    expect(text).toContain('开场');
  });
});
