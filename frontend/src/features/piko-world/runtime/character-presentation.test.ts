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
