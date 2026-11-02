// SPDX-License-Identifier: Elastic-2.0
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ViewportLazyVideo } from '@/components/viewport-lazy-video';

let intersect!: (visible: boolean) => void;
const disconnect = vi.fn();
beforeEach(() => {
  disconnect.mockClear();
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) {
      intersect = visible => callback([{ isIntersecting: visible, intersectionRatio: visible ? 1 : 0 } as IntersectionObserverEntry], {} as IntersectionObserver);
    }
    observe() { }
    disconnect = disconnect;
  });
});
afterEach(() => vi.unstubAllGlobals());

it('does not load offscreen video and reveals a muted, passive first frame when visible', () => {
  const view = render(<ViewportLazyVideo src="/static/clip.mp4" />);
  const video = view.container.querySelector('video')!;
  expect(video).not.toHaveAttribute('src');
  act(() => intersect(false));
  expect(video).not.toHaveAttribute('src');
  act(() => intersect(true));
  expect(video).toHaveAttribute('src', '/static/clip.mp4#t=0.1');
  expect(video.muted).toBe(true);
  expect(video.autoplay).toBe(false);
  expect(video.controls).toBe(false);
  expect(disconnect).toHaveBeenCalled();
});

it('does not retain the old decoder or source when a thumbnail changes before visibility', () => {
  const view = render(<ViewportLazyVideo src="/static/first.mp4" />);
  act(() => intersect(true));
  const first = view.container.querySelector('video')!;
  view.rerender(<ViewportLazyVideo src="/static/second.mp4" />);
  const second = view.container.querySelector('video')!;
  expect(second).not.toBe(first);
  expect(second).not.toHaveAttribute('src');
  act(() => intersect(true));
  expect(second).toHaveAttribute('src', '/static/second.mp4#t=0.1');
});
