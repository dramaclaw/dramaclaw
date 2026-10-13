// SPDX-License-Identifier: Elastic-2.0
import { Container, Sprite, Texture, TextureSource } from "pixi.js";
import { expect, it } from "vitest";
import { addCharacterPresentation, syncCharacterName } from "./character-presentation";
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

it("reanchors names after indoor scaling and seated pivot changes", () => {
  const texture = new Texture({ source: new TextureSource({ width: 64, height: 64 }) });
  const container = new Container();
  const shadow = new Sprite(texture), body = new Sprite(texture);
  body.anchor.set(0.5, 57 / 64); body.scale.set(2);
  container.addChild(shadow, body);
  const presentation = addCharacterPresentation(container, "测试账号 · 你", false, 6, true);
  const label = container.getChildByLabel("character-nickname")!;
  const ring = container.getChildByLabel("local-player-identity-ring")!;
  body.scale.set(2 * 1.26); presentation.updatePose();
  expect(label.y).toBeCloseTo(-57 * 2 * 1.26 - 6);
  body.anchor.y = 0.5; body.scale.set(2 * 1.26 * 1.05); shadow.y = 22 * body.scale.y;
  presentation.updatePose();
  expect(label.y).toBeCloseTo(-32 * body.scale.y - 6);
  expect(ring.y).toBe(shadow.y);
  expect(ring.scale.y).toBe(body.scale.y);
  expect(ring.eventMode).toBe("none");
  container.destroy({ children: true }); texture.destroy(true);
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

it("renames an existing actor's label when its owner saves a new nickname", () => {
  const body = new Sprite(Texture.WHITE);
  const container = new Container();
  container.addChild(new Container(), body);
  const entry = { nickname: "小叶", presentation: addCharacterPresentation(container, "小叶", false, 6) };
  const label = container.children.find(child => "text" in child) as unknown as { text: string; visible: boolean };
  expect(label.text).toBe("小叶");

  syncCharacterName(entry, "改名的小叶");

  expect(entry.nickname).toBe("改名的小叶");
  expect(label.text).toBe("改名的小叶");
  expect(label.visible).toBe(true);
  // Unchanged names leave the label alone on every later frame.
  label.text = "sentinel";
  syncCharacterName(entry, "改名的小叶");
  expect(label.text).toBe("sentinel");
});
