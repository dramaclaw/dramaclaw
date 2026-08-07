// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
  type CanvasNodeType,
} from "@/features/canvas/domain/canvasNodes";
import {
  buildCanvasOutline,
  CANVAS_OUTLINE_FILTERS,
  canvasOutlineSignature,
  collectOutlineDownloads,
  collectOutlineGroupIds,
  collectOutlineIds,
  countOutlineNodes,
  filterCanvasOutline,
  matchesOutlineQuery,
  outlineFilterTypes,
} from "@/features/freezone/CanvasOutlineList";

function node(
  id: string,
  type: CanvasNode["type"],
  data: Record<string, unknown> = {},
  parentId?: string,
): CanvasNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data,
    ...(parentId ? { parentId } : {}),
  } as CanvasNode;
}

describe("buildCanvasOutline", () => {
  it("keeps ungrouped nodes at the top level in store order", () => {
    const outline = buildCanvasOutline([
      node("a", CANVAS_NODE_TYPES.imageGen, { displayName: "封面" }),
      node("b", CANVAS_NODE_TYPES.video, {}),
    ]);

    expect(outline.map((item) => [item.id, item.kind, item.name])).toEqual([
      ["a", "node", "封面"],
      ["b", "node", "视频"],
    ]);
  });

  it("turns a group node into a folder named after the group", () => {
    const outline = buildCanvasOutline([
      node("g", CANVAS_NODE_TYPES.group, { label: "苏鸾" }),
      node("m1", CANVAS_NODE_TYPES.imageGen, { displayName: "立绘" }, "g"),
      node("m2", CANVAS_NODE_TYPES.video, {}, "g"),
      node("loose", CANVAS_NODE_TYPES.audio, {}),
    ]);

    expect(outline).toHaveLength(2);
    expect(outline[0]).toMatchObject({ id: "g", kind: "group", name: "苏鸾" });
    expect(outline[0].children.map((child) => child.id)).toEqual(["m1", "m2"]);
    expect(outline[1]).toMatchObject({ id: "loose", kind: "node" });
  });

  it("prefers displayName over the legacy group label", () => {
    const outline = buildCanvasOutline([
      node("g", CANVAS_NODE_TYPES.group, { label: "旧名", displayName: "新名" }),
    ]);

    expect(outline[0].name).toBe("新名");
  });

  it("nests groups inside groups", () => {
    const outline = buildCanvasOutline([
      node("outer", CANVAS_NODE_TYPES.group, { label: "外层" }),
      node("inner", CANVAS_NODE_TYPES.group, { label: "内层" }, "outer"),
      node("leaf", CANVAS_NODE_TYPES.imageGen, {}, "inner"),
    ]);

    expect(outline).toHaveLength(1);
    expect(outline[0].children[0]).toMatchObject({ id: "inner", kind: "group" });
    expect(outline[0].children[0].children.map((child) => child.id)).toEqual(["leaf"]);
    expect(countOutlineNodes(outline)).toBe(1);
  });

  it("keeps nodes whose parent is missing or is not a group", () => {
    const outline = buildCanvasOutline([
      node("orphan", CANVAS_NODE_TYPES.imageGen, {}, "gone"),
      node("host", CANVAS_NODE_TYPES.imageGen, {}),
      node("child-of-non-group", CANVAS_NODE_TYPES.video, {}, "host"),
    ]);

    expect(outline.map((item) => item.id)).toEqual(["orphan", "host", "child-of-non-group"]);
  });

  it("picks up the node image as its thumbnail", () => {
    const outline = buildCanvasOutline([
      node("a", CANVAS_NODE_TYPES.exportImage, { imageUrl: "https://cdn/a.png" }),
      node("b", CANVAS_NODE_TYPES.video, { previewImageUrl: "https://cdn/b.jpg" }),
      node("c", CANVAS_NODE_TYPES.audio, {}),
    ]);

    expect(outline.map((item) => item.thumbUrl)).toEqual([
      "https://cdn/a.png",
      "https://cdn/b.jpg",
      null,
    ]);
  });
});

describe("collectOutlineIds", () => {
  it("lists a group before its members so clones can re-parent", () => {
    const outline = buildCanvasOutline([
      node("outer", CANVAS_NODE_TYPES.group, { label: "外层" }),
      node("inner", CANVAS_NODE_TYPES.group, { label: "内层" }, "outer"),
      node("leaf", CANVAS_NODE_TYPES.imageGen, {}, "inner"),
    ]);

    expect(collectOutlineIds(outline[0])).toEqual(["outer", "inner", "leaf"]);
  });
});

describe("collectOutlineDownloads", () => {
  it("collects every descendant that actually has media", () => {
    const outline = buildCanvasOutline([
      node("g", CANVAS_NODE_TYPES.group, { label: "组" }),
      node("img", CANVAS_NODE_TYPES.exportImage, { imageUrl: "https://cdn/a.png" }, "g"),
      node("mute", CANVAS_NODE_TYPES.audio, {}, "g"),
      node("clip", CANVAS_NODE_TYPES.video, { videoUrl: "https://cdn/c.mp4" }, "g"),
    ]);

    expect(collectOutlineDownloads(outline[0]).map((item) => [item.id, item.mediaUrl])).toEqual([
      ["img", "https://cdn/a.png"],
      ["clip", "https://cdn/c.mp4"],
    ]);
  });

  it("prefers the video/audio original over the still preview", () => {
    const outline = buildCanvasOutline([
      node("clip", CANVAS_NODE_TYPES.video, {
        videoUrl: "https://cdn/c.mp4",
        previewImageUrl: "https://cdn/c.jpg",
      }),
    ]);

    expect(outline[0].thumbUrl).toBe("https://cdn/c.jpg");
    expect(outline[0].mediaUrl).toBe("https://cdn/c.mp4");
  });
});

describe("collectOutlineGroupIds", () => {
  it("collects nested groups but not plain nodes", () => {
    const outline = buildCanvasOutline([
      node("outer", CANVAS_NODE_TYPES.group, { label: "外层" }),
      node("inner", CANVAS_NODE_TYPES.group, { label: "内层" }, "outer"),
      node("leaf", CANVAS_NODE_TYPES.imageGen, {}, "inner"),
      node("loose", CANVAS_NODE_TYPES.audio, {}),
    ]);

    expect(collectOutlineGroupIds(outline)).toEqual(["outer", "inner"]);
  });
});

describe("CANVAS_OUTLINE_FILTERS", () => {
  it("covers every node type exactly once, groups excluded", () => {
    const seen = new Set<CanvasNodeType>();
    for (const filter of CANVAS_OUTLINE_FILTERS) {
      for (const type of filter.types) {
        expect(seen.has(type)).toBe(false);
        seen.add(type);
      }
    }

    const expected = Object.values(CANVAS_NODE_TYPES).filter(
      (type) => type !== CANVAS_NODE_TYPES.group,
    );
    expect([...seen].sort()).toEqual([...expected].sort());
  });

  it("maps 全部 to an empty type list", () => {
    expect(outlineFilterTypes("all")).toEqual([]);
    expect(outlineFilterTypes("audio")).toEqual([CANVAS_NODE_TYPES.audio]);
  });
});

describe("matchesOutlineQuery", () => {
  it("matches case-insensitive substrings", () => {
    expect(matchesOutlineQuery("Image 107 - 副本", "image 107")).toBe(true);
    expect(matchesOutlineQuery("Image 107 - 副本", "副本")).toBe(true);
  });

  it("falls back to subsequence matching", () => {
    expect(matchesOutlineQuery("Image 107 - 副本", "img107")).toBe(true);
    expect(matchesOutlineQuery("Image 107 - 副本", "img701")).toBe(false);
  });

  it("rejects subsequences scattered across a long prompt name", () => {
    const prompt = `白袍侠客在雨夜的青石板路上疾行${"，".repeat(60)}斗笠下露出几缕发丝，衣袖翻卷`;
    expect(matchesOutlineQuery(prompt, "白衣")).toBe(false);
    expect(matchesOutlineQuery("白衣女", "白衣")).toBe(true);
  });

  it("treats an empty query as a match", () => {
    expect(matchesOutlineQuery("任意", "   ")).toBe(true);
  });
});

describe("filterCanvasOutline", () => {
  const outline = buildCanvasOutline([
    node("g", CANVAS_NODE_TYPES.group, { label: "苏鸾" }),
    node("m1", CANVAS_NODE_TYPES.imageGen, { displayName: "立绘" }, "g"),
    node("m2", CANVAS_NODE_TYPES.video, { displayName: "出场镜头" }, "g"),
    node("loose", CANVAS_NODE_TYPES.audio, { displayName: "配乐" }),
  ]);

  it("returns the same array when nothing is filtered", () => {
    expect(filterCanvasOutline(outline, { query: "  ", types: [] })).toBe(outline);
  });

  it("keeps a group but only the members that match", () => {
    const result = filterCanvasOutline(outline, {
      query: "",
      types: outlineFilterTypes("video"),
    });

    expect(result.map((item) => item.id)).toEqual(["g"]);
    expect(result[0].children.map((child) => child.id)).toEqual(["m2"]);
  });

  it("drops groups whose members all miss", () => {
    const result = filterCanvasOutline(outline, {
      query: "",
      types: outlineFilterTypes("audio"),
    });

    expect(result.map((item) => item.id)).toEqual(["loose"]);
  });

  it("keeps the whole group when the group name itself matches", () => {
    const result = filterCanvasOutline(outline, { query: "苏鸾", types: [] });

    expect(result.map((item) => item.id)).toEqual(["g"]);
    expect(result[0].children.map((child) => child.id)).toEqual(["m1", "m2"]);
  });

  it("combines the type filter with the query", () => {
    expect(
      filterCanvasOutline(outline, { query: "立绘", types: outlineFilterTypes("image") }).flatMap(
        (item) => item.children.map((child) => child.id),
      ),
    ).toEqual(["m1"]);
    // 组名命中不能绕过类型筛选，否则筛「图片」会把整个组的视频也带出来
    expect(filterCanvasOutline(outline, { query: "苏鸾", types: outlineFilterTypes("video") })).toEqual(
      [],
    );
  });
});

describe("canvasOutlineSignature", () => {
  it("ignores position changes", () => {
    const before = [node("a", CANVAS_NODE_TYPES.imageGen, { displayName: "封面" })];
    const after = [
      { ...before[0], position: { x: 999, y: -42 } } as CanvasNode,
    ];

    expect(canvasOutlineSignature(after)).toBe(canvasOutlineSignature(before));
  });

  it("changes when a node is renamed, regrouped, added or re-imaged", () => {
    const base = [
      node("g", CANVAS_NODE_TYPES.group, { label: "组" }),
      node("a", CANVAS_NODE_TYPES.exportImage, { displayName: "封面", imageUrl: "u1" }),
    ];
    const signature = canvasOutlineSignature(base);

    expect(
      canvasOutlineSignature([
        base[0],
        node("a", CANVAS_NODE_TYPES.exportImage, { displayName: "改名", imageUrl: "u1" }),
      ]),
    ).not.toBe(signature);
    expect(
      canvasOutlineSignature([
        base[0],
        node("a", CANVAS_NODE_TYPES.exportImage, { displayName: "封面", imageUrl: "u1" }, "g"),
      ]),
    ).not.toBe(signature);
    expect(
      canvasOutlineSignature([
        base[0],
        node("a", CANVAS_NODE_TYPES.exportImage, { displayName: "封面", imageUrl: "u2" }),
      ]),
    ).not.toBe(signature);
    expect(canvasOutlineSignature([...base, node("b", CANVAS_NODE_TYPES.audio)])).not.toBe(
      signature,
    );
  });
});
