import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
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
