// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useSyncExternalStore } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseStableCanvasTier } from '@/features/canvas/application/canvasPreviewPolicy';
import { useNodeBodyVariant } from '@/features/canvas/hooks/useNodeBodyVariantBudget';
import { canvasPreviewImage } from '@/features/canvas/application/imageData';

let transform: [number, number, number] = [0, 0, 1];
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
vi.mock('@xyflow/react', () => ({ useStore: (select: (state: { transform: typeof transform }) => unknown) =>
  useSyncExternalStore(subscribe, () => select({ transform })) }));
afterEach(() => { vi.unstubAllGlobals(); transform = [0, 0, 1]; });

describe('stable canvas preview tiers', () => {
  it('uses all tiers, upgrades immediately, and downgrades with twenty percent headroom', () => {
    expect([320, 321, 640, 641, 1280, 1281].map(n => chooseStableCanvasTier(undefined, n)))
      .toEqual(['thumb', 'thumb2x', 'thumb2x', 'card', 'card', null]);
    expect(chooseStableCanvasTier('thumb', 321)).toBe('thumb2x');
    expect(chooseStableCanvasTier('thumb2x', 257)).toBe('thumb2x');
    expect(chooseStableCanvasTier('thumb2x', 256)).toBe('thumb');
    expect(chooseStableCanvasTier('card', 512)).toBe('thumb2x');
    expect(chooseStableCanvasTier(null, 1024)).toBe('card');
    expect(chooseStableCanvasTier(null, 1025)).toBeNull();
    expect(chooseStableCanvasTier('thumb', Infinity)).toBeNull();
  });

  it('does not alternate tiers when repeatedly crossing the old boundary', () => {
    let tier = chooseStableCanvasTier(undefined, 300);
    for (let n = 0; n < 10; n++) {
      tier = chooseStableCanvasTier(tier, 325); expect(tier).toBe('thumb2x');
      tier = chooseStableCanvasTier(tier, 315); expect(tier).toBe('thumb2x');
    }
  });

  it('keeps the selector pure and causes zero renders over one hundred pan updates', () => {
    vi.stubGlobal('devicePixelRatio', 1);
    let renders = 0;
    const view = renderHook(() => { renders++; return useNodeBodyVariant({ width: 300, height: 200 }); });
    expect(view.result.current).toBe('thumb');
    const initial = renders;
    for (let i = 0; i < 100; i++) act(() => { transform = [i, i, 1]; listeners.forEach(fn => fn()); });
    expect(renders).toBe(initial);
    act(() => { transform = [100, 100, 1.1]; listeners.forEach(fn => fn()); });
    expect(view.result.current).toBe('thumb2x');
    act(() => { transform = [100, 100, 1]; listeners.forEach(fn => fn()); });
    expect(view.result.current).toBe('thumb2x');
    vi.stubGlobal('devicePixelRatio', 2); view.rerender();
    expect(view.result.current).toBe('thumb2x');
    act(() => { transform = [100, 100, 1.1]; listeners.forEach(fn => fn()); });
    expect(view.result.current).toBe('card');
  });

  it('keeps signed and video snapshot addresses intact while adapting local and OSS posters', () => {
    const local = canvasPreviewImage('/static/projects/p/videos/poster.jpg', 'card');
    expect(local).toMatchObject({ src: '/static/projects/p/videos/poster.jpg?st_thumb=card', downscaled: true, maxEdge: 1280 });
    const remote = 'https://libtv-res.liblib.art/a.jpg';
    expect(canvasPreviewImage(remote, 'thumb2x')?.src).toContain('w_640');
    for (const url of [`${remote}?x-oss-process=image/resize,w_320&Signature=hidden`, `${remote}?x-oss-process=video/snapshot,t_0`, 'blob:test', 'data:image/png;base64,AAAA', 'https://unknown.example/a.jpg']) {
      expect(canvasPreviewImage(url, 'card')).toEqual({ src: url, original: url, downscaled: false, maxEdge: null });
    }
  });
});
