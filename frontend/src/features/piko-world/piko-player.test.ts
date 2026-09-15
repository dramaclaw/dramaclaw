// SPDX-License-Identifier: Elastic-2.0
import { beforeEach, expect, it, vi } from "vitest";
import { readPikoPlayer, savePikoPlayer } from "./piko-player";
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
