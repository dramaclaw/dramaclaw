// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useFreezoneDockOffset } from '@/features/freezone/useFreezoneDockOffset';
import { FREEZONE_DOCK_OFFSET_ANIMATED_STYLE, FREEZONE_DOCK_TRANSITION_VAR, FREEZONE_DOCK_WIDTH_VAR } from '@/features/freezone/dockOffset';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('reserves the measured dock width, follows resizing, and releases space on close', () => {
  let notifyResize: () => void = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { notifyResize = callback; }
    observe = vi.fn();
    disconnect = disconnect;
  });
  const aside = document.createElement('aside');
  let width = 480;
  vi.spyOn(aside, 'getBoundingClientRect').mockImplementation(() => ({ width }) as DOMRect);
  const ref = { current: aside };
  const style = document.documentElement.style;
  const view = renderHook(({ active, resizing }) => useFreezoneDockOffset(ref, active, resizing), {
    initialProps: { active: false, resizing: false },
  });
  expect(style.getPropertyValue(FREEZONE_DOCK_WIDTH_VAR)).toBe('');
  view.rerender({ active: true, resizing: false });
  expect(style.getPropertyValue(FREEZONE_DOCK_WIDTH_VAR)).toBe('480px');
  expect(style.getPropertyValue(FREEZONE_DOCK_TRANSITION_VAR)).toBe('300ms');
  view.rerender({ active: true, resizing: true });
  width = 680; // Chat plus agent history, or a user dragging the dock wider.
  act(() => notifyResize());
  expect(style.getPropertyValue(FREEZONE_DOCK_WIDTH_VAR)).toBe('680px');
  expect(style.getPropertyValue(FREEZONE_DOCK_TRANSITION_VAR)).toBe('0ms');
  view.rerender({ active: true, resizing: false });
  width = 604; // A narrower desktop viewport clamps the dock's actual width.
  act(() => notifyResize());
  expect(style.getPropertyValue(FREEZONE_DOCK_WIDTH_VAR)).toBe('604px');
  expect(style.getPropertyValue(FREEZONE_DOCK_TRANSITION_VAR)).toBe('0ms');
  view.rerender({ active: false, resizing: false });
  expect(style.getPropertyValue(FREEZONE_DOCK_WIDTH_VAR)).toBe('');
  expect(style.getPropertyValue(FREEZONE_DOCK_TRANSITION_VAR)).toBe('');
  // Closing removes both variables: margin must snap with max-width instead
  // of falling back to a lingering 300ms slide. Background hover still fades.
  expect(FREEZONE_DOCK_OFFSET_ANIMATED_STYLE.transitionProperty).toBe('margin, background-color');
  expect(FREEZONE_DOCK_OFFSET_ANIMATED_STYLE.transitionDuration).toBe(
    `var(${FREEZONE_DOCK_TRANSITION_VAR}, 0ms), 300ms`,
  );
  expect(disconnect).toHaveBeenCalled();
  view.rerender({ active: true, resizing: false });
  view.unmount();
  expect(style.getPropertyValue(FREEZONE_DOCK_WIDTH_VAR)).toBe('');
});
