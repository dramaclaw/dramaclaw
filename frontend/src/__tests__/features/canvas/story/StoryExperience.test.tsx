import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { StoryExperience } from '@/features/canvas/story/StoryExperience';
import { useStoryRuntimeStore as runtime } from '@/stores/storyRuntimeStore';
import { CHOICE_STAGE_TIMING } from '@/components/canvas/useChoicePointMachine';
import { STORY_OUTCOME_FEEDBACK_MS } from '@/features/canvas/story/StoryPlayer';
import type { CompiledStory } from '@/features/canvas/story/storyTypes';

const ink = 'VAR score = 0\n-> intro\n=== intro ===\nclip # clip:intro\n+ [走左边]\n~ score += 5\n-> left\n+ [走右边] -> right\n=== left ===\nclip # clip:left\n+ [完成] -> end\n=== right ===\nclip # clip:right\n+ [完成] -> end\n=== end ===\nclip # clip:end\n-> END';
const t = (key: string, values?: Record<string, unknown>) => i18next.t(key, values ?? {}) as string;
function enter(over: Partial<CompiledStory> = {}) {
  runtime.getState().enterPlay({
    ink, clipByNodeId: { intro: '/intro.mp4', left: '/left.mp4', right: '/right.mp4', end: '/end.mp4' },
    choiceLoopClipByNodeId: {}, knotByNodeId: {}, choiceTimeByNodeId: {}, defaultChoiceIndexByNodeId: {},
    endingByNodeId: { end: { title: '秘密结局' } }, placeholderByNodeId: {}, choiceFeedbackById: {},
    choiceStateChangesById: {}, choiceInteractionById: {}, warnings: [], variables: [],
    explorationNodes: [
      { id: 'intro', label: '开场', successors: ['left', 'right'], isEnding: false },
      { id: 'left', label: '左边剧情', successors: ['end'], isEnding: false },
      { id: 'right', label: '秘密右边剧情', successors: ['end'], isEnding: false },
      { id: 'end', label: '秘密结局', successors: [], isEnding: true },
    ], ...over,
  }, { saveKey: 'dramaclaw.player.save.ui.v1', embedded: true });
  return render(<StoryExperience t={t} />);
}
function finishClip() { fireEvent.ended(document.querySelector('[data-story-player] video')!); }
function map() { fireEvent.click(screen.getByRole('button', { name: '打开剧情探索' })); return screen.getByRole('dialog'); }
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: true });
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: false }); return Promise.resolve();
  });
});
afterEach(() => { cleanup(); runtime.getState().exitPlay(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('unified story exploration experience', () => {
  it('shows locked titles and keeps only replay on experienced clips', () => {
    enter();
    const initial = map();
    expect(within(initial).getByRole('button', { name: /秘密右边剧情/ })).toBeDisabled();
    expect(within(initial).getByRole('button', { name: /秘密结局/ })).toBeDisabled();
    expect(initial.querySelector('.story-exploration-route')).toBeNull();
    expect(initial.querySelector('.story-exploration-summary')).toHaveTextContent('已解锁 0/4 个片段');
    fireEvent.click(within(initial).getByRole('button', { name: '关闭剧情探索' }));
    finishClip();
    const dialog = map();
    fireEvent.click(within(dialog).getByRole('button', { name: /开场/ }));
    expect(within(dialog).getByRole('button', { name: '重玩' })).toBeEnabled();
    expect(within(dialog).queryByRole('button', { name: '回看片段' })).not.toBeInTheDocument();
    expect(dialog.querySelector('video')).toBeNull();
  });

  it('pauses and resumes the remaining choice countdown instead of restarting it', () => {
    enter({ choiceTimeByNodeId: { intro: 10 }, defaultChoiceIndexByNodeId: { intro: 0 } });
    finishClip();
    act(() => vi.advanceTimersByTime(CHOICE_STAGE_TIMING.initMs));
    act(() => vi.advanceTimersByTime(4000));
    const dialog = map();
    act(() => vi.advanceTimersByTime(30000));
    expect(runtime.getState().currentNodeId).toBe('intro');
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭剧情探索' }));
    act(() => vi.advanceTimersByTime(5900));
    expect(runtime.getState().currentNodeId).toBe('intro');
    act(() => vi.advanceTimersByTime(100));
    act(() => vi.advanceTimersByTime(CHOICE_STAGE_TIMING.confirmMs));
    expect(runtime.getState().currentNodeId).toBe('left');
  });

  it('pauses pending confirmations and feedback and cancels them when rewinding', () => {
    enter(); finishClip();
    act(() => vi.advanceTimersByTime(CHOICE_STAGE_TIMING.initMs));
    fireEvent.click(screen.getByRole('button', { name: '走左边' }));
    act(() => vi.advanceTimersByTime(200));
    const dialog = map();
    act(() => vi.advanceTimersByTime(3000));
    expect(runtime.getState().currentNodeId).toBe('intro');
    fireEvent.click(within(dialog).getByRole('button', { name: /开场/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: '重玩' }));
    act(() => vi.advanceTimersByTime(3000));
    expect(runtime.getState().currentNodeId).toBe('intro');
    expect(runtime.getState().story!.variablesState.$('score')).toBe(0);
  });

  it('pauses a feedback transition while the map is open', () => {
    enter({ ink: ink.replace('[走左边]', '[走左边 # choice-feedback: outcome]'), choiceFeedbackById: { outcome: '选择已记录' } });
    finishClip(); act(() => vi.advanceTimersByTime(CHOICE_STAGE_TIMING.initMs));
    fireEvent.click(screen.getByRole('button', { name: '走左边' }));
    act(() => vi.advanceTimersByTime(CHOICE_STAGE_TIMING.confirmMs));
    act(() => vi.advanceTimersByTime(500));
    expect(screen.getByText('选择已记录')).toBeInTheDocument();
    const dialog = map(); act(() => vi.advanceTimersByTime(5000));
    expect(runtime.getState().currentNodeId).toBe('intro');
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭剧情探索' }));
    act(() => vi.advanceTimersByTime(STORY_OUTCOME_FEEDBACK_MS - 500));
    expect(runtime.getState().currentNodeId).toBe('left');
  });

  it('resumes playing video after closing the map but preserves a manual pause', () => {
    enter(); const video = document.querySelector('[data-story-player] video') as HTMLVideoElement;
    fireEvent.canPlay(video); expect(video.paused).toBe(false);
    let dialog = map(); expect(video.paused).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭剧情探索' }));
    expect(video.paused).toBe(false);
    video.pause(); fireEvent.pause(video);
    dialog = map(); fireEvent.click(within(dialog).getByRole('button', { name: '关闭剧情探索' }));
    expect(video.paused).toBe(true);
  });

  it('starts video loaded while the exploration map was open', () => {
    enter();
    const video = document.querySelector('[data-story-player] video') as HTMLVideoElement;
    const dialog = map();
    fireEvent.canPlay(video);
    expect(video.paused).toBe(true);
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭剧情探索' }));
    expect(video.paused).toBe(false);
  });

  it('does not restart manually paused video when canplay fires behind the map', () => {
    enter();
    const video = document.querySelector('[data-story-player] video') as HTMLVideoElement;
    fireEvent.canPlay(video);
    video.pause(); fireEvent.pause(video);
    const dialog = map();
    fireEvent.canPlay(video);
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭剧情探索' }));
    expect(video.paused).toBe(true);
  });

  it('pauses an automatic placeholder and continues its remaining reading time', () => {
    enter({ ink: '-> intro\n=== intro ===\nclip # clip:intro\n-> left\n=== left ===\nclip # clip:left\n-> END',
      clipByNodeId: { intro: '', left: '/left.mp4' }, placeholderByNodeId: { intro: { text: '等待' } } });
    act(() => vi.advanceTimersByTime(1000));
    const dialog = map();
    act(() => vi.advanceTimersByTime(30000));
    expect(runtime.getState().currentNodeId).toBe('intro');
    expect(runtime.getState().exploration.completedNodeIds).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭剧情探索' }));
    act(() => vi.advanceTimersByTime(1499));
    expect(runtime.getState().currentNodeId).toBe('intro');
    act(() => vi.advanceTimersByTime(1));
    expect(runtime.getState().currentNodeId).toBe('left');
    expect(runtime.getState().exploration.completedNodeIds).toEqual(['intro']);
  });

  it('requires a separate confirmation to clear discoveries and the active save', () => {
    enter(); finishClip();
    act(() => runtime.getState().choose(0));
    const dialog = map();
    const before = runtime.getState().exploration;
    fireEvent.click(within(dialog).getByRole('button', { name: '清除探索进度' }));
    expect(runtime.getState().exploration).toBe(before);
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(runtime.getState().currentNodeId).toBe('left');
    const clear = within(dialog).getByRole('button', { name: '清除探索进度' });
    expect(clear.closest('.story-graph-tool-group')).toBeNull();
    expect(clear).toHaveTextContent('');
    expect(dialog.querySelector('footer')).toBeNull();
    fireEvent.click(clear);
    const confirmation = dialog.querySelector('.story-graph-clear-confirmation') as HTMLElement;
    fireEvent.click(within(confirmation).getByRole('button', { name: '清除探索进度' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(runtime.getState().currentNodeId).toBe('intro');
    expect(runtime.getState().exploration.completedNodeIds).toEqual([]);
  });

  it('keeps exploration focused on the map without creator statistics', () => {
    enter(); finishClip();
    act(() => runtime.getState().choose(0));
    const dialog = map();
    expect(within(dialog).queryByText('创作者试玩统计')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('选择分布')).not.toBeInTheDocument();
    expect(dialog.querySelector('details')).toBeNull();
    expect(within(dialog).getByRole('region', { name: '剧情地图' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '路径回顾图' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '试玩统计' })).not.toBeInTheDocument();
  });

  it('places the entire interactive experience in fullscreen and tracks browser exits', async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    const original = HTMLElement.prototype.requestFullscreen;
    HTMLElement.prototype.requestFullscreen = request;
    try {
      const view = enter();
      await act(async () => fireEvent.click(screen.getByRole('button', { name: '全屏体验' })));
      expect(request).toHaveBeenCalledWith({ navigationUI: 'hide' });
      expect(request.mock.instances[0]).toBe(view.container.querySelector('.story-experience'));
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: request.mock.instances[0] });
      fireEvent(document, new Event('fullscreenchange'));
      expect(screen.getByRole('button', { name: '退出全屏' })).toBeInTheDocument();
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
      fireEvent(document, new Event('fullscreenchange'));
      expect(screen.getByRole('button', { name: '全屏体验' })).toBeInTheDocument();
    } finally { HTMLElement.prototype.requestFullscreen = original; }
  });

  it('falls back to immersive mode when fullscreen is rejected without resetting progress', async () => {
    const original = HTMLElement.prototype.requestFullscreen;
    HTMLElement.prototype.requestFullscreen = vi.fn().mockRejectedValue(new Error('denied'));
    try {
      const view = enter(); finishClip();
      const progress = runtime.getState().exploration;
      await act(async () => fireEvent.click(screen.getByRole('button', { name: '全屏体验' })));
      expect(view.container.querySelector('.story-experience')).toHaveAttribute('data-immersive', 'true');
      expect(runtime.getState().exploration).toBe(progress);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(view.container.querySelector('.story-experience')).not.toHaveAttribute('data-immersive');
    } finally { HTMLElement.prototype.requestFullscreen = original; }
  });

  it('returns to the preceding decision with one click while preserving discoveries', () => {
    enter(); finishClip();
    act(() => runtime.getState().choose(0));
    expect(runtime.getState().story!.variablesState.$('score')).toBe(5);
    fireEvent.click(screen.getByRole('button', { name: '返回上一个选择点' }));
    expect(runtime.getState().currentNodeId).toBe('intro');
    expect(runtime.getState().story!.variablesState.$('score')).toBe(0);
    expect(runtime.getState().exploration.completedNodeIds).toEqual(['intro']);
    expect(screen.queryByRole('button', { name: '返回上一个选择点' })).not.toBeInTheDocument();
  });

  it('only allows skipping an experienced segment and still requires a fresh branch choice', () => {
    enter();
    let video = document.querySelector('[data-story-player] video')!;
    Object.defineProperty(video, 'duration', { configurable: true, value: 60 });
    fireEvent.loadedMetadata(video);
    expect(screen.queryByRole('button', { name: '跳过已看片段' })).not.toBeInTheDocument();
    finishClip();
    act(() => runtime.getState().choose(0));
    fireEvent.click(screen.getByRole('button', { name: '返回上一个选择点' }));
    video = document.querySelector('[data-story-player] video')!;
    Object.defineProperty(video, 'duration', { configurable: true, value: 60 });
    fireEvent.loadedMetadata(video);
    fireEvent.click(screen.getByRole('button', { name: '跳过已看片段' }));
    expect(runtime.getState().currentNodeId).toBe('intro');
    act(() => vi.advanceTimersByTime(CHOICE_STAGE_TIMING.initMs));
    expect(screen.getByRole('button', { name: '走右边' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '走右边' }));
    act(() => vi.advanceTimersByTime(CHOICE_STAGE_TIMING.confirmMs));
    expect(runtime.getState().currentNodeId).toBe('right');
    expect(runtime.getState().story!.variablesState.$('score')).toBe(0);
  });

  it('runs automatic transition effects normally when skipping a known segment', () => {
    enter({ ink: 'VAR score = 0\n-> intro\n=== intro ===\nclip # clip:intro\n~ score += 5\n-> left\n=== left ===\nclip # clip:left\n-> END' });
    finishClip(); act(() => vi.advanceTimersByTime(1));
    expect(runtime.getState().story!.variablesState.$('score')).toBe(5);
    act(() => runtime.getState().rewindToNode('intro'));
    expect(runtime.getState().story!.variablesState.$('score')).toBe(0);
    const video = document.querySelector('[data-story-player] video')!;
    Object.defineProperty(video, 'duration', { configurable: true, value: 60 });
    fireEvent.loadedMetadata(video);
    fireEvent.click(screen.getByRole('button', { name: '跳过已看片段' }));
    act(() => vi.advanceTimersByTime(1));
    expect(runtime.getState().currentNodeId).toBe('left');
    expect(runtime.getState().story!.variablesState.$('score')).toBe(5);
  });

  it('offers exploration and the last decision after an ending is actually experienced', () => {
    enter();
    act(() => { runtime.getState().choose(0); runtime.getState().choose(0); });
    expect(screen.queryByRole('button', { name: '探索其他路线' })).not.toBeInTheDocument();
    finishClip();
    expect(screen.getByText('已达成 1/1 个结局 · 探索 75%')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '探索其他路线' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '关闭剧情探索' }));
    fireEvent.click(screen.getByRole('button', { name: '返回关键选择点' }));
    expect(runtime.getState().currentNodeId).toBe('left');
    expect(runtime.getState().exploration.reachedEndingIds).toEqual(['end']);
  });

  it('shows the connection map on desktop and preserves node actions', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    enter(); finishClip();
    const dialog = map();
    expect(within(dialog).getByRole('region', { name: '剧情地图' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '显示全图' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: /秘密右边剧情/ })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: /开场/ }));
    const replay = within(dialog).getByRole('button', { name: '重玩' });
    expect(replay).toBeEnabled();
    expect(replay.closest('.story-graph-node')).toHaveTextContent('开场');
    expect(dialog.querySelector('.story-exploration-actions')).toBeNull();
  });
});
