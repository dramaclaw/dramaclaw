// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPreviewDecodeQueue, canvasPreviewDecodeQueue } from '@/features/canvas/application/canvasPreviewDecodeQueue';
import { useDecodedNodeImage } from '@/features/canvas/hooks/useDecodedNodeImage';
import type { NodeBodyImage } from '@/features/canvas/application/imageData';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
function fakeImage() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const image = { naturalWidth: 320, complete: false, onload: null, onerror: null, src: '', decoding: '',
    decode: () => new Promise<void>((ok, fail) => { resolve = ok; reject = fail; }) } as unknown as HTMLImageElement;
  return { image, load: () => image.onload?.call(image, new Event('load')), ok: () => resolve(), fail: () => reject(new Error('decode')) };
}

describe('preview decode queue', () => {
  it('deduplicates URLs and starts at most four active jobs', async () => {
    const workers: ReturnType<typeof fakeImage>[] = [];
    const queue = createPreviewDecodeQueue(() => { const worker = fakeImage(); workers.push(worker); return worker.image; });
    const first = vi.fn(); const duplicate = vi.fn();
    queue.request('/0', first); queue.request('/0', duplicate);
    for (let n = 1; n < 6; n++) queue.request(`/${n}`, vi.fn());
    expect(workers).toHaveLength(4);
    workers[0].load(); expect(first).not.toHaveBeenCalled();
    await act(async () => workers[0].ok());
    expect(first).toHaveBeenCalledWith(true); expect(duplicate).toHaveBeenCalledWith(true);
    expect(workers).toHaveLength(5);
    workers.slice(1).forEach(worker => worker.image.onerror?.call(worker.image, new Event('error')));
    workers[5].image.onerror?.call(workers[5].image, new Event('error'));
  });

  it('cancels queued work and listeners, and frees hung slots without committing stale results', async () => {
    vi.useFakeTimers();
    const workers: ReturnType<typeof fakeImage>[] = [];
    const queue = createPreviewDecodeQueue(() => { const worker = fakeImage(); workers.push(worker); return worker.image; }, 1);
    const removed = vi.fn(); const next = vi.fn();
    const cancel = queue.request('/active', removed);
    const cancelQueued = queue.request('/queued', removed);
    queue.request('/next', next); cancel(); cancelQueued();
    workers[0].load(); vi.advanceTimersByTime(30000);
    expect(workers).toHaveLength(2); expect(workers[1].image.src).toBe('/next');
    await act(async () => workers[0].ok()); expect(removed).not.toHaveBeenCalled();
    workers[1].load(); await act(async () => workers[1].fail()); expect(next).toHaveBeenCalledWith(false);
  });

  it('releases a slot even if creating a browser image throws', () => {
    const failed = vi.fn();
    const queue = createPreviewDecodeQueue(() => { throw new Error('image'); });
    queue.request('/failed', failed); expect(failed).toHaveBeenCalledWith(false);
  });
});

const small: NodeBodyImage = { src: '/small', original: '/original', downscaled: true, maxEdge: 320 };
const large: NodeBodyImage = { src: '/large', original: '/original', downscaled: true, maxEdge: 640 };
function Preview({ candidate, asset = 'asset', measurement = '' }: { candidate: NodeBodyImage | null; asset?: string; measurement?: string }) {
  const { displayed, onLoad, failed } = useDecodedNodeImage(candidate, asset, measurement);
  return displayed ? <img alt="preview" src={displayed.src} data-edge={displayed.maxEdge} data-failed={String(failed)} onLoad={event => onLoad(event.currentTarget)} /> : null;
}
function loaded(image: HTMLImageElement) {
  Object.defineProperties(image, { complete: { configurable: true, value: true }, naturalWidth: { configurable: true, value: 320 } });
  fireEvent.load(image);
}
function intercept() {
  const requests: { src: string; done: (ok: boolean) => void; cancel: ReturnType<typeof vi.fn> }[] = [];
  vi.spyOn(canvasPreviewDecodeQueue, 'request').mockImplementation((src, done) => {
    const cancel = vi.fn(); requests.push({ src, done, cancel }); return cancel;
  });
  return requests;
}

describe('decoded node image handoff', () => {
  it('commits src and measurement metadata together only after a successful decode', () => {
    const requests = intercept(); const view = render(<Preview candidate={small} />);
    const img = view.getByRole('img') as HTMLImageElement; loaded(img);
    view.rerender(<Preview candidate={large} />);
    expect(img.getAttribute('src')).toBe('/small'); expect(img.dataset.edge).toBe('320');
    act(() => requests[0].done(true));
    expect(img.getAttribute('src')).toBe('/large'); expect(img.dataset.edge).toBe('640');
  });

  it('rejects outdated completions and keeps the last good image on failure without retrying', () => {
    const requests = intercept(); const view = render(<Preview candidate={small} />);
    const img = view.getByRole('img') as HTMLImageElement; loaded(img);
    view.rerender(<Preview candidate={large} />);
    view.rerender(<Preview candidate={{ ...large, src: '/latest', maxEdge: 1280 }} />);
    expect(requests[0].cancel).toHaveBeenCalled();
    act(() => requests[0].done(true)); expect(img.getAttribute('src')).toBe('/small');
    act(() => requests[1].done(false)); expect(img.getAttribute('src')).toBe('/small');
    expect(img.dataset.failed).toBe('true');
    view.rerender(<Preview candidate={{ ...large, src: '/latest', maxEdge: 1280 }} />);
    expect(requests).toHaveLength(2);
  });

  it.each(['asset', 'measurement'] as const)('invalidates an old image immediately when %s identity changes', key => {
    const requests = intercept(); const view = render(<Preview candidate={small} />);
    const img = view.getByRole('img') as HTMLImageElement; loaded(img);
    view.rerender(<Preview candidate={large} />);
    view.rerender(<Preview candidate={{ ...large, src: '/new' }} {...{ [key]: 'new-version' }} />);
    expect(img.getAttribute('src')).toBe('/new'); expect(img.dataset.edge).toBe('640');
    act(() => requests[0].done(true)); expect(img.getAttribute('src')).toBe('/new');
  });

  it('removes old content when a result is cleared and cancels pending decode on unmount', () => {
    const requests = intercept(); const view = render(<Preview candidate={small} />);
    loaded(view.getByRole('img') as HTMLImageElement);
    view.rerender(<Preview candidate={large} />); view.rerender(<Preview candidate={null} />);
    expect(view.queryByRole('img')).toBeNull(); expect(requests[0].cancel).toHaveBeenCalled();
    view.unmount(); act(() => requests[0].done(true));
  });
});
