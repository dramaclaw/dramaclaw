// SPDX-License-Identifier: Elastic-2.0
import { Container, Sprite, Texture } from "pixi.js";
import { expect, it } from "vitest";
import { addCharacterPresentation } from "./character-presentation";
import { PIKO_CHARACTER_CURSOR } from "../piko-cursors";
it("reserves interaction hit targets and cursors for interactive characters", () => {
  for (const interactive of [false, true]) {
    const container = new Container();
    const body = new Sprite(Texture.WHITE);
    container.addChild(new Sprite(Texture.WHITE), body);
    addCharacterPresentation(container, "resident", interactive);
    expect(body.eventMode).toBe(interactive ? "static" : "none");
    expect(body.cursor).toBe(interactive ? PIKO_CHARACTER_CURSOR : undefined);
    expect(body.listenerCount("pointerover")).toBe(interactive ? 1 : 0);
    container.destroy({ children: true });
  }
});

it("keeps the nickname anchored to the body even when a head accessory extends its bounds", () => {
  const positions: number[] = [];
  for (const withAccessory of [false, true]) {
    const container = new Container();
    const body = new Sprite(Texture.WHITE);
    body.anchor.set(0.5, 1); body.scale.set(2);
    if (withAccessory) {
      const hat = new Sprite(Texture.WHITE); hat.position.y = -100; body.addChild(hat);
    }
    container.addChild(new Sprite(Texture.WHITE), body);
    addCharacterPresentation(container, "player", false, 28);
    positions.push(container.children[2].y);
    container.destroy({ children: true });
  }
  expect(positions[0]).toBe(positions[1]);
});

it("updates accessory clearance without recreating the nickname or inheriting child bounds", () => {
  const container = new Container();
  const body = new Sprite(Texture.WHITE);
  body.anchor.set(0.5, 1); body.scale.set(2);
  const hat = new Sprite(Texture.WHITE); hat.position.y = -100; body.addChild(hat);
  container.addChild(new Sprite(Texture.WHITE), body);
  const presentation = addCharacterPresentation(container, "player", false, 6);
  const name = container.children[2];
  const originalY = name.y;
  presentation.setNameGap(24);
  expect(container.children[2]).toBe(name);
  expect(name.y).toBe(originalY - 18);
  presentation.setNameGap(6);
  expect(name.y).toBe(originalY);
  container.destroy({ children: true });
});

it("keeps the hover highlight aligned when sitting changes the body pivot and scale", () => {
  const container = new Container();
  const body = new Sprite(Texture.WHITE);
  container.addChild(new Sprite(Texture.WHITE), body);
  const hover = addCharacterPresentation(container, "player");
  const highlight = container.children[3] as Sprite;
  body.anchor.set(0.5, 0.5); body.scale.set(2.1); body.position.set(0, -2);
  hover(true);
  highlight.onRender!({} as never);
  expect(highlight.anchor.x).toBe(body.anchor.x);
  expect(highlight.anchor.y).toBe(body.anchor.y);
  expect(highlight.scale.x).toBe(body.scale.x);
  expect(highlight.scale.y).toBe(body.scale.y);
  expect(highlight.position.y).toBe(body.position.y);
  container.destroy({ children: true });
});
