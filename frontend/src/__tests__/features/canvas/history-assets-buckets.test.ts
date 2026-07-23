// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  assetMatchesQuery,
  filterAssetBuckets,
  recordsToAssetBuckets,
} from "@/features/canvas/ui/CanvasHistoryAssetsModal";
import type { CanvasAsset } from "@/features/canvas/domain/canvasAssets";
import {
  historyRecordInputImageUrl,
  historyRecordPreviewImageUrl,
  historyRecordStrictWorldUrl,
} from "@/features/canvas/ui/NodeGenerationHistory";
import type { FreezoneGenerationHistoryRecord } from "@/api/ops";

function record(
  partial: Partial<FreezoneGenerationHistoryRecord>,
): FreezoneGenerationHistoryRecord {
  return {
    id: "rec-1",
    status: "completed",
    recorded_at: "2026-06-15T00:00:00Z",
    media_type: "image",
    result: {},
    ...partial,
  } as FreezoneGenerationHistoryRecord;
}

describe("historyRecordStrictWorldUrl", () => {
  it("finds a nested .sog world asset", () => {
    expect(
      historyRecordStrictWorldUrl(
        record({ result: { data: { sog_url: "/static/p/scene/pano_depth.sog" } } }),
      ),
    ).toBe("/static/p/scene/pano_depth.sog");
  });

  it("returns null for an ordinary image record (no 3GS marker)", () => {
    expect(
      historyRecordStrictWorldUrl(
        record({ result: { output_url: "/static/p/foo.png", url: "/static/p/bar.png" } }),
      ),
    ).toBeNull();
  });
});

describe("historyRecordInputImageUrl (world cover fallback)", () => {
  it("uses the input source image as a cover for a .sog world record", () => {
    const rec = record({
      result: { source_url: "/static/p/src.png", ply_url: "/static/p/world.sog" },
    });
    expect(historyRecordInputImageUrl(rec)).toBe("/static/p/src.png");
    // and it flows through the preview-image resolver too
    expect(historyRecordPreviewImageUrl(rec)).toBe("/static/p/src.png");
  });

  it("digs the input image out of a nested params container", () => {
    expect(
      historyRecordInputImageUrl(
        record({ result: { params: { image_url: "/static/p/in.jpg" } } }),
      ),
    ).toBe("/static/p/in.jpg");
  });

  it("never returns the .sog/.ply product as a cover", () => {
    expect(
      historyRecordInputImageUrl(record({ result: { url: "/static/p/world.sog" } })),
    ).toBeNull();
  });
});

describe("recordsToAssetBuckets — world history", () => {
  it("buckets a .sog record as `model` even when media_type is not 3d/ply (the bug)", () => {
    const buckets = recordsToAssetBuckets([
      record({
        id: "world-1",
        // image-to-3gs records often come back tagged `image`, not `3d`.
        media_type: "image",
        result: { ply_url: "/static/p/scene/pano_depth.sog" },
      }),
    ]);
    expect(buckets.model).toHaveLength(1);
    expect(buckets.model[0]?.url).toContain("pano_depth.sog");
    expect(buckets.image).toHaveLength(0);
  });

  it("still buckets explicit media_type 3d/ply records as `model`", () => {
    const buckets = recordsToAssetBuckets([
      record({ id: "w-3d", media_type: "3d", result: { ply_url: "/static/p/a.ply" } }),
    ]);
    expect(buckets.model).toHaveLength(1);
  });

  it("keeps ordinary image records in the image bucket", () => {
    const buckets = recordsToAssetBuckets([
      record({ id: "img-1", media_type: "image", result: { image_url: "/static/p/x.png" } }),
    ]);
    expect(buckets.image).toHaveLength(1);
    expect(buckets.model).toHaveLength(0);
  });

  it("carries the record's prompt onto image assets (drives the image prompt caption)", () => {
    const buckets = recordsToAssetBuckets([
      record({
        id: "img-2",
        media_type: "image",
        result: { image_url: "/static/p/y.png", prompt: "一只在雨中的猫" },
      }),
    ]);
    expect(buckets.image[0]?.prompt).toBe("一只在雨中的猫");
    expect(buckets.image[0]?.label).toBe("一只在雨中的猫");
  });

  it("falls back to the host node's cover/name when the record carries neither", () => {
    const buckets = recordsToAssetBuckets(
      [
        record({
          id: "world-2",
          node_id: "world-node",
          media_type: "3d",
          result: { ply_url: "/static/p/world.sog" },
        }),
      ],
      (nodeId) =>
        nodeId === "world-node"
          ? { cover: "/static/p/dorm.png", name: "大学宿舍" }
          : { cover: null, name: null },
    );
    expect(buckets.model).toHaveLength(1);
    expect(buckets.model[0]?.previewUrl).toContain("dorm.png");
    expect(buckets.model[0]?.label).toBe("大学宿舍");
  });

  it("prefers the record's own prompt/cover over the host-node fallback", () => {
    const buckets = recordsToAssetBuckets(
      [
        record({
          id: "world-3",
          node_id: "world-node",
          media_type: "3d",
          result: {
            ply_url: "/static/p/world.sog",
            prompt: "记录里的提示词",
            source_url: "/static/p/record-src.png",
          },
        }),
      ],
      () => ({ cover: "/static/p/dorm.png", name: "大学宿舍" }),
    );
    expect(buckets.model[0]?.label).toBe("记录里的提示词");
    expect(buckets.model[0]?.previewUrl).toContain("record-src.png");
  });
});

describe("recordsToAssetBuckets — model/genMode 记忆", () => {
  it("从带 model/gen_mode 的记录提取到 asset", () => {
    const buckets = recordsToAssetBuckets([
      record({
        media_type: "video",
        model: "happyhouse_1_0",
        gen_mode: "firstLastFrame",
        result: { output_url: "/static/p/v.mp4" },
      }),
    ]);
    const asset = Object.values(buckets)
      .flat()
      .find((a) => a.url === "/static/p/v.mp4");
    expect(asset?.model).toBe("happyhouse_1_0");
    expect(asset?.genMode).toBe("firstLastFrame");
  });

  it("旧记录无字段时得到 undefined", () => {
    const buckets = recordsToAssetBuckets([
      record({ media_type: "image", result: { output_url: "/static/p/i.png" } }),
    ]);
    const asset = Object.values(buckets)
      .flat()
      .find((a) => a.url === "/static/p/i.png");
    expect(asset?.model).toBeUndefined();
    expect(asset?.genMode).toBeUndefined();
  });
});

// issue #175：历史资产关键词搜索。
describe("assetMatchesQuery", () => {
  function asset(partial: Partial<CanvasAsset>): CanvasAsset {
    return {
      id: "a-1",
      kind: "image",
      url: "/static/p/a.png",
      previewUrl: null,
      nodeId: "node-1",
      label: null,
      prompt: null,
      timestamp: 0,
      ...partial,
    } as CanvasAsset;
  }

  it("命中提示词里的子串", () => {
    expect(assetMatchesQuery(asset({ prompt: "一只在雨中的猫" }), "雨中")).toBe(true);
    expect(assetMatchesQuery(asset({ prompt: "一只在雨中的猫" }), "狗")).toBe(false);
  });

  it("英文大小写不敏感", () => {
    expect(assetMatchesQuery(asset({ prompt: "A Fluffy Cat" }), "fluffy")).toBe(true);
    expect(assetMatchesQuery(asset({ prompt: "a fluffy cat" }), "FLUFFY")).toBe(true);
  });

  it("也匹配 label（世界记录回退成的节点名 / 取图时的文件名）", () => {
    expect(assetMatchesQuery(asset({ prompt: null, label: "大学宿舍" }), "宿舍")).toBe(
      true,
    );
  });

  it("prompt 与 label 都为空的资产（音频 / 旧记录）在有查询词时落选", () => {
    expect(assetMatchesQuery(asset({ prompt: null, label: null }), "猫")).toBe(false);
  });

  it("空查询命中一切", () => {
    expect(assetMatchesQuery(asset({ prompt: null, label: null }), "")).toBe(true);
  });

  it("不会跨 prompt/label 边界拼出假命中", () => {
    // prompt 以「猫」结尾、label 以「鱼」开头，中间是换行分隔符，不该被「猫鱼」命中。
    expect(assetMatchesQuery(asset({ prompt: "小猫", label: "鱼缸" }), "猫鱼")).toBe(
      false,
    );
  });
});

describe("filterAssetBuckets", () => {
  const buckets = recordsToAssetBuckets([
    record({
      id: "i-1",
      media_type: "image",
      result: { image_url: "/static/p/cat.png", prompt: "一只可爱的小猫" },
    }),
    record({
      id: "i-2",
      media_type: "image",
      result: { image_url: "/static/p/dog.png", prompt: "一只狗在跑" },
    }),
    record({
      id: "v-1",
      media_type: "video",
      result: { output_url: "/static/p/cat.mp4", prompt: "小猫在吃鱼" },
    }),
  ]);

  it("跨桶过滤：各 tab 的计数只留命中项", () => {
    const filtered = filterAssetBuckets(buckets, "小猫");
    expect(filtered.image.map((a) => a.id)).toEqual(["i-1"]);
    expect(filtered.video.map((a) => a.id)).toEqual(["v-1"]);
    expect(filtered.audio).toHaveLength(0);
    expect(filtered.model).toHaveLength(0);
  });

  it("无命中时四个桶都为空", () => {
    const filtered = filterAssetBuckets(buckets, "不存在的关键词");
    expect(Object.values(filtered).flat()).toHaveLength(0);
  });

  it("空查询原样返回同一对象（引用稳定，不触发下游重算）", () => {
    expect(filterAssetBuckets(buckets, "")).toBe(buckets);
  });
});
