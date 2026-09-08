// SPDX-License-Identifier: Elastic-2.0
import { expect, it, vi } from "vitest";
import { Sprite, Texture, TextureSource, type Ticker } from "pixi.js";
import { createCharacterActor } from "./character-actor";
vi.mock("./character-shadow", () => ({ createContactShadow: () => new Texture({ source: new TextureSource({ width: 24, height: 8 }) }) }));

it("changes appearance without replacing position, frame, shadow or destroying the shared atlas", () => {
  const ticker = { add: vi.fn(), remove: vi.fn() } as unknown as Ticker;
  const male = new Texture({ source: new TextureSource({ width: 704, height: 256 }) });
  const female = new Texture({ source: new TextureSource({ width: 704, height: 256 }) });
  const actor = createCharacterActor(male, ticker, () => true, {
    label: "player", frameSize: 64, frameCount: 44, columns: 11, manual: true,
    pivot: { x: 32, y: 57 }, position: { x: 1280, y: 485 }, scale: 2,
    shadow: { width: 24, height: 8 }, durationMs: 4800, frameAt: () => 0,
  });
  const body = actor.container.children[1] as Sprite;
  const shadow = actor.container.children[0];
  actor.setFrame(27);
  actor.setSheet(female);
  expect(body.texture.source).toBe(female.source);
  expect(body.texture.frame.x).toBe(5 * 64);
  expect(body.texture.frame.y).toBe(2 * 64);
  expect(actor.container.position.x).toBe(1280);
  expect(actor.container.position.y).toBe(485);
  expect(actor.container.children[0]).toBe(shadow);
  expect(male.source.destroyed).toBe(false);
  actor.setSheet(male);
  expect(body.texture.source).toBe(male.source);
  const invalid = new Texture({ source: new TextureSource({ width: 64, height: 64 }) });
  expect(() => actor.setSheet(invalid)).toThrow();
  expect(body.texture.source).toBe(male.source);
  actor.destroy();
  expect(male.source.destroyed).toBe(false);
  expect(female.source.destroyed).toBe(false);
  male.destroy(true); female.destroy(true); invalid.destroy(true);
});
