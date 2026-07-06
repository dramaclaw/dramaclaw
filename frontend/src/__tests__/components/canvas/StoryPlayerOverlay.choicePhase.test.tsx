import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';

import { StoryPlayerOverlay } from '@/components/canvas/StoryPlayerOverlay';
import { useStoryRuntimeStore } from '@/stores/storyRuntimeStore';
import { CHOICE_STAGE_TIMING } from '@/components/canvas/useChoicePointMachine';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { initMs, confirmMs } = CHOICE_STAGE_TIMING;

/** 把 runtime store 置于「占位卡选择点」状态(无视频 → 选项立即可见),返回 choose 探针。 */
function seedChoicePoint(over: Partial<Parameters<typeof useStoryRuntimeStore.setState>[0]> = {}) {
  const choose = vi.fn();
  useStoryRuntimeStore.setState({
    mode: 'play',
    phase: 'playing',
    error: null,
    resumeAvailable: false,
    story: {} as never,
    currentNodeId: 'n1',
    currentClipUrl: null,
    currentChoices: [
      { index: 0, text: '走左边' },
      { index: 1, text: '走右边' },
    ],
    nextClipUrls: [],
    currentVariables: [],
    currentChoiceTimeSec: null,
    currentDefaultChoiceIndex: null,
    currentEnding: null,
    currentPlaceholder: { text: '' },
    statsKey: null,
    choose,
    ...over,
  });
  return choose;
}

function panel(): HTMLElement | null {
  return document.body.querySelector('[data-choice-stage]');
}

describe('StoryPlayerOverlay — 选择点四阶段接线', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    act(() => useStoryRuntimeStore.getState().exitPlay());
  });

  it('init 阶段选项已挂载但未进入,initMs 后转 select 显现', () => {
    seedChoicePoint();
    render(<StoryPlayerOverlay />);
    expect(panel()?.getAttribute('data-choice-stage')).toBe('init');
    expect(panel()?.className).toContain('opacity-0');

    act(() => vi.advanceTimersByTime(initMs));
    expect(panel()?.getAttribute('data-choice-stage')).toBe('select');
    expect(panel()?.className).toContain('opacity-100');
  });

  it('点选后进 hide、高亮所选并淡化其他,confirmMs 后 choose 推进一次', () => {
    const choose = seedChoicePoint();
    const { getByText } = render(<StoryPlayerOverlay />);
    act(() => vi.advanceTimersByTime(initMs));

    fireEvent.click(getByText('走左边'));
    expect(panel()?.getAttribute('data-choice-stage')).toBe('hide');

    const left = getByText('走左边').closest('button')!;
    const right = getByText('走右边').closest('button')!;
    expect(left.getAttribute('aria-pressed')).toBe('true');
    expect(left.className).toContain('border-white/60');
    expect(right.className).toContain('opacity-30');
    expect(right).toBeDisabled();
    expect(choose).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(confirmMs));
    expect(choose).toHaveBeenCalledTimes(1);
    expect(choose).toHaveBeenCalledWith(0);
  });

  it('限时选项超时:走 timeout 阶段选默认项并 choose 默认', () => {
    const choose = seedChoicePoint({
      currentChoiceTimeSec: 3,
      currentDefaultChoiceIndex: 1,
    });
    render(<StoryPlayerOverlay />);
    act(() => vi.advanceTimersByTime(initMs));
    expect(panel()?.querySelector('[role="timer"]')).not.toBeNull();

    act(() => vi.advanceTimersByTime(3000));
    expect(panel()?.getAttribute('data-choice-stage')).toBe('timeout');
    act(() => vi.advanceTimersByTime(confirmMs));
    expect(choose).toHaveBeenCalledWith(1);
  });
});
