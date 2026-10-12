// SPDX-License-Identifier: Elastic-2.0
import { Sprite, Texture, TextureSource } from "pixi.js";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createPlayerAccessory } from "./player-accessory";
import { PLAYER_ACCESSORIES, type PlayerAccessorySelection } from "../piko-player-accessories";
it("inherits the body transform, switches equipment without moving the actor and hides forehead items from behind", () => {
  const body = new Sprite(); body.position.set(100, 200); body.scale.set(2);
  const sources = new Map(PLAYER_ACCESSORIES.map(item => [item.id, new Texture({ source: new TextureSource({width:128,height:128}) })]));
  let selected: PlayerAccessorySelection = "dark-knight-mask";
  const accessory = createPlayerAccessory(body, sources, () => selected, "female");
  const overlay = body.children[0] as Sprite;
  accessory.update("south",0); expect(overlay.visible).toBe(true);
  accessory.update("north",0); expect(overlay.visible).toBe(false);
  selected = "red-bow";
  accessory.update("north",0); expect(overlay.visible).toBe(false);
  accessory.update("north",3); expect(overlay.visible).toBe(false);
  for (const facing of ["south", "west", "east"] as const) {
    accessory.update(facing,3); expect(overlay.visible).toBe(true);
  }
  selected = "wizard-hat"; accessory.update("north",0); expect(overlay.visible).toBe(true);
  accessory.update("west",3); expect(overlay.scale.x).toBeLessThan(0);
  accessory.update("east",3); expect(overlay.scale.x).toBeGreaterThan(0);
  expect(body.position.x).toBe(100); expect(body.position.y).toBe(200);
  selected = null; accessory.update("south",0); expect(overlay.visible).toBe(false);
  accessory.destroy(); expect(body.children).toHaveLength(0);
  sources.forEach(texture => { expect(texture.destroyed).toBe(false); texture.destroy(true); });
  body.destroy();
});

it("skips unchanged poses and tolerates a missing optional accessory texture", () => {
  const body = new Sprite();
  const texture = new Texture({ source: new TextureSource({ width: 128, height: 128 }) });
  let selected: PlayerAccessorySelection = "wizard-hat";
  const accessory = createPlayerAccessory(body, new Map([["wizard-hat", texture]]), () => selected, "male");
  const overlay = body.children[0] as Sprite;
  const move = vi.spyOn(overlay.position, "set");
  accessory.update("south", 0); accessory.update("south", 0);
  expect(move).toHaveBeenCalledTimes(1);
  const standingY = overlay.y;
  accessory.update("south", 0, true);
  expect(overlay.y).toBeGreaterThan(standingY);
  accessory.update("south", 0, false);
  expect(overlay.y).toBe(standingY);
  move.mockClear();
  accessory.update("west", 3); expect(move).toHaveBeenCalledTimes(1);
  selected = "red-bow"; accessory.update("west", 3); expect(overlay.visible).toBe(false);
  selected = "wizard-hat"; accessory.update("west", 3); expect(overlay.visible).toBe(true);
  accessory.destroy(); body.destroy(); texture.destroy(true);
});

beforeEach(() => { vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false }))); });
afterEach(() => { vi.unstubAllGlobals(); });
it("flashes briefly, follows the worn item and hides for unequipped or reduced motion", () => {
  const preference = { matches: false };
  vi.stubGlobal("matchMedia", () => preference);
  const body = new Sprite();
  const texture = new Texture({ source: new TextureSource({ width: 128, height: 128 }) });
  let selected: PlayerAccessorySelection = "wizard-hat";
  const accessory = createPlayerAccessory(body, new Map([["wizard-hat", texture]]), () => selected, "male");
  accessory.update("south", 0);
  const sparkle = body.children.find(child => child.label === "accessory-sparkle")!;
  accessory.animate(1000); expect(sparkle.visible).toBe(false);
  accessory.animate(3100); expect(sparkle.visible).toBe(true);
  const x = sparkle.x;
  accessory.animate(3440);
  expect(body.children.filter(child => child.label === "accessory-sparkle" && child.visible)).toHaveLength(3);
  accessory.animate(7100); expect(sparkle.visible).toBe(false);
  accessory.animate(11100); expect(sparkle.visible).toBe(true);
  accessory.update("west", 0); accessory.animate(3100); expect(sparkle.x).not.toBe(x);
  accessory.animate(null); expect(sparkle.visible).toBe(false);
  accessory.update("south", 1); accessory.animate(3100); expect(sparkle.visible).toBe(false);
  accessory.update("south", 0);
  preference.matches = true; accessory.animate(3100); expect(sparkle.visible).toBe(false);
  preference.matches = false; selected = null; accessory.update("south", 0);
  accessory.animate(3100); expect(sparkle.visible).toBe(false);
  accessory.destroy(); expect(body.children).toHaveLength(0);
  body.destroy(); texture.destroy(true);
});
