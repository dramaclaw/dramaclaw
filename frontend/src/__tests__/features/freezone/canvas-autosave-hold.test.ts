// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  holdCanvasAutosave,
  isCanvasAutosaveHeld,
  subscribeCanvasAutosaveRelease,
} from '@/features/freezone/canvasAutosaveHold';

describe('canvasAutosaveHold', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds a project until every holder releases, then notifies once', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeCanvasAutosaveRelease(listener);

    const releaseA = holdCanvasAutosave('proj');
    const releaseB = holdCanvasAutosave('proj');
    expect(isCanvasAutosaveHeld('proj')).toBe(true);
    expect(isCanvasAutosaveHeld('other')).toBe(false);

    releaseA();
    expect(isCanvasAutosaveHeld('proj')).toBe(true);
    expect(listener).not.toHaveBeenCalled();

    releaseB();
    expect(isCanvasAutosaveHeld('proj')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('proj');

    // Releasing twice is a no-op.
    releaseB();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('lets go on its own after the safety timeout so a lost promise never wedges autosave', () => {
    const listener = vi.fn();
    subscribeCanvasAutosaveRelease(listener);
    holdCanvasAutosave('proj', { maxMs: 1_000 });

    vi.advanceTimersByTime(999);
    expect(isCanvasAutosaveHeld('proj')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isCanvasAutosaveHeld('proj')).toBe(false);
    expect(listener).toHaveBeenCalledWith('proj');
  });
});
