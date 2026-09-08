// SPDX-License-Identifier: Elastic-2.0
import { Container, Sprite, Text } from "pixi.js";

/** Shared, non-transforming feedback keeps feet and contact shadows anchored. */
export function addCharacterPresentation(container: Container, name?: string) {
  const body = container.children[1] as Sprite;
  const label = new Text({ text: name ?? "", style: {
    fontFamily: "Arial, PingFang SC, sans-serif", fontSize: 12,
    fill: "#fff8df", stroke: { color: "#24301e", width: 2.5 },
  }, resolution: 2 });
  label.anchor.set(0.5, 1);
  label.position.set(0, -body.anchor.y * body.height - 4);
  label.alpha = 0.95;
  label.eventMode = "none";
  label.visible = Boolean(name);
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
  highlight.onRender = () => { highlight.texture = body.texture; };
  container.addChild(highlight);
  const setHovered = (hovered: boolean) => {
    highlight.visible = hovered;
    label.alpha = hovered ? 1 : 0.95;
  };
  body.eventMode = "static";
  body.on("pointerover", () => setHovered(true));
  body.on("pointerout", () => setHovered(false));
  return Object.assign(setHovered, {
    setName(name: string) {
      label.text = name;
      label.visible = Boolean(name);
    },
  });
}
