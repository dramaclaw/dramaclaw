// SPDX-License-Identifier: Elastic-2.0
import { expect, it } from "vitest";
import { upsertRemotePlayer, type PikoRemotePlayer } from "./piko-world-client";

const remotePlayer = (overrides: Partial<PikoRemotePlayer> = {}): PikoRemotePlayer => ({
  character_id: "player-1",
  nickname: "小禾",
  gender: "female",
  scene_id: "welcome-courtyard",
  x: 100,
  y: 200,
  facing: "south",
  ...overrides,
});

it("retains an active speech bubble while applying movement updates", () => {
  const speech = { id: "message-1", body: "大家好", expiresAt: 20_000 };
  const players = [remotePlayer({ speech })];

  const result = upsertRemotePlayer(
    players,
    remotePlayer({ x: 140, y: 230, facing: "east" }),
    15_000,
  );

  expect(result[0]).toMatchObject({ x: 140, y: 230, facing: "east", speech });
});

it("drops an expired speech bubble on the next player update", () => {
  const players = [remotePlayer({
    speech: { id: "message-1", body: "已经过期", expiresAt: 20_000 },
  })];

  const result = upsertRemotePlayer(players, remotePlayer({ x: 140 }), 20_000);

  expect(result[0].speech).toBeUndefined();
});
