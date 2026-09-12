// SPDX-License-Identifier: Elastic-2.0
import { afterEach, expect, it, vi } from "vitest";
import { Ticker } from "pixi.js";
import { COURTYARD_LAMPS, createCourtyardLampRuntime } from "./courtyard-lamp";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("bounds particles, pauses while hidden, and releases its ticker and listeners", () => {
  let reduced = false, change = () => {};
  const remove = vi.fn();
  vi.stubGlobal("matchMedia", () => ({ get matches() { return reduced; },
    addEventListener: (_: string, listener: () => void) => { change = listener; }, removeEventListener: remove }));
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const ticker = new Ticker(); ticker.autoStart = false;
  const lamp = createCourtyardLampRuntime(ticker, () => 0);
  expect(lamp.containers).toHaveLength(9);
  const lamps = lamp.containers;
  expect(ticker.count).toBe(1);
  lamps.forEach((container, index) => {
    expect(container.x).toBe(COURTYARD_LAMPS[index].x);
    expect(container.y).toBe(COURTYARD_LAMPS[index].y);
    expect(container.zIndex).toBe(COURTYARD_LAMPS[index].baseY);
  });
  const particles = lamp.containers[0].getChildByLabel("lamp-particles")!;
  const halo = lamp.containers[0].getChildByLabel("lamp-halo")!;
  const core = lamp.containers[0].getChildByLabel("lamp-core")!;
  for (let time = 100; time <= 2000; time += 100) ticker.update(time);
  expect(particles.children.filter(item => item.visible).length).toBeGreaterThanOrEqual(2);
  expect(particles.children).toHaveLength(4);
  expect(halo.blendMode).toBe("add");
  expect(core.alpha).toBeGreaterThan(0.35);
  expect(new Set(lamps.map(container => container.getChildByLabel("lamp-core")!.alpha)).size).toBe(9);
  for (let time = 2100; time <= 30000; time += 100) ticker.update(time);
  expect(particles.children).toHaveLength(4);
  expect(lamps.reduce((count, container) => count + container.getChildByLabel("lamp-particles")!.children.length, 0)).toBe(36);
  hidden.mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(ticker.count).toBe(0);
  hidden.mockReturnValue(false);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(ticker.count).toBe(1);
  reduced = true; change();
  expect(ticker.count).toBe(0);
  expect(particles.children.every(item => !item.visible)).toBe(true);
  expect(halo.alpha).toBe(0.85);
  expect(core.alpha).toBe(0.5);
  lamps.forEach(container => {
    expect(container.getChildByLabel("lamp-particles")!.children.every(item => !item.visible)).toBe(true);
  });
  lamp.destroy(); lamp.destroy();
  expect(remove).toHaveBeenCalledTimes(1);
  expect(lamp.containers.every(container => container.destroyed)).toBe(true);
  ticker.destroy();
});
