import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { StoryGestureButton } from '@/features/canvas/story/StoryGestureButton';
import { buildEvAdTemplate } from '@/features/canvas/story/evAdTemplate';
import { compileStoryGroup } from '@/features/canvas/story/compileStoryGroup';
import { safeCtaUrl } from '@/features/canvas/story/storyEvents';
import { Compiler } from 'inkjs/full';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });
describe('ad gestures and graph', () => {
  it.each(['pointerCancel', 'pointerMove', 'blur', 'disabled'] as const)('cancels an active pointer hold once on %s', (reason) => {
    const select = vi.fn();
    const events: string[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent).detail.type);
    window.addEventListener('dramaclaw:story', listener);
    const props = { interaction: { trigger: 'hold' as const }, onSelect: select, eventContext: {} };
    const { getByRole, rerender } = render(<StoryGestureButton {...props}>启动</StoryGestureButton>);
    const button = getByRole('button');
    button.setPointerCapture = vi.fn();
    const pointer = (type: string, x = 0) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperties(event, {
        button: { value: 0 }, pointerId: { value: 1 },
        clientX: { value: x }, clientY: { value: 0 },
      });
      fireEvent(button, event);
    };
    try {
      pointer('pointerdown');
      act(() => vi.advanceTimersByTime(400));
      if (reason === 'pointerCancel') pointer('pointercancel');
      if (reason === 'pointerMove') pointer('pointermove', 20);
      if (reason === 'blur') fireEvent(window, new Event('blur'));
      if (reason === 'disabled') rerender(<StoryGestureButton {...props} disabled>启动</StoryGestureButton>);
      pointer('pointerup');
      act(() => vi.advanceTimersByTime(1500));
      expect(select).not.toHaveBeenCalled();
      expect(events).toEqual(['hold_start', 'hold_cancel']);
      expect(button.querySelector('[data-hold-arc]')?.getAttribute('opacity')).toBe('0');
    } finally {
      window.removeEventListener('dramaclaw:story', listener);
    }
  });

  it('text holds draw progress around the label without a circular indicator', () => {
    const { container, getByRole } = render(<StoryGestureButton interaction={{ trigger: 'hold', presentation: 'overlay' }} onSelect={vi.fn()} eventContext={{}}>周末跑山</StoryGestureButton>);
    expect(container.querySelector('circle')).toBeNull();
    const perimeter = container.querySelector('[data-hold-perimeter]')!;
    fireEvent.keyDown(getByRole('button'), { key: ' ' });
    act(() => vi.advanceTimersByTime(500));
    expect(Number(perimeter.getAttribute('stroke-dashoffset'))).toBeLessThan(0.6);
    expect(getByRole('button').textContent).toBe('周末跑山');
    fireEvent.keyUp(getByRole('button'), { key: ' ' });
    expect(perimeter.getAttribute('opacity')).toBe('0');
  });
  it('anchored hold uses a circular progress arc and resets on release', () => {
    const { container, getByRole } = render(<StoryGestureButton interaction={{ trigger: 'hold', holdMs: 1000, presentation: 'object-anchor', uiStyle: 'tag' }} aria-label="长按启动" onSelect={vi.fn()} eventContext={{}} />);
    const arc = container.querySelector('[data-hold-arc]')!;
    expect(arc.getAttribute('stroke-dashoffset')).toBe('1');
    fireEvent.keyDown(getByRole('button'), { key: ' ' });
    act(() => vi.advanceTimersByTime(500));
    expect(Number(arc.getAttribute('stroke-dashoffset'))).toBeLessThan(0.6);
    fireEvent.keyUp(getByRole('button'), { key: ' ' });
    expect(arc.getAttribute('stroke-dashoffset')).toBe('1');
    expect(container.querySelectorAll('[data-tech-target]')).toHaveLength(1);
    fireEvent.keyDown(getByRole('button'), { key: ' ' });
    act(() => vi.advanceTimersByTime(1100));
    fireEvent.keyUp(getByRole('button'), { key: ' ' });
    expect(arc.getAttribute('stroke-dashoffset')).toBe('0');
    expect(container.querySelector('[data-tech-target]')?.getAttribute('data-completed')).toBe('true');
  });
  it('hold cancels on early release; a full keyboard hold commits once', () => {
    const select = vi.fn();
    const { getByRole } = render(<StoryGestureButton interaction={{ trigger: 'hold', holdMs: 1000 }} onSelect={select} eventContext={{}}>启动</StoryGestureButton>);
    const button = getByRole('button');
    fireEvent.click(button); expect(select).not.toHaveBeenCalled();
    fireEvent.keyDown(button, { key: ' ' });
    act(() => vi.advanceTimersByTime(600)); fireEvent.keyUp(button, { key: ' ' });
    act(() => vi.advanceTimersByTime(1200)); expect(select).not.toHaveBeenCalled();
    fireEvent.keyDown(button, { key: ' ' }); act(() => vi.advanceTimersByTime(1100));
    fireEvent.keyUp(button, { key: ' ' }); fireEvent.click(button);
    expect(select).toHaveBeenCalledTimes(1);
  });
  it('unmount cancels pending holds', () => {
    const select = vi.fn();
    const { getByRole, unmount } = render(<StoryGestureButton interaction={{ trigger: 'hold' }} onSelect={select} eventContext={{}}>启动</StoryGestureButton>);
    fireEvent.keyDown(getByRole('button'), { key: 'Enter' }); unmount();
    act(() => vi.advanceTimersByTime(2000)); expect(select).not.toHaveBeenCalled();
  });
  it('route choices respond to a click', () => {
    const select = vi.fn();
    const { getByRole } = render(<StoryGestureButton interaction={{ trigger: 'click' }} onSelect={select} eventContext={{}}>通勤</StoryGestureButton>);
    fireEvent.click(getByRole('button'));
    expect(select).toHaveBeenCalledTimes(1);
  });
  it('both routes compile to distinct CTA endings, overlay holds survive compilation', () => {
    const graph = buildEvAdTemplate(undefined, 'test');
    const compiled = compileStoryGroup(graph.groupId, graph.nodes, graph.edges);
    expect(Object.values(compiled.choiceInteractionById).map(i => i.trigger)).toEqual(['hold']);
    for (const route of [0, 1]) {
      const story = new Compiler(compiled.ink).Compile();
      story.Continue(); story.ChooseChoiceIndex(0); story.Continue(); story.Continue();
      expect(story.currentChoices).toHaveLength(2);
      story.ChooseChoiceIndex(route); story.Continue();
      expect(story.currentTags?.join(' ')).toContain(route === 0 ? 'commute' : 'mountain');
    }
    expect(Object.values(compiled.endingByNodeId).map(e => e.cta?.url)).toEqual(['', '']);
  });
  it('CTA only permits absolute HTTPS destinations without credentials', () => {
    for (const url of ['', 'javascript:alert(1)', '//example.com', 'https://user:pass@example.com']) expect(safeCtaUrl(url)).toBeNull();
    expect(safeCtaUrl('https://example.com/book?route=commute')).toContain('route=commute');
  });
});
