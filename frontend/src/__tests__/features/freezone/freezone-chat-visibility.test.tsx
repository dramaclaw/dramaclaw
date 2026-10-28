// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFreezoneChatVisibility } from '@/features/freezone/useFreezoneChatVisibility';
import type { FreezoneViewMode } from '@/features/freezone/useFreezoneViewMode';

type ViewProps = { mode: FreezoneViewMode; active: boolean };
type ComposeProps = ViewProps & { compose: boolean };

function renderVisibility(mode: FreezoneViewMode = 'workflow') {
  return renderHook(({ mode, active }: ViewProps) => useFreezoneChatVisibility(mode, active), {
    initialProps: { mode, active: true },
  });
}

describe('freezone chat visibility per view', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('auto-opens in storyboard and restores a closed workflow without persisting the auto-open', () => {
    const { result, rerender } = renderVisibility();
    expect(result.current[0]).toBe(false);
    rerender({ mode: 'board', active: true });
    expect(result.current[0]).toBe(true);
    expect(localStorage.getItem('st.freezone.chatOpen')).toBe('0');
    rerender({ mode: 'workflow', active: true });
    expect(result.current[0]).toBe(false);
  });

  it('preserves an open workflow even when the user closes the storyboard panel', () => {
    const { result, rerender } = renderVisibility();
    act(() => result.current[1](true));
    expect(localStorage.getItem('st.freezone.chatOpen')).toBe('1');
    rerender({ mode: 'board', active: true });
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem('st.freezone.chatOpen')).toBe('1');
    rerender({ mode: 'workflow', active: true });
    expect(result.current[0]).toBe(true);
    act(() => result.current[1](false));
    expect(localStorage.getItem('st.freezone.chatOpen')).toBe('0');
  });

  it('honors manual closing for a board visit, then opens again on the next visit', () => {
    const { result, rerender } = renderVisibility('board');
    act(() => result.current[1](false));
    rerender({ mode: 'board', active: true });
    expect(result.current[0]).toBe(false);
    rerender({ mode: 'workflow', active: true });
    expect(result.current[0]).toBe(false);
    rerender({ mode: 'board', active: true });
    expect(result.current[0]).toBe(true);
  });

  it('starts a restored storyboard open while retaining the saved workflow preference', () => {
    localStorage.setItem('st.freezone.chatOpen', '1');
    const { result, rerender } = renderVisibility('board');
    expect(result.current[0]).toBe(true);
    act(() => result.current[1](false));
    rerender({ mode: 'workflow', active: true });
    expect(result.current[0]).toBe(true);
    expect(localStorage.getItem('st.freezone.chatOpen')).toBe('1');
  });

  it('reopens a cached storyboard when it becomes active without changing the workflow', () => {
    const { result, rerender } = renderVisibility('board');
    act(() => result.current[1](false));
    rerender({ mode: 'board', active: false });
    expect(result.current[0]).toBe(false);
    rerender({ mode: 'board', active: true });
    expect(result.current[0]).toBe(true);
    rerender({ mode: 'workflow', active: true });
    expect(result.current[0]).toBe(false);
  });

  it('keeps the setter stable and applies existing event handlers to the current view', () => {
    const { result, rerender } = renderVisibility();
    const setOpen = result.current[1];
    rerender({ mode: 'board', active: true });
    expect(result.current[1]).toBe(setOpen);
    act(() => setOpen(false));
    expect(result.current[0]).toBe(false);
    rerender({ mode: 'workflow', active: true });
    act(() => setOpen(true));
    expect(result.current[0]).toBe(true);
    expect(localStorage.getItem('st.freezone.chatOpen')).toBe('1');
  });

  it('opens compose by default, honors closing, and reopens on the next entry', () => {
    const { result, rerender } = renderHook(
      ({ mode, active, compose }: ComposeProps) =>
        useFreezoneChatVisibility(mode, active, compose),
      {
        initialProps: {
          mode: 'workflow' as FreezoneViewMode,
          active: true,
          compose: false,
        },
      },
    );
    expect(result.current[0]).toBe(false);
    rerender({ mode: 'workflow', active: true, compose: true });
    expect(result.current[0]).toBe(true);
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem('st.freezone.chatOpen')).toBe('0');
    rerender({ mode: 'workflow', active: true, compose: false });
    expect(result.current[0]).toBe(false);
    rerender({ mode: 'workflow', active: true, compose: true });
    expect(result.current[0]).toBe(true);
  });

  it('leaves the saved workflow preference untouched while composing', () => {
    localStorage.setItem('st.freezone.chatOpen', '1');
    const { result, rerender } = renderHook(
      ({ mode, active, compose }: ComposeProps) =>
        useFreezoneChatVisibility(mode, active, compose),
      {
        initialProps: {
          mode: 'workflow' as FreezoneViewMode,
          active: true,
          compose: true,
        },
      },
    );
    expect(result.current[0]).toBe(true);
    act(() => result.current[1](false));
    expect(localStorage.getItem('st.freezone.chatOpen')).toBe('1');
    rerender({ mode: 'workflow', active: true, compose: false });
    expect(result.current[0]).toBe(true);
  });

  it('keeps in-memory behavior when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const { result, rerender } = renderVisibility();
    act(() => result.current[1](true));
    rerender({ mode: 'board', active: true });
    act(() => result.current[1](false));
    rerender({ mode: 'workflow', active: true });
    expect(result.current[0]).toBe(true);
  });
});
