// SPDX-License-Identifier: Elastic-2.0
import { Assets, Texture, TextureSource, Ticker } from "pixi.js";
import { afterEach, expect, it, vi } from "vitest";
import { createEnvironmentEffectRuntime, environmentLayerZIndex, environmentSpriteAnimation } from "./environment-effect-runtime";
import { PikoEnvironmentSchema } from "./map-package-schema";

afterEach(() => vi.restoreAllMocks());

it("mounts data-authored sprites with one shared texture load and one owned lifecycle", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  const atlas = new Texture({ source: new TextureSource({ width: 16, height: 8 }) });
  const baseTexture = new Texture({ source: new TextureSource({ width: 32, height: 32 }) });
  const load = vi.spyOn(Assets, "load").mockResolvedValue(atlas as never);
  const unload = vi.spyOn(Assets, "unload").mockResolvedValue(undefined);
  const ticker = new Ticker();
  ticker.autoStart = false;
  const region = { id: "patch", points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }, { x: 0, y: 8 }] };
  const environment = PikoEnvironmentSchema.parse({
    schemaVersion: 1,
    mapId: "test-map",
    globalLighting: { preset: "neutral-day", intensity: 1 },
    effects: [
      { id: "foreground", kind: "sprite", src: "base.png", layer: "front-scenery", region,
        reducedMotion: "keep" },
      { id: "flowers-a", kind: "sprite", src: "effects/flowers.png", layer: "front-scenery", region,
        animation: { columns: 2, rows: 1, frames: 2, fps: 1, inset: 0 }, reducedMotion: "simplify" },
      { id: "flowers-b", kind: "sprite", src: "effects/flowers.png", layer: "behind-scenery", region,
        animation: { columns: 2, rows: 1, frames: 2, fps: 1, inset: 0 }, reducedMotion: "simplify" },
    ],
    audioZones: [],
  });

  const runtime = await createEnvironmentEffectRuntime({
    definitions: environment.effects,
    baseTexture,
    baseTextureSrc: "base.png",
    ticker,
    resolveAssetUrl: src => `/maps/test/${src}`,
    isDisposed: () => false,
  });

  expect(runtime).not.toBeNull();
  expect(load).toHaveBeenCalledTimes(1);
  expect(runtime!.objects.map(object => object.label)).toEqual([
    "foreground", "flowers-a", "Graphics", "flowers-b", "Graphics",
  ]);
  expect(environmentLayerZIndex("front-scenery")).toBe(-0.25);
  expect(environmentLayerZIndex("behind-scenery")).toBe(-0.75);
  const windAnimation = environmentSpriteAnimation(PikoEnvironmentSchema.parse({
    schemaVersion: 1, mapId: "test-map", globalLighting: { preset: "neutral-day", intensity: 1 }, audioZones: [],
    effects: [{ id: "flowers", kind: "sprite", reducedMotion: "simplify",
      animation: { columns: 2, rows: 2, frames: 4, fps: 0.8, inset: 0, sequence: [0, 1, 2, 3],
        clock: "courtyard-wind", loopSeconds: 5, phaseSeconds: 0.1 } }],
  }).effects[0].animation!);
  expect(windAnimation.sequence).toEqual([0, 1, 2, 3]);
  expect(windAnimation.stepAt?.(1200)).toBe(1);
  runtime!.destroy();
  await vi.waitFor(() => expect(unload).toHaveBeenCalledOnce());
  expect(ticker.count).toBe(0);
  ticker.destroy();
  vi.unstubAllGlobals();
});
