// SPDX-License-Identifier: Elastic-2.0
import { Container, Graphics, Rectangle, Sprite, Texture, type Ticker } from "pixi.js";
import type { PikoPoint } from "./navigation-geometry";

type Animation = { columns: number; rows: number; frames: number; fps: number; inset: number; playback?: "loop" | "ping-pong"; startStep?: number };

export function environmentFrameAt(step: number, count: number, playback: Animation["playback"] = "loop") {
  if (count <= 1) return 0;
  if (playback !== "ping-pong") return step % count;
  const phase = step % (2 * (count - 1));
  return phase < count ? phase : 2 * (count - 1) - phase;
}

/** Play authored atlas frames; mask away scenery and fully replace static water pixels. */
export function createEnvironmentSprite(atlas: Texture, region: PikoPoint[], animation: Animation, ticker: Ticker) {
  const { columns, rows, frames: count, fps, inset } = animation;
  const cellWidth = atlas.width / columns, cellHeight = atlas.height / rows;
  if (count > columns * rows || cellWidth <= inset * 2 || cellHeight <= inset * 2) {
    throw new Error("Invalid environment sprite atlas layout");
  }
  const frames = Array.from({ length: count }, (_, index) => new Texture({ source: atlas.source,
    frame: new Rectangle(index % columns * cellWidth + inset, Math.floor(index / columns) * cellHeight + inset,
      cellWidth - inset * 2, cellHeight - inset * 2) }));
  const container = new Container({ label: "environment-sprite", eventMode: "none", zIndex: -1 });
  const mask = new Graphics({ eventMode: "none" });
  mask.poly(region.flatMap(point => [point.x, point.y])).fill(0xffffff);
  container.mask = mask;
  const startStep = animation.startStep ?? 0;
  const initialFrame = environmentFrameAt(startStep, count, animation.playback);
  const sprite = new Sprite(frames[initialFrame]);
  sprite.position.set(Math.min(...region.map(point => point.x)), Math.min(...region.map(point => point.y)));
  sprite.width = Math.max(...region.map(point => point.x)) - sprite.x;
  sprite.height = Math.max(...region.map(point => point.y)) - sprite.y;
  container.addChild(sprite);
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  let elapsed = 0, frame = initialFrame;
  let attached = false;
  const update = (clock: Ticker) => {
    elapsed += Math.min(clock.deltaMS, 100) / 1000;
    const next = environmentFrameAt(startStep + Math.floor(elapsed * fps), count, animation.playback);
    if (next !== frame) { frame = next; sprite.texture = frames[frame]; }
  };
  const sync = () => {
    const active = !media.matches && !document.hidden;
    if (active && !attached) { ticker.add(update); attached = true; }
    if (!active && attached) { ticker.remove(update); attached = false; }
    if (media.matches) { elapsed = 0; frame = initialFrame; sprite.texture = frames[initialFrame]; }
  };
  media.addEventListener("change", sync);
  document.addEventListener("visibilitychange", sync);
  sync();
  return { container, mask, sprite, destroy() {
    if (attached) ticker.remove(update);
    media.removeEventListener("change", sync);
    document.removeEventListener("visibilitychange", sync);
    container.mask = null;
    container.destroy({ children: true });
    mask.destroy();
    frames.forEach(texture => texture.destroy(false));
  } };
}
