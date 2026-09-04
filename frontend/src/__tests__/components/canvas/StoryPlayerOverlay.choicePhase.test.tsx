import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';

import { StoryPlayerOverlay, STORY_OUTCOME_FEEDBACK_MS } from '@/components/canvas/StoryPlayerOverlay';
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

function transitionCover(): HTMLElement {
  const cover = Array.from(document.body.querySelectorAll<HTMLElement>('[aria-hidden="true"]'))
    .find((element) => element.getAttribute('class')?.includes('z-[5]'));
  if (!cover) throw new Error('transition cover not found');
  return cover;
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

  it('有剧情反馈时先显示一行文字，反馈结束后才推进故事', () => {
    const choose = seedChoicePoint({
      currentChoices: [
        {
          index: 0,
          text: '接过手电筒',
          feedbackText: '她没有松手，只是点了点头。',
          stateChanges: [{ label: '信任', direction: 'up' }],
        },
        { index: 1, text: '后退一步' },
      ],
    });
    const { getByText, getByRole } = render(<StoryPlayerOverlay />);
    act(() => vi.advanceTimersByTime(initMs));
    fireEvent.click(getByText('接过手电筒'));
    act(() => vi.advanceTimersByTime(confirmMs));

    expect(getByRole('status')).toHaveTextContent('她没有松手，只是点了点头。');
    expect(getByRole('status')).toHaveTextContent('信任 ↑');
    expect(choose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(STORY_OUTCOME_FEEDBACK_MS));
    expect(choose).toHaveBeenCalledWith(0);
  });

  it('重新开始会清除上一分支的 flash 过渡', () => {
    const restart = vi.fn();
    seedChoicePoint({
      restart,
      currentChoices: [{ index: 0, text: '闪白转场', interaction: { transition: 'flash' } }],
    });
    const { getByText } = render(<StoryPlayerOverlay />);
    act(() => vi.advanceTimersByTime(initMs));
    fireEvent.click(getByText('闪白转场'));
    act(() => vi.advanceTimersByTime(confirmMs));
    expect(transitionCover()).toHaveClass('bg-white');

    act(() => useStoryRuntimeStore.setState({
      phase: 'ended',
      currentChoices: [],
      currentEnding: { title: '结局' },
      currentClipUrl: null,
      restart,
    }));
    fireEvent.click(getByText('canvas.story.restart'));

    expect(restart).toHaveBeenCalledOnce();
    expect(transitionCover()).toHaveClass('bg-black');
  });

  it('物品锚定选项脱离底部选项区，按比例坐标渲染真实按钮', () => {
    seedChoicePoint({
      currentChoices: [{
        index: 0,
        text: '拿起手电筒',
        interaction: {
          presentation: 'object-anchor',
          anchor: { x: 0.68, y: 0.64, objectLabel: '手电筒' },
          uiStyle: 'tag',
          motion: 'pop',
        },
      }],
    });
    const { getByRole } = render(<StoryPlayerOverlay />);
    act(() => vi.advanceTimersByTime(initMs));

    const button = getByRole('button', { name: '拿起手电筒' });
    expect(button.style.left).toBe('68%');
    expect(button.style.top).toBe('64%');
    expect(button).toHaveClass('absolute');
    expect(button).not.toHaveClass('relative');
    expect(button.className).toContain('h-[52px]');
    expect(button).toHaveClass('cursor-pointer');
    expect(button).not.toHaveTextContent('拿起手电筒');
    expect(button.querySelector('[data-tech-hit-highlight="true"]')).not.toBeNull();
    expect(button.querySelector('[data-tech-target="true"]')).not.toBeNull();
  });

  it('视频内 UI 热区按配置的矩形范围命中，不再使用固定按钮尺寸', () => {
    seedChoicePoint({
      currentChoices: [{
        index: 0,
        text: '打开舱门',
        interaction: {
          presentation: 'baked-video',
          anchor: { x: 0.58, y: 0.62, width: 0.3, height: 0.16 },
        },
      }],
    });
    const { getByRole } = render(<StoryPlayerOverlay />);
    act(() => vi.advanceTimersByTime(initMs));

    const hotspot = getByRole('button', { name: '打开舱门' });
    expect(Number.parseFloat(hotspot.style.left)).toBeCloseTo(58);
    expect(Number.parseFloat(hotspot.style.top)).toBeCloseTo(62);
    expect(Number.parseFloat(hotspot.style.width)).toBeCloseTo(30);
    expect(Number.parseFloat(hotspot.style.height)).toBeCloseTo(16);
    expect(hotspot).toHaveClass('bg-transparent');
    expect(hotspot).not.toHaveClass('h-16');
    expect(hotspot).not.toHaveClass('min-w-32');
  });

  it('全屏 cover 裁切时按原视频画幅换算锚点位置', () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    seedChoicePoint({
      currentClipUrl: 'wide-screen.mp4',
      currentChoices: [{
        index: 0,
        text: '开始',
        interaction: {
          presentation: 'object-anchor',
          anchor: { x: 0.75, y: 0.76 },
          uiStyle: 'tag',
        },
      }],
    });
    const { getByRole } = render(<StoryPlayerOverlay />);
    const video = document.body.querySelector('video')!;
    Object.defineProperties(video, {
      videoWidth: { configurable: true, value: 1600 },
      videoHeight: { configurable: true, value: 900 },
      duration: { configurable: true, value: 5 },
      currentTime: { configurable: true, value: 4.9 },
    });
    vi.spyOn(video, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 2000,
      height: 900,
      right: 2000,
      bottom: 900,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    act(() => fireEvent.loadedMetadata(video));
    act(() => fireEvent.timeUpdate(video));
    act(() => vi.advanceTimersByTime(initMs));
    const button = getByRole('button', { name: '开始' });
    expect(button.style.left).toBe('1500px');
    expect(button.style.top).toBe('742.5px');
    pause.mockRestore();
  });

  it('没有独立循环片段时，主视频停在尾帧且不重复播放', () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    seedChoicePoint({
      currentClipUrl: 'tail.mp4',
      currentChoices: [{
        index: 0,
        text: '锁定小地精',
        interaction: {
          presentation: 'object-anchor',
          anchor: { x: 0.3, y: 0.6 },
          uiStyle: 'tag',
        },
      }],
    });
    const { getByRole } = render(<StoryPlayerOverlay />);
    const video = document.body.querySelector('video')!;
    Object.defineProperties(video, {
      duration: { configurable: true, value: 5 },
      currentTime: { configurable: true, value: 4.9 },
    });

    act(() => fireEvent.timeUpdate(video));
    act(() => vi.advanceTimersByTime(initMs));

    expect(pause).toHaveBeenCalled();
    expect(video.loop).toBe(false);
    expect(getByRole('button', { name: '锁定小地精' })).toBeInTheDocument();
    pause.mockRestore();
  });

  it('极短视频等待 ended，不会在首个 timeupdate 时提前冻结', () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    seedChoicePoint({ currentClipUrl: 'short.mp4' });
    render(<StoryPlayerOverlay />);
    const video = document.body.querySelector('video')!;
    Object.defineProperties(video, {
      duration: { configurable: true, value: 0.1 },
      currentTime: { configurable: true, value: 0.01 },
    });

    act(() => fireEvent.timeUpdate(video));
    expect(pause).not.toHaveBeenCalled();
    pause.mockRestore();
  });

  it('主视频播完后切换到独立选择动画，并只循环该动画', () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
    seedChoicePoint({
      currentClipUrl: 'story.mp4',
      choiceLoopClipByNodeId: { n1: 'choice-loop.mp4' },
      currentChoices: [{ index: 0, text: '出拳' }],
    });
    render(<StoryPlayerOverlay />);
    const mainVideo = document.body.querySelector('video')!;
    Object.defineProperties(mainVideo, {
      duration: { configurable: true, value: 5 },
      currentTime: { configurable: true, value: 4.9 },
    });

    act(() => fireEvent.timeUpdate(mainVideo));
    const choiceLoopVideo = document.body.querySelector('video')!;

    expect(mainVideo.loop).toBe(false);
    expect(choiceLoopVideo).not.toBe(mainVideo);
    expect(choiceLoopVideo.src).toContain('choice-loop.mp4');
    expect(choiceLoopVideo.loop).toBe(true);
    pause.mockRestore();
  });
});
