// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from "i18next";
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
import {
  DEFAULT_NODE_DISPLAY_NAME,
  EXPORT_RESULT_DISPLAY_NAME,
} from "@/features/canvas/domain/nodeDisplay";

// 大纲的默认名现在走 i18n。这里把 key 解回中文规范默认值，好让下面的断言仍然对着
// 用户看得见的文案写，而不是对着 key。
const t = ((key: string) => {
  const nodeType = key.replace("node.displayName.", "");
  if (nodeType !== key) {
    return DEFAULT_NODE_DISPLAY_NAME[nodeType as keyof typeof DEFAULT_NODE_DISPLAY_NAME];
  }
  const resultKind = key.replace("node.exportResult.", "");
  if (resultKind !== key) {
    return EXPORT_RESULT_DISPLAY_NAME[resultKind as keyof typeof EXPORT_RESULT_DISPLAY_NAME];
  }
  return key;
}) as unknown as TFunction;

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
    ], t);

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
    ], t);

    expect(outline).toHaveLength(2);
    expect(outline[0]).toMatchObject({ id: "g", kind: "group", name: "苏鸾" });
    expect(outline[0].children.map((child) => child.id)).toEqual(["m1", "m2"]);
    expect(outline[1]).toMatchObject({ id: "loose", kind: "node" });
  });

  it("prefers displayName over the legacy group label", () => {
    const outline = buildCanvasOutline([
      node("g", CANVAS_NODE_TYPES.group, { label: "旧名", displayName: "新名" }),
    ], t);

    expect(outline[0].name).toBe("新名");
  });

  it("nests groups inside groups", () => {
    const outline = buildCanvasOutline([
      node("outer", CANVAS_NODE_TYPES.group, { label: "外层" }),
      node("inner", CANVAS_NODE_TYPES.group, { label: "内层" }, "outer"),
      node("leaf", CANVAS_NODE_TYPES.imageGen, {}, "inner"),
    ], t);

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
    ], t);

    expect(outline.map((item) => item.id)).toEqual(["orphan", "host", "child-of-non-group"]);
  });

  it("picks up the node image as its thumbnail", () => {
    const outline = buildCanvasOutline([
      node("a", CANVAS_NODE_TYPES.exportImage, { imageUrl: "https://cdn/a.png" }),
      node("b", CANVAS_NODE_TYPES.video, { previewImageUrl: "https://cdn/b.jpg" }),
      node("c", CANVAS_NODE_TYPES.audio, {}),
    ], t);

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
    ], t);

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
    ], t);

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
    ], t);

    expect(outline[0].thumbUrl).toBe("https://cdn/c.jpg");
    expect(outline[0].mediaUrl).toBe("https://cdn/c.mp4");
  });

  // 下面这几种节点身上原件与封面同时存在，且原件不叫 videoUrl。自己认字段的实现会
  // 把封面当原件下载给用户 —— 必须走 resolveNodePrimaryAsset 那张全局映射。
  it("下载 3D 世界拿的是 3GS 包，不是封面图", () => {
    const outline = buildCanvasOutline([
      node("world", CANVAS_NODE_TYPES.threeDWorld, {
        plyUrl: "https://cdn/scene.sog",
        previewImageUrl: "https://cdn/cover.png",
      }),
    ], t);

    expect(outline[0].thumbUrl).toBe("https://cdn/cover.png");
    expect(outline[0].mediaUrl).toBe("https://cdn/scene.sog");
  });

  it("下载视频合成拿的是成片，不是海报", () => {
    const outline = buildCanvasOutline([
      node("compose", CANVAS_NODE_TYPES.videoCompose, {
        resultVideoUrl: "https://cdn/final.mp4",
        previewImageUrl: "https://cdn/poster.jpg",
      }),
    ], t);

    expect(outline[0].thumbUrl).toBe("https://cdn/poster.jpg");
    expect(outline[0].mediaUrl).toBe("https://cdn/final.mp4");
  });

  it("视频故事只有源片时也能下载", () => {
    const outline = buildCanvasOutline([
      node("story", CANVAS_NODE_TYPES.videoStory, {
        sourceVideoUrl: "https://cdn/source.mp4",
      }),
    ], t);

    expect(outline[0].mediaUrl).toBe("https://cdn/source.mp4");
  });

  it("全景查看器的球面贴图既是缩略图也是原件", () => {
    const outline = buildCanvasOutline([
      node("pano", CANVAS_NODE_TYPES.pano360Viewer, {
        imageUrl: "https://cdn/pano.jpg",
      }),
    ], t);

    expect(outline[0].thumbUrl).toBe("https://cdn/pano.jpg");
    expect(outline[0].mediaUrl).toBe("https://cdn/pano.jpg");
  });

  it("分格节点下载第一格，而不是整节点没有原件", () => {
    const outline = buildCanvasOutline([
      node("split", CANVAS_NODE_TYPES.storyboardSplit, {
        frames: [
          { imageUrl: "https://cdn/frame-0.png" },
          { imageUrl: "https://cdn/frame-1.png" },
        ],
      }),
    ], t);

    expect(outline[0].mediaUrl).toBe("https://cdn/frame-0.png");
  });
});

describe("collectOutlineGroupIds", () => {
  it("collects nested groups but not plain nodes", () => {
    const outline = buildCanvasOutline([
      node("outer", CANVAS_NODE_TYPES.group, { label: "外层" }),
      node("inner", CANVAS_NODE_TYPES.group, { label: "内层" }, "outer"),
      node("leaf", CANVAS_NODE_TYPES.imageGen, {}, "inner"),
      node("loose", CANVAS_NODE_TYPES.audio, {}),
    ], t);

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
    // 上面那条 exactly-once 棘轮只管「被某个档收了」，收进哪个档它无感。
    expect(outlineFilterTypes("world")).toContain(CANVAS_NODE_TYPES.previz);
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
  ], t);

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

describe("outline meta", () => {
  // 时刻只在「正在转圈」时看得见、跑完就消失，是这一行最容易退回去的坑：
  // generationStartedAt 在每条生成链路的成功和失败分支上都会被写回 null，
  // 所以下面这两条钉的是「读的必须是持久字段」，而不是「能显示出个时间」。
  const CREATED_AT = new Date(2026, 7, 20, 14, 32).getTime(); // 08-20 14:32

  function metaOf(data: Record<string, unknown>): string | null {
    const [item] = buildCanvasOutline([node("a", CANVAS_NODE_TYPES.video, data)], t);
    return item.kind === "node" ? item.meta : null;
  }

  it("keeps the stamp after generation finishes", () => {
    // 生成跑完的样子：isGenerating 落回 false，generationStartedAt 被清成 null。
    expect(
      metaOf({
        displayName: "海边的黄昏",
        createdAt: CREATED_AT,
        isGenerating: false,
        generationStartedAt: null,
      }),
    ).toContain("08-20 14:32");
  });

  it("does not fall back to the transient generationStartedAt", () => {
    // 老画布里的节点没有 createdAt。宁可不显示，也不能显示一个待会儿要蒸发的值。
    const meta = metaOf({
      displayName: "海边的黄昏",
      isGenerating: true,
      generationStartedAt: CREATED_AT,
    });

    expect(meta).not.toContain("14:32");
  });

  it("separates same-named siblings by their own creation moment", () => {
    // 同一条提示词生成三次：名字和类型都一样，只剩时刻能区分。
    const outline = buildCanvasOutline([
      node("a", CANVAS_NODE_TYPES.video, { displayName: "海边的黄昏", createdAt: CREATED_AT }),
      node("b", CANVAS_NODE_TYPES.video, {
        displayName: "海边的黄昏",
        createdAt: CREATED_AT + 5 * 60_000,
      }),
    ], t);
    const metas = outline.map((item) => (item.kind === "node" ? item.meta : null));

    expect(metas[0]).not.toBe(metas[1]);
    expect(metas[0]).toContain("14:32");
    expect(metas[1]).toContain("14:37");
  });
});
