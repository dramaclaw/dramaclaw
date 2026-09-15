import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { StoryPlayer } from '@/features/canvas/story/StoryPlayer';
import { useStoryRuntimeStore as store } from '@/stores/storyRuntimeStore';

function enter(ink: string, clips: Record<string, string>, loops: Record<string, string> = {}, placeholders: Record<string, { text: string; label?: string }> = {}) {
  store.getState().enterPlay({
    ink, clipByNodeId: clips, choiceLoopClipByNodeId: loops, knotByNodeId: {},
    choiceTimeByNodeId: {}, defaultChoiceIndexByNodeId: {}, endingByNodeId: {},
    placeholderByNodeId: placeholders, choiceFeedbackById: {}, choiceStateChangesById: {},
    choiceInteractionById: {}, warnings: [], variables: [],
  });
  return render(<StrictMode><StoryPlayer t={(key) => key} /></StrictMode>);
}
const chain = '-> a\n=== a ===\nclip # clip:a\n-> b\n=== b ===\nclip # clip:b\n-> c\n=== c ===\nclip # clip:c\n-> END';
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
});
afterEach(() => { cleanup(); store.getState().exitPlay(); vi.restoreAllMocks(); });

describe('shared player playback visits', () => {
  it('keeps controls hidden until interaction and auto-hides only while playing', () => {
    vi.useFakeTimers();
    try {
      enter('-> a\n=== a ===\nclip # clip:a\n-> END', { a: '/a.mp4' });
      const player = document.querySelector('[data-story-player]')!;
      const controls = document.querySelector('[data-story-player-controls]')!;
      expect(controls).toHaveClass('opacity-0');

      fireEvent.mouseEnter(player);
      fireEvent.pointerMove(player);
      expect(controls).toHaveClass('opacity-0');

      fireEvent.pointerDown(player);
      expect(controls).toHaveClass('opacity-100');
      act(() => vi.advanceTimersByTime(1500));
      expect(controls).toHaveClass('opacity-0');

      fireEvent.pointerDown(player);
      fireEvent.click(controls.querySelector('button')!);
      act(() => vi.advanceTimersByTime(1500));
      expect(controls).toHaveClass('opacity-100');
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports pausing, resuming, and seeking the current clip', async () => {
    enter('-> a\n=== a ===\nclip # clip:a\n-> END', { a: '/a.mp4' });
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'duration', { configurable: true, value: 125 });
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 5 });
    fireEvent.loadedMetadata(video);
    fireEvent.timeUpdate(video);

    const seek = document.querySelector('[data-story-player-seek]') as HTMLInputElement;
    expect(seek.max).toBe('125');
    expect(seek.value).toBe('5');
    expect(document.querySelector('output')?.textContent).toContain('0:05 / 2:05');

    const pauseButton = document.querySelector('button[aria-label="canvas.story.playMode.pauseCurrent"]')!;
    fireEvent.click(pauseButton);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(document.querySelector('button[aria-label="canvas.story.playMode.playCurrent"]')).not.toBeNull();

    fireEvent.change(seek, { target: { value: '62.5' } });
    expect(video.currentTime).toBe(62.5);
    expect(seek.value).toBe('62.5');

    fireEvent.click(document.querySelector('[data-story-player-controls] button')!);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it('shows ending narrative only when the ending has no video', async () => {
    const ink = '-> a\n=== a ===\nclip # clip:a\n-> END';
    const placeholders = { a: { label: '便利店的黎明', text: '你推开店门。\n天终于亮了。' } };
    const view = enter(ink, {}, {}, placeholders);
    await waitFor(() => expect(document.querySelector('[data-story-ending-text]')?.textContent).toBe(placeholders.a.text));
    expect(document.querySelector('[data-story-ending] h2')?.textContent).toBe(placeholders.a.label);
    view.unmount();
    store.getState().exitPlay();
    enter(ink, { a: '/ending.mp4' }, {}, placeholders);
    fireEvent.ended(document.querySelector('video')!);
    expect(document.querySelector('[data-story-ending-text]')).toBeNull();
    expect(store.getState().currentPlaceholder).toBeNull();
  });

  it('waits for each video in consecutive automatic transitions', async () => {
    enter(chain, { a: '/a.mp4', b: '/b.mp4', c: '/c.mp4' });
    fireEvent.ended(document.querySelector('video')!);
    await waitFor(() => expect(document.querySelector('video')?.getAttribute('src')).toBe('/b.mp4'));
    // Allow a mistakenly scheduled second advancement to run.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.getState().currentNodeId).toBe('b');
    fireEvent.ended(document.querySelector('video')!);
    await waitFor(() => expect(store.getState().currentNodeId).toBe('c'));
  });

  it('advances consecutive placeholders until reaching a video', async () => {
    enter(chain, { c: '/c.mp4' });
    await waitFor(() => expect(store.getState().currentNodeId).toBe('c'));
    expect(document.querySelector('video')?.getAttribute('src')).toBe('/c.mp4');
    expect(document.querySelector('[data-story-ending]')).toBeNull();
  });

  it('uses the loaded main video when its URL is also the choice loop', () => {
    enter('-> a\n=== a ===\nclip # clip:a\n+ [继续] -> c\n=== c ===\nclip # clip:c\n-> END', { a: '/a.mp4' }, { a: '/a.mp4' });
    const video = document.querySelector('video')!;
    fireEvent.canPlay(video);
    fireEvent.ended(video);
    expect(document.querySelector('video')!.loop).toBe(true);
    expect(document.querySelector('[data-choice-stage] button')).not.toBeNull();
  });
});
