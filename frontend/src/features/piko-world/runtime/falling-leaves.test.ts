// SPDX-License-Identifier: Elastic-2.0
import { expect, it } from "vitest";
import { createFallingLeaves } from "./falling-leaves";

it("occasionally releases bounded leaves that drift, fade and are removed", () => {
  const effect = createFallingLeaves(() => 0.5);
  for (let i = 0; i < 60; i++) effect.update(0.1);
  expect(effect.container.children).toHaveLength(0);
  for (let i = 0; i < 12; i++) effect.update(0.1);
  const leaf = effect.container.children[0];
  expect(leaf).toBeDefined();
  const start = { x: leaf.x, y: leaf.y };
  for (let i = 0; i < 25; i++) effect.update(0.1);
  expect(leaf.x).not.toBe(start.x); expect(leaf.y).toBeGreaterThan(start.y);
  expect(leaf.alpha).toBeGreaterThan(0); expect(leaf.alpha).toBeLessThan(1);
  for (let i = 0; i < 50; i++) effect.update(0.1);
  expect(leaf.destroyed).toBe(true); expect(effect.container.children).toHaveLength(0);
  let peak = 0;
  for (let i = 0; i < 2000; i++) { effect.update(0.1); peak = Math.max(peak, effect.container.children.length); }
  expect(peak).toBe(2);
  effect.reset(); expect(effect.container.children).toHaveLength(0);
  effect.destroy(); expect(effect.container.destroyed).toBe(true);
});
