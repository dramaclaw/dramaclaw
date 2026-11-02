// SPDX-License-Identifier: Elastic-2.0
import { Texture } from "pixi.js";

/** Dimensions use the same source-pixel grid as character frames. */
export interface CharacterShadowProfile { width: number; height: number }

export function createContactShadow({ width, height }: CharacterShadowProfile): Texture {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("Invalid character shadow dimensions");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Cannot create character contact shadow");
  const color = getComputedStyle(document.documentElement).getPropertyValue("--bg-rgb").trim() || "10 12 18";
  // Shared three-band style. Each source pixel is filled once, without blur.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const radius = ((x + 0.5 - width / 2) / (width / 2)) ** 2
        + ((y + 0.5 - height / 2) / (height / 2)) ** 2;
      if (radius > 1) continue;
      const opacity = radius < 0.22 ? 0.48 : radius < 0.60 ? 0.28 : 0.12;
      context.fillStyle = `rgb(${color} / ${opacity})`;
      context.fillRect(x, y, 1, 1);
    }
  }
  const texture = Texture.from(canvas);
  texture.source.scaleMode = "nearest";
  return texture;
}
