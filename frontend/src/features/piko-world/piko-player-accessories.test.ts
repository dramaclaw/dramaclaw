// SPDX-License-Identifier: Elastic-2.0
import { afterEach, expect, it } from "vitest";
import { readPlayerAccessory, savePlayerAccessory } from "./piko-player-accessories";
afterEach(() => localStorage.clear());
it("persists equipment per account, accepts unequipping and ignores invalid saved IDs", () => {
  expect(readPlayerAccessory("a")).toBeNull();
  expect(savePlayerAccessory("a", "red-bow")).toBe(true);
  expect(readPlayerAccessory("a")).toBe("red-bow");
  expect(readPlayerAccessory("b")).toBeNull();
  expect(readPlayerAccessory(null)).toBeNull();
  savePlayerAccessory("a", null);
  expect(readPlayerAccessory("a")).toBeNull();
  localStorage.setItem('dramaclaw.piko-world.accessory.v1:"a"', '"not-an-accessory"');
  expect(readPlayerAccessory("a")).toBeNull();
});
