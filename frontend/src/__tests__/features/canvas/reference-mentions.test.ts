// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  remapReferenceMentions,
  sameOrder,
} from "@/features/canvas/nodes/referenceMentions";

const imageFamily = (prevIds: string[], nextIds: string[]) => ({
  prefix: "图片",
  prevIds,
  nextIds,
});

describe("remapReferenceMentions", () => {
  it("renumbers a mention when an earlier reference is removed", () => {
    // 回归用例:引用 [A, B],prompt 里 @图片2(→B);删掉 A 后 B 变图片1,
    // @图片2 应跟着变成 @图片1。
    const out = remapReferenceMentions("让 @图片2 动起来", [
      imageFamily(["A", "B"], ["B"]),
    ]);
    expect(out).toBe("让 @图片1 动起来");
  });

  it("drops a mention whose referenced node was removed (with trailing space)", () => {
    const out = remapReferenceMentions("先 @图片1 再 @图片2 收尾", [
      imageFamily(["A", "B"], ["B"]),
    ]);
    // A(图片1) 被删 → 去掉「@图片1 」;B 从图片2 变图片1。
    expect(out).toBe("先 再 @图片1 收尾");
  });

  it("follows nodes through a manual reorder", () => {
    const out = remapReferenceMentions("@图片1 和 @图片2", [
      imageFamily(["A", "B"], ["B", "A"]),
    ]);
    // A: 图片1→图片2;B: 图片2→图片1。
    expect(out).toBe("@图片2 和 @图片1");
  });

  it("leaves mentions untouched when a new reference is appended", () => {
    const out = remapReferenceMentions("用 @图片1", [
      imageFamily(["A"], ["A", "C"]),
    ]);
    expect(out).toBe("用 @图片1");
  });

  it("handles multi-digit numbering without cross-token collisions", () => {
    const prev = ["n1", "n2", "n3"];
    const next = ["n3", "n1", "n2"]; // 每个都右移一位、首位回到第一
    const out = remapReferenceMentions("@图片1 @图片2 @图片3", [
      imageFamily(prev, next),
    ]);
    // n1:1→2, n2:2→3, n3:3→1
    expect(out).toBe("@图片2 @图片3 @图片1");
  });

  it("remaps image and audio families independently", () => {
    const out = remapReferenceMentions("看 @图片2 听 @音频2", [
      imageFamily(["i1", "i2"], ["i2"]),
      { prefix: "音频", prevIds: ["a1", "a2"], nextIds: ["a2"] },
    ]);
    expect(out).toBe("看 @图片1 听 @音频1");
  });

  it("leaves out-of-range / untracked numbers as-is", () => {
    const out = remapReferenceMentions("@图片9 保留", [
      imageFamily(["A", "B"], ["B"]),
    ]);
    expect(out).toBe("@图片9 保留");
  });

  it("returns prompt unchanged when order did not change", () => {
    const out = remapReferenceMentions("@图片1 @图片2", [
      imageFamily(["A", "B"], ["A", "B"]),
    ]);
    expect(out).toBe("@图片1 @图片2");
  });

  it("keeps MiniMax H3 Mixed placeholders bound through a cross-media reorder", () => {
    const out = remapReferenceMentions(
      "场景 {{Mixed 2}}，角色 {{Mixed 1}}，声音 {{Mixed 3}}",
      [
        {
          prefix: "Mixed",
          syntax: "mixed",
          prevIds: ["frog", "scene", "audio"],
          nextIds: ["scene", "audio", "frog"],
        },
      ],
    );
    expect(out).toBe("场景 {{Mixed 1}}，角色 {{Mixed 3}}，声音 {{Mixed 2}}");
  });

  it("removes an H3 Mixed placeholder when its reference node is detached", () => {
    const out = remapReferenceMentions("保留 {{Mixed 2}}，删除 {{Mixed 1}} 后继续", [
      {
        prefix: "Mixed",
        syntax: "mixed",
        prevIds: ["removed", "kept"],
        nextIds: ["kept"],
      },
    ]);
    expect(out).toBe("保留 {{Mixed 1}}，删除 后继续");
  });
});

describe("sameOrder", () => {
  it("compares by length and element identity in order", () => {
    expect(sameOrder(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameOrder(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameOrder(["a"], ["a", "b"])).toBe(false);
    expect(sameOrder([], [])).toBe(true);
  });
});
