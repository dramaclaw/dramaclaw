// SPDX-License-Identifier: Elastic-2.0
import { beforeEach, expect, it, vi } from "vitest";
import { pikoPlayerIdleFrameAt, readPikoPlayer, savePikoPlayer } from "./piko-player";
beforeEach(() => localStorage.clear());
it("separates accounts and does not treat legacy NPC selection as completed creation", () => {
  localStorage.setItem("dramaclaw.piko-world.resident-id.v1", "m01");
  expect(readPikoPlayer("alice")).toBeNull();
  expect(savePikoPlayer("alice", "female", " 花花 ")).toBe(true);
  expect(readPikoPlayer("alice")).toEqual({ version: 1, gender: "female", nickname: "花花" });
  expect(readPikoPlayer("bob")).toBeNull(); expect(readPikoPlayer(null)).toBeNull();
});
it("rejects invalid records and invalid nicknames", () => {
  expect(savePikoPlayer("alice", "male", "  ")).toBe(false);
  localStorage.setItem('dramaclaw.piko-world.player.v1:"alice"', '{"version":1,"gender":"m01","nickname":"ok"}');
  expect(readPikoPlayer("alice")).toBeNull();
  const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(readPikoPlayer("alice")).toBeNull(); spy.mockRestore();
});
it("plays the player's body-action idle cycle and returns to the neutral pose", () => {
  expect([0, 1799, 1800, 1979, 1980, 2799, 2800, 4399, 4400, 6099, 6100, 6279, 6280, 7999, 8000, NaN]
    .map(ms => pikoPlayerIdleFrameAt(ms, "south"))).toEqual([0, 0, 2, 2, 0, 0, 1, 1, 0, 0, 2, 2, 0, 0, 0, 0]);
  expect([1800, 2800, 4400, 6100].map(ms => pikoPlayerIdleFrameAt(ms, "north")))
    .toEqual([0, 1, 0, 0]);
});
