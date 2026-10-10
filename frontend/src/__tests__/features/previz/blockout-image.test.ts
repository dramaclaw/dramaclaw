// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  blockoutImageHints,
  isAcceptedBlockoutImage,
} from "@/features/previz/domain/blockoutImage";

const MB = 1024 * 1024;

describe("isAcceptedBlockoutImage", () => {
  it.each(["room.png", "room.jpg", "room.jpeg", "room.webp", "ROOM.PNG", "a.b.JpEg"])(
    "accepts %s",
    (name) => {
      expect(isAcceptedBlockoutImage(name, MB)).toBe("ok");
    },
  );

  it.each(["room.gif", "room.heic", "room.svg", "room.glb", "room", "png", ".png.txt"])(
    "refuses %s as a format the backend would turn away",
    (name) => {
      expect(isAcceptedBlockoutImage(name, MB)).toBe("extension");
    },
  );

  it("accepts a file of exactly 20 MB and refuses one byte more", () => {
    expect(isAcceptedBlockoutImage("room.png", 20 * MB)).toBe("ok");
    expect(isAcceptedBlockoutImage("room.png", 20 * MB + 1)).toBe("size");
  });

  it("refuses an empty file", () => {
    expect(isAcceptedBlockoutImage("room.png", 0)).toBe("size");
  });
});

describe("blockoutImageHints", () => {
  it("says nothing about an ordinary landscape or portrait picture", () => {
    expect(blockoutImageHints({ width: 1920, height: 1080 })).toEqual([]);
    expect(blockoutImageHints({ width: 1080, height: 1920 })).toEqual([]);
    expect(blockoutImageHints({ width: 512, height: 512 })).toEqual([]);
  });

  it("warns when the short edge is under 512 pixels", () => {
    expect(blockoutImageHints({ width: 800, height: 511 })).toEqual(["small"]);
    expect(blockoutImageHints({ width: 511, height: 800 })).toEqual(["small"]);
  });

  it("warns about strips wider than 2.5 to 1, which are usually panoramas or collages", () => {
    expect(blockoutImageHints({ width: 2500, height: 1000 })).toEqual([]);
    expect(blockoutImageHints({ width: 2501, height: 1000 })).toEqual(["wide"]);
  });

  it("warns about strips taller than 1 to 2.5", () => {
    expect(blockoutImageHints({ width: 1000, height: 2500 })).toEqual([]);
    expect(blockoutImageHints({ width: 1000, height: 2501 })).toEqual(["tall"]);
  });

  it("can give two hints at once", () => {
    expect(blockoutImageHints({ width: 1500, height: 300 })).toEqual(["small", "wide"]);
  });

  it.each([
    null,
    { width: 0, height: 100 },
    { width: 100, height: 0 },
    { width: -1, height: 100 },
    { width: Number.NaN, height: 100 },
    { width: Number.POSITIVE_INFINITY, height: 100 },
  ])("says the picture could not be read when the size is unknown or nonsense: %o", (size) => {
    // 改了后缀的 HEIC、传坏的文件：浏览器解不出来，后端多半也读不了。
    expect(blockoutImageHints(size)).toEqual(["unreadable"]);
  });
});
