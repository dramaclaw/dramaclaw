import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFreezoneCanvas, type FreezoneCanvasPayload } from '@/api/canvas';
import {
  applyRemoteFreezoneCanvas,
  refreshRemoteFreezoneCanvas,
  registerFreezoneCanvasRuntime,
} from '@/features/freezone/canvasSyncRuntime';

vi.mock('@/api/canvas', () => ({ getFreezoneCanvas: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const snapshot = (revision: number): FreezoneCanvasPayload => ({ nodes: [], edges: [], revision });
let unregister: (() => void) | undefined;
beforeEach(() => vi.mocked(getFreezoneCanvas).mockReset());
afterEach(() => { unregister?.(); unregister = undefined; });

describe('remote canvas revision barrier', () => {
  it('distinguishes an absent runtime from a refusal and a mismatched active scope', () => {
    expect(applyRemoteFreezoneCanvas('p', 'c', snapshot(1))).toBeNull();
    const apply = vi.fn((_remote: FreezoneCanvasPayload) => false);
    unregister = registerFreezoneCanvasRuntime('p', 'c', apply);
    expect(applyRemoteFreezoneCanvas('p', 'c', snapshot(1))).toBe(false);
    expect(applyRemoteFreezoneCanvas('other', 'c', snapshot(1))).toBe(false);
    expect(apply).toHaveBeenCalledTimes(1);
    unregister();
    expect(applyRemoteFreezoneCanvas('p', 'c', snapshot(1))).toBeNull();
  });

  it.each([false, true])('keeps the newest concurrent response (old response first: %s)', async oldFirst => {
    const apply = vi.fn((_remote: FreezoneCanvasPayload) => true);
    unregister = registerFreezoneCanvasRuntime('p', 'c', apply);
    const old = deferred<FreezoneCanvasPayload>();
    const fresh = deferred<FreezoneCanvasPayload>();
    vi.mocked(getFreezoneCanvas).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const first = refreshRemoteFreezoneCanvas('p', 'c', { protectUnsavedLocalEdits: true });
    const second = refreshRemoteFreezoneCanvas('p', 'c', { protectUnsavedLocalEdits: true });
    if (oldFirst) {
      old.resolve(snapshot(2));
      expect(await first).toBe(true);
      fresh.resolve(snapshot(3));
      expect(await second).toBe(true);
    } else {
      fresh.resolve(snapshot(3));
      expect(await second).toBe(true);
      old.resolve(snapshot(2));
      expect(await first).toBe(false);
    }
    expect(apply.mock.calls.map(([remote]) => remote.revision)).toEqual(oldFirst ? [2, 3] : [3]);
  });

  it('uses revisions rather than dispatch order when an earlier request returns newer data', async () => {
    const apply = vi.fn((_remote: FreezoneCanvasPayload) => true);
    unregister = registerFreezoneCanvasRuntime('p', 'c', apply);
    const firstResult = deferred<FreezoneCanvasPayload>();
    const secondResult = deferred<FreezoneCanvasPayload>();
    vi.mocked(getFreezoneCanvas).mockReturnValueOnce(firstResult.promise).mockReturnValueOnce(secondResult.promise);
    const first = refreshRemoteFreezoneCanvas('p', 'c');
    const second = refreshRemoteFreezoneCanvas('p', 'c');
    secondResult.resolve(snapshot(3));
    expect(await second).toBe(true);
    firstResult.resolve(snapshot(4));
    expect(await first).toBe(true);
    expect(apply.mock.calls.map(([remote]) => remote.revision)).toEqual([3, 4]);
  });

  it('also rejects data older than hydration or a completed local save', () => {
    let revision = 7;
    const apply = vi.fn((_remote: FreezoneCanvasPayload) => true);
    unregister = registerFreezoneCanvasRuntime('p', 'c', apply, undefined, undefined, undefined, () => revision);
    expect(applyRemoteFreezoneCanvas('p', 'c', snapshot(6))).toBe(false);
    expect(applyRemoteFreezoneCanvas('p', 'c', snapshot(8))).toBe(true);
    revision = 10;
    expect(applyRemoteFreezoneCanvas('p', 'c', snapshot(9))).toBe(false);
    expect(applyRemoteFreezoneCanvas('p', 'c', snapshot(10))).toBe(true);
    expect(apply.mock.calls.map(([remote]) => remote.revision)).toEqual([8, 10]);
  });

  it('only records revisions the applier accepted', () => {
    const apply = vi.fn((_remote: FreezoneCanvasPayload) => true).mockReturnValueOnce(false);
    unregister = registerFreezoneCanvasRuntime('p', 'c', apply);
    expect(applyRemoteFreezoneCanvas('p', 'c', snapshot(8))).toBe(false);
    expect(applyRemoteFreezoneCanvas('p', 'c', snapshot(8))).toBe(true);
    expect(applyRemoteFreezoneCanvas('p', 'c', snapshot(7))).toBe(false);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it.each([null, undefined, NaN])('refuses unknown revision %s after accepting a known version', revision => {
    const apply = vi.fn((_remote: FreezoneCanvasPayload) => true);
    unregister = registerFreezoneCanvasRuntime('p', 'c', apply);
    expect(applyRemoteFreezoneCanvas('p', 'c', snapshot(3))).toBe(true);
    expect(applyRemoteFreezoneCanvas('p', 'c', { nodes: [], edges: [], revision })).toBe(false);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('does not apply an in-flight response to a later registration of the same canvas', async () => {
    const original = vi.fn((_remote: FreezoneCanvasPayload) => true);
    unregister = registerFreezoneCanvasRuntime('p', 'c', original);
    const response = deferred<FreezoneCanvasPayload>();
    vi.mocked(getFreezoneCanvas).mockReturnValue(response.promise);
    const request = refreshRemoteFreezoneCanvas('p', 'c');
    unregister();
    const reopened = vi.fn((_remote: FreezoneCanvasPayload) => true);
    unregister = registerFreezoneCanvasRuntime('p', 'c', reopened);
    response.resolve(snapshot(3));
    expect(await request).toBe(false);
    expect(original).not.toHaveBeenCalled();
    expect(reopened).not.toHaveBeenCalled();
  });

  it('keeps revision barriers scoped to their project/canvas registration', () => {
    const first = vi.fn((_remote: FreezoneCanvasPayload) => true);
    const disposeFirst = registerFreezoneCanvasRuntime('p', 'c', first);
    expect(applyRemoteFreezoneCanvas('p', 'c', snapshot(10))).toBe(true);
    const next = vi.fn((_remote: FreezoneCanvasPayload) => true);
    unregister = registerFreezoneCanvasRuntime('other', 'c', next);
    disposeFirst();
    expect(applyRemoteFreezoneCanvas('other', 'c', snapshot(1))).toBe(true);
    expect(applyRemoteFreezoneCanvas('p', 'c', snapshot(11))).toBe(false);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
