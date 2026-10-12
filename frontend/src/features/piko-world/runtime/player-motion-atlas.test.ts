// SPDX-License-Identifier: Elastic-2.0
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { Texture, TextureSource, type Ticker } from "pixi.js";
import { createCharacterActor } from "./character-actor";
import headAnchors from "./player-head-anchors.json";
import { PIKO_FEMALE_PLAYER_MOTION_SRC, PIKO_MALE_PLAYER_MOTION_SRC, PIKO_PLAYER_MOTION_COLUMNS, PIKO_PLAYER_WALK_COLUMNS } from "../piko-player";
import { gaitColumn } from "./character-gait";

vi.mock("./character-shadow", () => ({ createContactShadow: () => new Texture({ source: new TextureSource({ width: 24, height: 8 }) }) }));

it.each([["female", PIKO_FEMALE_PLAYER_MOTION_SRC], ["male", PIKO_MALE_PLAYER_MOTION_SRC]] as const)("loads every %s walking phase from its actual compact PNG atlas", (gender, src) => {
  const png = readFileSync("public" + src);
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  const texture = new Texture({ source: new TextureSource({ width, height }) });
  const actor = createCharacterActor(texture, { add() {}, remove() {} } as unknown as Ticker, () => true, {
    label: "player", frameSize: 64, frameCount: PIKO_PLAYER_MOTION_COLUMNS * 4,
    columns: PIKO_PLAYER_MOTION_COLUMNS, manual: true, pivot: { x: 32, y: 57 }, position: { x: 0, y: 0 },
    scale: 2, shadow: { width: 24, height: 8 }, durationMs: 8000, frameAt: () => 0,
  });
  expect(headAnchors[gender]).toHaveLength(PIKO_PLAYER_MOTION_COLUMNS * 4);
  for (let facing = 0; facing < 4; facing++) {
    const neutralHead = headAnchors[gender][facing * PIKO_PLAYER_MOTION_COLUMNS + 4];
    for (const column of PIKO_PLAYER_WALK_COLUMNS) {
      expect(headAnchors[gender][facing * PIKO_PLAYER_MOTION_COLUMNS + column]).toEqual(neutralHead);
    }
    for (const column of [0, 1, 2]) {
      const index = facing * PIKO_PLAYER_MOTION_COLUMNS + column;
      actor.setFrame(index);
      expect(actor.body.texture.frame.x).toBe(column * 256);
      expect(actor.body.texture.frame.y).toBe(facing * 256);
      expect(actor.body.height).toBe(128);
      expect(actor.body.anchor.y).toBe(57 / 64);
      expect(headAnchors[gender][index].every(Number.isFinite)).toBe(true);
    }
    const frames = [0, 20, 40, 60].map(distance => {
      const column = gaitColumn(distance, 80, PIKO_PLAYER_WALK_COLUMNS);
      const index = facing * PIKO_PLAYER_MOTION_COLUMNS + column;
      actor.setFrame(index);
      expect(actor.body.texture.frame.y).toBe(facing * 256);
      expect(actor.body.width).toBe(128);
      expect(headAnchors[gender][index].every(Number.isFinite)).toBe(true);
      return actor.body.texture.frame.x;
    });
    expect(new Set(frames).size).toBe(3);
    expect(frames[1]).toBe(frames[3]);
  }
  actor.destroy(); texture.destroy(true);
});
