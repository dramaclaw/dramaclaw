// SPDX-License-Identifier: Elastic-2.0
import { Assets, Texture, TextureSource } from "pixi.js";
import { afterEach, expect, it, vi } from "vitest";
import { acquireSharedTexture } from "./shared-texture";
afterEach(() => vi.restoreAllMocks());
it("retains a shared texture until its last map releases it and waits for unload before reloading", async () => {
  const atlas = new Texture({ source: new TextureSource({ width: 32, height: 32 }) });
  const load = vi.spyOn(Assets, "load").mockImplementation(async () => atlas as never);
  let finishUnload!: () => void;
  const unload = vi.spyOn(Assets, "unload").mockImplementation(() => new Promise<void>(resolve => { finishUnload = resolve; }));
  const first = await acquireSharedTexture("test-shared-atlas");
  const second = await acquireSharedTexture("test-shared-atlas");
  expect(load).toHaveBeenCalledOnce();
  first.release();
  expect(unload).not.toHaveBeenCalled();
  second.release();
  await vi.waitFor(() => expect(unload).toHaveBeenCalledOnce());
  const next = acquireSharedTexture("test-shared-atlas");
  await Promise.resolve();
  expect(load).toHaveBeenCalledOnce();
  finishUnload();
  const third = await next;
  expect(load).toHaveBeenCalledTimes(2);
  unload.mockResolvedValue(undefined);
  third.release(); third.release();
  await vi.waitFor(() => expect(unload).toHaveBeenCalledTimes(2));
  atlas.destroy(true);
});

it("can retry a failed load and a failed unload without poisoning later leases", async () => {
  const texture = new Texture({ source: new TextureSource({ width: 32, height: 32 }) });
  const load = vi.spyOn(Assets, "load").mockRejectedValueOnce(new Error("offline")).mockResolvedValue(texture as never);
  const unload = vi.spyOn(Assets, "unload").mockRejectedValueOnce(new Error("renderer gone")).mockResolvedValue(undefined);
  await expect(acquireSharedTexture("failed-load")).rejects.toThrow("offline");
  const lease = await acquireSharedTexture("failed-load");
  lease.release();
  const next = await acquireSharedTexture("failed-load");
  expect(load).toHaveBeenCalledTimes(3);
  expect(unload).toHaveBeenCalledTimes(1);
  next.release();
  await vi.waitFor(() => expect(unload).toHaveBeenCalledTimes(2));
  texture.destroy(true);
});
