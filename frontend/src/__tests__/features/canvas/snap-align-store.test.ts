// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('snap align preference', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.resetModules();
  });

  it('is enabled by default for users without a saved preference', async () => {
    const { useSnapAlignStore } = await import(
      '@/features/canvas/snap-align/snapAlignStore'
    );

    expect(useSnapAlignStore.getState().enabled).toBe(true);
  });

  it('migrates an old disabled preference to enabled for the v2 interaction', async () => {
    window.localStorage.setItem('canvas.snapAlign.enabled', '0');
    const { useSnapAlignStore } = await import(
      '@/features/canvas/snap-align/snapAlignStore'
    );

    expect(useSnapAlignStore.getState().enabled).toBe(true);
    expect(window.localStorage.getItem('canvas.snapAlign.enabled')).toBe('1');
    expect(window.localStorage.getItem('canvas.snapAlign.preferenceVersion')).toBe('2');
  });

  it('respects an explicit v2 disabled preference and persists later toggles', async () => {
    window.localStorage.setItem('canvas.snapAlign.preferenceVersion', '2');
    window.localStorage.setItem('canvas.snapAlign.enabled', '0');
    const { useSnapAlignStore } = await import(
      '@/features/canvas/snap-align/snapAlignStore'
    );

    expect(useSnapAlignStore.getState().enabled).toBe(false);
    useSnapAlignStore.getState().toggle();
    expect(useSnapAlignStore.getState().enabled).toBe(true);
    expect(window.localStorage.getItem('canvas.snapAlign.enabled')).toBe('1');
  });
});
