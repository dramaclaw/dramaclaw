// SPDX-License-Identifier: Elastic-2.0
import { Sprite, Texture, TextureSource, type Ticker } from "pixi.js";
import { afterEach, expect, it, vi } from "vitest";
import { createMayorActor } from "./mayor-actor";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("plays only after entry, respects reduced motion, and releases its resources", () => {
  const motion = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal("matchMedia", vi.fn(() => motion));
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const pixels: Array<{ x: number; y: number; width: number; height: number; color: string }> = [];
  const context = {
    fillStyle: "",
    fillRect(x: number, y: number, width: number, height: number) {
      pixels.push({ x, y, width, height, color: this.fillStyle });
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as ReturnType<HTMLCanvasElement["getContext"]>);
  const shadow = new Texture({ source: new TextureSource({ width: 37, height: 8 }) });
  const from = vi.spyOn(Texture, "from").mockReturnValue(shadow);
  const shadowDestroyed = vi.spyOn(shadow, "destroy");
  const sheet = new Texture({ source: new TextureSource({ width: 448, height: 64 }) });
  const ticker = { add: vi.fn(), remove: vi.fn() };
  let active = false;
  const actor = createMayorActor(sheet, ticker as unknown as Ticker, () => active);
  const body = actor.container.children[1] as Sprite;
  const contact = actor.container.children[0] as Sprite;
  expect(from.mock.calls[0][0]).toMatchObject({ width: 37, height: 8 });
  expect(shadow.source.scaleMode).toBe("nearest");
  expect(contact.anchor.x).toBe(0.5);
  expect(contact.anchor.y).toBe(0.5);
  expect(contact.scale.x).toBe(body.scale.x);
  expect(new Set(pixels.map(pixel => pixel.color)).size).toBe(3);
  expect(pixels.every(pixel => pixel.width === 1 && pixel.height === 1)).toBe(true);
  expect(new Set(pixels.map(pixel => `${pixel.x},${pixel.y}`)).size).toBe(pixels.length);
  const tick = ticker.add.mock.calls[0][0];
  expect(actor.container.position.x).toBe(1060);
  expect(actor.container.position.y).toBe(450);
  expect(body.anchor.y).toBe(57 / 64);
  tick({ deltaMS: 901 });
  expect(body.texture.frame.x).toBe(0);
  active = true;
  tick({ deltaMS: 901 });
  expect(body.texture.frame.x).toBe(64);
  expect(contact.position.x).toBe(0);
  expect(contact.position.y).toBe(0);
  expect(contact.scale.x).toBe(body.scale.x);
  hidden.mockReturnValue(true);
  tick({ deltaMS: 500 });
  expect(body.texture.frame.x).toBe(64);
  hidden.mockReturnValue(false);
  motion.matches = true;
  motion.addEventListener.mock.calls[0][1]();
  tick({ deltaMS: 901 });
  expect(body.texture.frame.x).toBe(0);
  actor.destroy();
  expect(ticker.remove).toHaveBeenCalledWith(tick);
  expect(motion.removeEventListener).toHaveBeenCalledWith("change", motion.addEventListener.mock.calls[0][1]);
  expect(shadowDestroyed).toHaveBeenCalledWith(true);
  expect(sheet.source.destroyed).toBe(false);
  sheet.destroy(true);
});

it("rejects an invalid atlas before creating scene resources", () => {
  const sheet = new Texture({ source: new TextureSource({ width: 64, height: 64 }) });
  expect(() => createMayorActor(sheet, {} as Ticker, () => true)).toThrow("Invalid character motion sheet dimensions");
  sheet.destroy(true);
});
