// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";
import type { AssetBoardData, AssetBoardItem } from "@/features/canvas/domain/assetBoard";
import {
  appendFreezoneNodeMentions,
  buildFreezoneNodeMentionLookup,
  buildFreezoneNodePreviewInfo,
  buildFreezoneNodeSuggestions,
  filterFreezoneNodeSuggestions,
  freezoneNodeMentionIds,
  freezoneNodeMentionText,
  getFreezoneNodeAtQuery,
  insertFreezoneNodeMention,
  parseFreezoneNodeMentions,
  sanitizeFreezoneNodeLabel,
  stripFreezoneNodeAtQuery,
} from "./freezone-node-suggestions";

function item(partial: Partial<AssetBoardItem> & Pick<AssetBoardItem, "nodeId" | "column" | "title">): AssetBoardItem {
  return {
    mediaUrl: null,
    thumbnailUrl: null,
    textPreview: null,
    model: null,
    durationSec: null,
    widthPx: null,
    heightPx: null,
    videoRole: null,
    references: [],
    timestamp: null,
    isGenerating: false,
    generationStartedAt: null,
    generationError: null,
    keyElementCategory: null,
    ...partial,
  };
}

const board: AssetBoardData = {
  text: [item({ nodeId: "t1", column: "text", title: "分镜表" })],
  image: [item({ nodeId: "i1", column: "image", title: "多角度", thumbnailUrl: "https://x/i1.jpg" })],
  video: [item({ nodeId: "v1", column: "video", title: "视频节点5", mediaUrl: "https://x/v1.mp4" })],
  audio: [item({ nodeId: "a1", column: "audio", title: "背景音乐" })],
};

describe("getFreezoneNodeAtQuery", () => {
  it("returns empty string right after typing @", () => {
    expect(getFreezoneNodeAtQuery("@")).toBe("");
  });
  it("returns the query at end of string", () => {
    expect(getFreezoneNodeAtQuery("帮我 @多角")).toBe("多角");
  });
  it("returns query when @ is at the very start", () => {
    expect(getFreezoneNodeAtQuery("@多角")).toBe("多角");
  });
  it("does NOT match @ glued to a preceding non-space char (email-safe)", () => {
    expect(getFreezoneNodeAtQuery("a@b.com")).toBeNull();
    expect(getFreezoneNodeAtQuery("帮我@多角")).toBeNull();
  });
  it("closes (null) once a space follows the query", () => {
    expect(getFreezoneNodeAtQuery("@多角 ")).toBeNull();
  });
  it("with multiple @ tokens, only the trailing one counts", () => {
    // 第一个 @张三 后面跟着空白+非 @ 文本（"说 "），第二个 @多角 才是贴着串尾的 token；
    // 正则要求 $ 收尾，逐位左扫时只有从第二个 @ 前的空白开始才能匹配到串尾，故取"多角"。
    expect(getFreezoneNodeAtQuery("@张三 说 @多角")).toBe("多角");
  });
});

describe("buildFreezoneNodeSuggestions", () => {
  it("flattens board in text→image→video→audio order with mapped fields", () => {
    const result = buildFreezoneNodeSuggestions(board);
    expect(result.map((r) => r.nodeId)).toEqual(["t1", "i1", "v1", "a1"]);
    expect(result[1]).toEqual({
      nodeId: "i1",
      column: "image",
      title: "多角度",
      thumbnailUrl: "https://x/i1.jpg",
      mediaUrl: null,
      keyElementCategory: null,
    });
  });

  it("floats key-element nodes to the top, ordered by category (character→scene→object→other)", () => {
    // 关键元素散落在不同栏目、且乱序标记；期望按分类顺序置顶，未标记的保持栏目顺序垫底。
    const tagged: AssetBoardData = {
      text: [
        item({ nodeId: "t-scene", column: "text", title: "场景卡", keyElementCategory: "scene" }),
        item({ nodeId: "t-plain", column: "text", title: "普通文本" }),
      ],
      image: [item({ nodeId: "i-other", column: "image", title: "其他图", keyElementCategory: "other" })],
      video: [item({ nodeId: "v-char", column: "video", title: "主角视频", keyElementCategory: "character" })],
      audio: [item({ nodeId: "a-plain", column: "audio", title: "配乐" })],
    };
    const result = buildFreezoneNodeSuggestions(tagged);
    expect(result.map((r) => r.nodeId)).toEqual(["v-char", "t-scene", "i-other", "t-plain", "a-plain"]);
  });

  it("keeps column order stable among nodes sharing the same category", () => {
    // 同一分类内不重排：按扁平化栏目顺序（文本→图片→视频→音频）保持稳定。
    const sameCategory: AssetBoardData = {
      text: [item({ nodeId: "t-char", column: "text", title: "人物文本", keyElementCategory: "character" })],
      image: [item({ nodeId: "i-char", column: "image", title: "人物图片", keyElementCategory: "character" })],
      video: [],
      audio: [],
    };
    const result = buildFreezoneNodeSuggestions(sameCategory);
    expect(result.map((r) => r.nodeId)).toEqual(["t-char", "i-char"]);
  });
});

describe("filterFreezoneNodeSuggestions", () => {
  it("returns all items for empty query", () => {
    const all = buildFreezoneNodeSuggestions(board);
    expect(filterFreezoneNodeSuggestions(all, "")).toHaveLength(4);
  });
  it("filters by case-insensitive title substring", () => {
    const all = buildFreezoneNodeSuggestions(board);
    expect(filterFreezoneNodeSuggestions(all, "多角").map((r) => r.nodeId)).toEqual(["i1"]);
  });
});

describe("stripFreezoneNodeAtQuery", () => {
  it("removes a leading @token entirely", () => {
    expect(stripFreezoneNodeAtQuery("@多角")).toBe("");
  });
  it("keeps preceding text and its space", () => {
    expect(stripFreezoneNodeAtQuery("帮我 @多角")).toBe("帮我 ");
  });
  it("leaves text without an @token unchanged", () => {
    expect(stripFreezoneNodeAtQuery("帮我合成视频")).toBe("帮我合成视频");
  });
});

describe("sanitizeFreezoneNodeLabel", () => {
  it("strips bracket/paren/newline chars and collapses whitespace", () => {
    expect(sanitizeFreezoneNodeLabel("图片[节点](50)\n多角")).toBe("图片 节点 50 多角");
  });
  it("trims and returns empty string for whitespace-only", () => {
    expect(sanitizeFreezoneNodeLabel("   ")).toBe("");
  });
});

describe("insertFreezoneNodeMention", () => {
  it("replaces the trailing @query with a @[label](nodeId) token + trailing space", () => {
    expect(insertFreezoneNodeMention("帮我在 @多角", "node50", "图片节点50")).toBe(
      "帮我在 @[图片节点50](node50) ",
    );
  });
  it("replaces a leading @query", () => {
    expect(insertFreezoneNodeMention("@", "n1", "分镜表")).toBe("@[分镜表](n1) ");
  });
  it("sanitizes the label before embedding", () => {
    expect(insertFreezoneNodeMention("@x", "n1", "有(括号)的名字")).toBe("@[有 括号 的名字](n1) ");
  });
  it("falls back to nodeId when label sanitizes to empty", () => {
    expect(insertFreezoneNodeMention("@x", "n1", "()")).toBe("@[n1](n1) ");
  });
  it("appends with a leading space when there is no active @query", () => {
    expect(insertFreezoneNodeMention("已有文字", "n1", "名字")).toBe("已有文字 @[名字](n1) ");
  });
});

describe("parseFreezoneNodeMentions", () => {
  it("parses multiple tokens with correct nodeId/label/positions", () => {
    const value = "看 @[图片节点50](node50) 和 @[分镜表](t1) 对比";
    const parsed = parseFreezoneNodeMentions(value);
    expect(parsed.map((m) => m.nodeId)).toEqual(["node50", "t1"]);
    expect(parsed.map((m) => m.label)).toEqual(["图片节点50", "分镜表"]);
    expect(value.slice(parsed[0].start, parsed[0].end)).toBe("@[图片节点50](node50)");
  });
  it("returns empty for text without a node token", () => {
    expect(parseFreezoneNodeMentions("普通文本 @多角")).toEqual([]);
  });
});

describe("freezoneNodeMentionIds", () => {
  it("collects nodeIds deduped and order-preserving", () => {
    expect(freezoneNodeMentionIds("@[A](n1) @[B](n2) 再 @[A2](n1)")).toEqual(["n1", "n2"]);
  });
});

describe("freezoneNodeMentionText", () => {
  it("rewrites @[label](id) tokens to readable [label] and keeps the rest", () => {
    expect(freezoneNodeMentionText("帮我在 @[图片节点50](node50) 上生成小猫")).toBe(
      "帮我在 [图片节点50] 上生成小猫",
    );
  });
  it("keeps leading whitespace before a token", () => {
    expect(freezoneNodeMentionText("a @[X](n1) b")).toBe("a [X] b");
  });
  it("leaves text without tokens unchanged", () => {
    expect(freezoneNodeMentionText("没有引用的文本")).toBe("没有引用的文本");
  });
});

describe("buildFreezoneNodeMentionLookup", () => {
  it("maps nodeId to thumbnail/media/column", () => {
    const lookup = buildFreezoneNodeMentionLookup(buildFreezoneNodeSuggestions(board));
    expect(lookup.get("i1")).toEqual({
      thumbnailUrl: "https://x/i1.jpg",
      mediaUrl: null,
      column: "image",
    });
  });

  it("carries a video's mediaUrl for first-frame fallback when it has no poster thumbnail", () => {
    const lookup = buildFreezoneNodeMentionLookup(buildFreezoneNodeSuggestions(board));
    expect(lookup.get("v1")).toEqual({
      thumbnailUrl: null,
      mediaUrl: "https://x/v1.mp4",
      column: "video",
    });
  });
});

describe("appendFreezoneNodeMentions", () => {
  const titles = new Map([
    ["node50", "图片节点50"],
    ["t1", "分镜表"],
  ]);

  it("appends a single mention resolving its title from the lookup", () => {
    expect(appendFreezoneNodeMentions("帮我处理", ["node50"], titles)).toBe(
      "帮我处理 @[图片节点50](node50) ",
    );
  });

  it("appends multiple ids in order", () => {
    expect(appendFreezoneNodeMentions("看", ["node50", "t1"], titles)).toBe(
      "看 @[图片节点50](node50) @[分镜表](t1) ",
    );
  });

  it("skips ids missing from the lookup (node not on canvas)", () => {
    expect(appendFreezoneNodeMentions("draft", ["ghost"], titles)).toBe("draft");
  });

  it("skips ids already mentioned in the draft", () => {
    expect(appendFreezoneNodeMentions("已有 @[分镜表](t1) ", ["t1"], titles)).toBe(
      "已有 @[分镜表](t1) ",
    );
  });

  it("dedupes repeated ids within the same batch", () => {
    expect(appendFreezoneNodeMentions("", ["t1", "t1"], titles)).toBe("@[分镜表](t1) ");
  });

  it("leaves the draft unchanged for an empty batch", () => {
    expect(appendFreezoneNodeMentions("原样", [], titles)).toBe("原样");
  });
});

describe("buildFreezoneNodePreviewInfo", () => {
  it("keeps the thumbnail and maps image column to 图片", () => {
    expect(
      buildFreezoneNodePreviewInfo("多角度", { thumbnailUrl: "https://x/i1.jpg", mediaUrl: null, column: "image" }),
    ).toEqual({
      label: "多角度",
      thumbnailUrl: "https://x/i1.jpg",
      videoPosterUrl: null,
      typeLabel: "图片",
    });
  });

  it("prefers a video's poster thumbnail (no first-frame fallback needed)", () => {
    expect(
      buildFreezoneNodePreviewInfo("片段5", {
        thumbnailUrl: "https://x/v1.jpg",
        mediaUrl: "https://x/v1.mp4",
        column: "video",
      }),
    ).toEqual({
      label: "片段5",
      thumbnailUrl: "https://x/v1.jpg",
      videoPosterUrl: null,
      typeLabel: "视频",
    });
  });

  it("falls back to the video mediaUrl for a first-frame poster when it has no thumbnail", () => {
    expect(
      buildFreezoneNodePreviewInfo("无封面视频", { thumbnailUrl: null, mediaUrl: "https://x/v1.mp4", column: "video" }),
    ).toEqual({
      label: "无封面视频",
      thumbnailUrl: null,
      videoPosterUrl: "https://x/v1.mp4",
      typeLabel: "视频",
    });
  });

  it("does NOT use mediaUrl as a poster for non-video columns (audio has a media url too)", () => {
    // 音频也有 mediaUrl，但预览不该拿它当 <video> 首帧——只有视频列才走首帧兜底。
    expect(
      buildFreezoneNodePreviewInfo("配乐", { thumbnailUrl: null, mediaUrl: "https://x/bg.mp3", column: "audio" }),
    ).toEqual({
      label: "配乐",
      thumbnailUrl: null,
      videoPosterUrl: null,
      typeLabel: "音频",
    });
  });

  it("has no thumbnail for text nodes but still labels the type", () => {
    expect(buildFreezoneNodePreviewInfo("分镜表", { thumbnailUrl: null, mediaUrl: null, column: "text" })).toEqual({
      label: "分镜表",
      thumbnailUrl: null,
      videoPosterUrl: null,
      typeLabel: "文本",
    });
  });

  it("falls back to 引用 when the node is no longer on canvas (meta missing)", () => {
    expect(buildFreezoneNodePreviewInfo("旧引用", null)).toEqual({
      label: "旧引用",
      thumbnailUrl: null,
      videoPosterUrl: null,
      typeLabel: "引用",
    });
  });
});
