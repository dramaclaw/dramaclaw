// SPDX-License-Identifier: Elastic-2.0
import { Graphics, type Ticker } from "pixi.js";
import type { Point } from "./character-movement";

/** A single reusable ground marker, independent of the environment animations. */
export function createClickFeedback(ticker: Ticker) {
  const marker = new Graphics({ label: "walk-click-feedback", eventMode: "none", zIndex: -0.1 });
  marker.ellipse(0, 0, 12, 6).stroke({ color: 0xfff8df, width: 1.5, alpha: 0.85 });
  marker.circle(0, 0, 1.5).fill({ color: 0xfff8df, alpha: 0.7 });
  marker.visible = false;
  const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let elapsed = 0, attached = false;
  const hide = () => {
    marker.visible = false;
    if (attached) ticker.remove(update);
    attached = false;
  };
  const update = (time: Ticker) => {
    if (document.hidden) { hide(); return; }
    elapsed += time.deltaMS;
    const progress = Math.min(1, elapsed / 380);
    const reduced = motion?.matches;
    marker.scale.set(reduced ? 1 : 0.85 + progress * 0.35);
    marker.alpha = 1 - progress;
    if (progress === 1) hide();
  };
  return { marker, show(point: Point) {
    elapsed = 0;
    marker.position.set(point.x, point.y);
    marker.scale.set(1);
    marker.alpha = 1;
    marker.visible = true;
    if (!attached) { ticker.add(update); attached = true; }
  }, destroy() { hide(); marker.destroy(); } };
}
