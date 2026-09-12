// SPDX-License-Identifier: Elastic-2.0
import { Assets, Container, Texture, TextureSource, Ticker } from "pixi.js";
import { afterEach, expect, it, vi } from "vitest";
import { COURTYARD_EXIT_MARKER } from "../piko-map-connections";
import { createMapExitMarker } from "./map-exit-marker";
afterEach(() => vi.restoreAllMocks());
it("renders below people, above the base, and releases the ticker", async () => {
  const atlas = new Texture({ source: new TextureSource({ width: 2048, height: 1024 }) });
  vi.spyOn(Assets, "load").mockImplementation(async () => atlas as never);
  const unload = vi.spyOn(Assets, "unload").mockResolvedValue(undefined);
  const ticker = new Ticker(); ticker.autoStart = false;
  const marker = (await createMapExitMarker(ticker, COURTYARD_EXIT_MARKER, () => false, () => true))!;
  const world = new Container({ sortableChildren: true });
  const base = new Container({ zIndex: -Infinity });
  const person = new Container({ zIndex: COURTYARD_EXIT_MARKER.position.y });
  world.addChild(person, marker.container, base); world.sortChildren();
  expect(world.children).toEqual([base, marker.container, person]);
  expect(marker.container.eventMode).toBe("none");
  expect(ticker.count).toBe(1);
  marker.destroy();
  expect(ticker.count).toBe(0);
  await vi.waitFor(() => expect(unload).toHaveBeenCalledOnce());
  world.destroy({ children: true }); ticker.destroy(); atlas.destroy(true);
});

it("releases an invalid atlas without retaining a ticker or poisoning a later load", async () => {
  const invalid = new Texture({ source: new TextureSource({ width: 32, height: 32 }) });
  const valid = new Texture({ source: new TextureSource({ width: 2048, height: 1024 }) });
  const load = vi.spyOn(Assets, "load").mockResolvedValueOnce(invalid as never).mockResolvedValue(valid as never);
  const unload = vi.spyOn(Assets, "unload").mockResolvedValue(undefined);
  const ticker = new Ticker(); ticker.autoStart = false;
  await expect(createMapExitMarker(ticker, COURTYARD_EXIT_MARKER, () => false, () => true)).rejects.toThrow("4x2 atlas");
  expect(ticker.count).toBe(0);
  await vi.waitFor(() => expect(unload).toHaveBeenCalledOnce());
  const marker = (await createMapExitMarker(ticker, COURTYARD_EXIT_MARKER, () => false, () => true))!;
  expect(load).toHaveBeenCalledTimes(2);
  marker.destroy();
  await vi.waitFor(() => expect(unload).toHaveBeenCalledTimes(2));
  ticker.destroy(); invalid.destroy(true); valid.destroy(true);
});
