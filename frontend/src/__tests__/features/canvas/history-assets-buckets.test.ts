// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { recordsToAssetBuckets } from "@/features/canvas/ui/CanvasHistoryAssetsModal";
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
