// SPDX-License-Identifier: Elastic-2.0
import { Container, Graphics } from "pixi.js";

/** Sparse, bounded particles. The owning tree controls visibility and ticker lifetime. */
export function createFallingLeaves(random: () => number = Math.random) {
  const container = new Container({ label: "east-tree-falling-leaves", eventMode: "none" });
  const leaves: { sprite: Graphics; age: number; duration: number; x: number; y: number; phase: number }[] = [];
  let remaining = 5 + random() * 4, pairDelay = -1, releases = 0;
  const spawn = () => {
    if (leaves.length >= 2) return;
    const sprite = new Graphics({ eventMode: "none" });
    sprite.poly([-3, 0, -1, -2, 2, -2, 3, 0, 1, 2, -2, 1]).fill(0x9d9b45);
    sprite.rect(-1, -1, 2, 1).fill(0xb8ad57);
    const leaf = { sprite, age: 0, duration: 6 + random() * 2,
      x: 1420 + random() * 185, y: 395 + random() * 22, phase: random() * Math.PI * 2 };
    sprite.position.set(leaf.x, leaf.y);
    sprite.alpha = 0;
    leaves.push(leaf); container.addChild(sprite);
  };
  const clear = () => { leaves.splice(0).forEach(leaf => leaf.sprite.destroy()); };
  return { container, update(delta: number) {
    remaining -= delta;
    if (remaining <= 0) {
      spawn(); remaining = 12 + random() * 8;
      if (++releases % 3 === 0) pairDelay = 1.4;
    }
    if (pairDelay >= 0) { pairDelay -= delta; if (pairDelay < 0) spawn(); }
    for (let index = leaves.length - 1; index >= 0; index--) {
      const leaf = leaves[index]; leaf.age += delta;
      const t = leaf.age / leaf.duration;
      if (t >= 1) { leaf.sprite.destroy(); leaves.splice(index, 1); continue; }
      leaf.sprite.position.set(leaf.x + 24 * t + 7 * (Math.sin(t * Math.PI * 3 + leaf.phase) - Math.sin(leaf.phase)),
        leaf.y + 105 * t);
      leaf.sprite.rotation = 0.4 * Math.sin(t * Math.PI * 4 + leaf.phase);
      leaf.sprite.scale.x = 0.55 + 0.45 * Math.abs(Math.cos(t * Math.PI * 3 + leaf.phase));
      leaf.sprite.alpha = 0.7 * Math.min(1, t / 0.12, (1 - t) / 0.25);
    }
  }, reset() { clear(); remaining = 5 + random() * 4; pairDelay = -1; releases = 0; },
  destroy() { clear(); container.destroy(); } };
}
