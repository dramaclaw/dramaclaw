// SPDX-License-Identifier: Elastic-2.0
import { expect, it, vi } from "vitest";
import { Ticker, Texture } from "pixi.js";
import { createEnvironmentSprite, environmentFrameAt } from "./environment-sprite";

it("reverses through adjacent grass frames without repeating endpoints or selecting mirrored frames", () => {
  const sequence = Array.from({ length: 29 }, (_, step) => environmentFrameAt(step, 8, "ping-pong"));
  expect(sequence.slice(0, 15)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 6, 5, 4, 3, 2, 1, 0]);
  expect(sequence.every((frame, index) => index === 0 || Math.abs(frame - sequence[index - 1]) === 1)).toBe(true);
  expect(environmentFrameAt(17, 16)).toBe(1);
  expect(environmentFrameAt(8, 1, "ping-pong")).toBe(0);
});

it("clips highlights to water and stops updates for reduced motion, hidden pages and disposal", () => {
  let reduced = false;
  let change = () => {};
  const remove = vi.fn();
  vi.stubGlobal("matchMedia", () => ({ get matches() { return reduced; },
    addEventListener: (_: string, fn: () => void) => { change = fn; }, removeEventListener: remove }));
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const ticker = new Ticker();
  ticker.autoStart = false;
  const effect = createEnvironmentSprite(Texture.WHITE, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], { columns: 4, rows: 4, frames: 16, fps: 8, inset: 0, startStep: 3 }, ticker);
  expect(ticker.count).toBe(1);
  const initial = effect.sprite.texture;
  expect(initial.frame.x).toBe(Texture.WHITE.width / 4 * 3);
  ticker.update(100); ticker.update(200); ticker.update(300);
  expect(effect.sprite.texture).not.toBe(initial);
  expect(effect.mask.containsPoint({ x: 50, y: 50 })).toBe(true);
  expect(effect.mask.containsPoint({ x: 101, y: 50 })).toBe(false);
  reduced = true; change();
  expect(effect.sprite.texture).toBe(initial);
  expect(ticker.count).toBe(0);
  expect(effect.container.visible).toBe(true);
  reduced = false; change();
  hidden.mockReturnValue(true); document.dispatchEvent(new Event("visibilitychange"));
  expect(ticker.count).toBe(0);
  hidden.mockReturnValue(false); document.dispatchEvent(new Event("visibilitychange"));
  expect(ticker.count).toBe(1);
  effect.destroy();
  expect(ticker.count).toBe(0);
  expect(remove).toHaveBeenCalled();
  ticker.destroy();
  hidden.mockRestore();
  vi.unstubAllGlobals();
});
