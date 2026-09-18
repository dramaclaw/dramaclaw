// SPDX-License-Identifier: Elastic-2.0
import { Container, Sprite, Text } from "pixi.js";
import { PIKO_CHARACTER_CURSOR } from "../piko-cursors";

/** Shared, non-transforming feedback keeps feet and contact shadows anchored. */
export function addCharacterPresentation(container: Container, name?: string, interactive = true, nameGap = 4) {
  const body = container.children[1] as Sprite;
  // Texture bounds keep the name stable when head accessories change child bounds.
  const label = createCharacterName(name ?? "", -body.anchor.y * body.texture.height * Math.abs(body.scale.y) - nameGap);
  container.addChild(label);
  // Add a faint copy of the same nearest-sampled frame, without a filter
  // render target that can soften the pixel edges at fractional world scales.
  const highlight = new Sprite({ texture: body.texture, roundPixels: true });
  highlight.anchor.copyFrom(body.anchor);
  highlight.scale.copyFrom(body.scale);
  highlight.position.copyFrom(body.position);
  highlight.blendMode = "add";
  highlight.alpha = 0.06;
  highlight.visible = false;
  highlight.eventMode = "none";
  highlight.onRender = () => {
    highlight.texture = body.texture;
    highlight.anchor.copyFrom(body.anchor);
    highlight.scale.copyFrom(body.scale);
    highlight.position.copyFrom(body.position);
  };
  container.addChild(highlight);
  const setHovered = (hovered: boolean) => {
    highlight.visible = hovered;
    label.alpha = hovered ? 1 : 0.95;
  };
  body.eventMode = interactive ? "static" : "none";
  if (interactive) {
    body.cursor = PIKO_CHARACTER_CURSOR;
    body.on("pointerover", () => setHovered(true));
    body.on("pointerout", () => setHovered(false));
  }
  return Object.assign(setHovered, {
    setNameGap(gap: number) {
      label.y = -body.anchor.y * body.texture.height * Math.abs(body.scale.y) - gap;
    },
    setName(name: string) {
      label.text = name;
      label.visible = Boolean(name);
    },
  });
}

/** Shared passive name style for residents and named animals. */
export function createCharacterName(name: string, y: number) {
  const label = new Text({ text: name, style: {
    fontFamily: "Arial, PingFang SC, sans-serif", fontSize: 12,
    fill: "#fff8df", stroke: { color: "#24301e", width: 2.5 },
  }, resolution: 2 });
  label.anchor.set(0.5, 1);
  label.position.set(0, y);
  label.alpha = 0.95;
  label.eventMode = "none";
  label.visible = Boolean(name);
  return label;
}
