// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// 节点主体图什么时候可以喂降采样副本。规则本身很短，但它护着两件容易一起坏掉的
// 事：分辨率角标 / 自动尺寸读到的必须是原图尺寸，全屏查看器拿到的必须是原图。
import { beforeEach, describe, expect, it } from "vitest";

import {
  NODE_BODY_VARIANT_MAX_EDGE,
  nodeBodyImageMeasurement,
  nodeBodyImageSrc,
  readNodeNaturalSize,
} from "@/features/canvas/application/imageData";

const BIG = { width: 5504, height: 3072 };
const URL = "/static/projects/proj/freezone/_outputs/a.png";

describe("readNodeNaturalSize", () => {
  it("reads a recorded pixel size off node data", () => {
    expect(readNodeNaturalSize({ imageNaturalWidth: 5504, imageNaturalHeight: 3072 })).toEqual(BIG);
  });

  it("returns null when the record is missing, partial or nonsense", () => {
    for (const data of [
      null,
      undefined,
      7,
      "nope",
      {},
      { imageNaturalWidth: 5504 },
      { imageNaturalHeight: 3072 },
      { imageNaturalWidth: 0, imageNaturalHeight: 3072 },
      { imageNaturalWidth: -1, imageNaturalHeight: -1 },
      { imageNaturalWidth: "5504", imageNaturalHeight: "3072" },
    ]) {
      expect(readNodeNaturalSize(data)).toBeNull();
    }
  });
});

describe("nodeBodyImageSrc", () => {
  beforeEach(() => {
    window.history.pushState(null, "", "/");
  });

  it("asks for the card variant once the source's real size is known", () => {
    expect(nodeBodyImageSrc(URL, BIG)).toEqual({
      src: `${URL}?st_thumb=card`,
      original: URL,
      downscaled: true,
    });
  });

  // 这一次加载还担着「测量」的职责：从降采样副本上读 naturalWidth 会把错的尺寸
  // 写进节点数据。尺寸未知时必须原图，测量落库后下次挂载自然就用上变体。
  it("stays on the original while the real size is still unknown", () => {
    expect(nodeBodyImageSrc(URL, null)).toEqual({
      src: URL,
      original: URL,
      downscaled: false,
    });
  });

  it("stays on the original when the source is not bigger than the variant", () => {
    const edge = NODE_BODY_VARIANT_MAX_EDGE;
    for (const natural of [
      { width: edge, height: edge },
      { width: edge, height: 100 },
      { width: 100, height: edge },
      { width: 640, height: 480 },
    ]) {
      expect(nodeBodyImageSrc(URL, natural)).toEqual({
        src: URL,
        original: URL,
        downscaled: false,
      });
    }
    expect(nodeBodyImageSrc(URL, { width: edge + 1, height: 100 }).downscaled).toBe(true);
  });

  // 放大到细看这一档时节点比变体还宽；这条线与 previewImageUrl/imageUrl 的切换
  // 线（shouldUseOriginalImageByZoom）是同一条。
  it("hands back the original when the caller is zoomed in for detail", () => {
    expect(nodeBodyImageSrc(URL, BIG, { preferOriginal: true })).toEqual({
      src: URL,
      original: URL,
      downscaled: false,
    });
  });

  it("keeps an existing cache-bust token", () => {
    expect(nodeBodyImageSrc(`${URL}?st_v=17`, BIG).src).toBe(`${URL}?st_v=17&st_thumb=card`);
  });

  it("reports downscaled:false whenever the variant cannot apply", () => {
    for (const url of [
      "blob:http://localhost/abcd",
      "data:image/png;base64,AAAA",
      "/static/style-examples/demo.png",
      "/static/projects/proj/videos/clip.mp4",
    ]) {
      const result = nodeBodyImageSrc(url, BIG);
      expect(result).toEqual({ src: url, original: url, downscaled: false });
    }
  });
});

// 记录里的尺寸没有和任何 URL 绑定,而节点的图是会被换掉的(画册选主图、从历史
// 恢复、生成完成回填),换的时候没人清 imageNaturalWidth/Height。这时候如果还
// 无条件信任记录,测量就被永久毒化:元素报的是新图的真实尺寸,我们却按旧记录
// 写回去,而写回去的比例又恰好等于 data.aspectRatio,更新分支被跳过,永远不会
// 自愈。改动前元素自己就是真相来源,这一幕根本不存在。
describe("nodeBodyImageMeasurement 对不上记录时不能信记录", () => {
  const RECORD = { width: 5504, height: 3072 };
  const downscaled = { src: "x", original: "x", downscaled: true };

  it("忠实降采样的副本:长边正好卡在预算上,按记录测量", () => {
    // 5504x3072 -> card(1280) = 1280x714
    expect(nodeBodyImageMeasurement({ naturalWidth: 1280, naturalHeight: 714 }, downscaled, RECORD))
      .toEqual(RECORD);
  });

  it("换成了一张更小的方图:元素只有 1024,记录不可能描述它", () => {
    expect(
      nodeBodyImageMeasurement({ naturalWidth: 1024, naturalHeight: 1024 }, downscaled, RECORD),
    ).toEqual({ width: 1024, height: 1024 });
  });

  it("换成了一张同样大但比例不同的图:长边对得上,短边对不上", () => {
    // 2000x2000 -> card = 1280x1280,而按记录的比例短边应当是 714。
    expect(
      nodeBodyImageMeasurement({ naturalWidth: 1280, naturalHeight: 1280 }, downscaled, RECORD),
    ).toEqual({ width: 1280, height: 1280 });
  });

  it("横竖颠倒:方向就对不上", () => {
    expect(
      nodeBodyImageMeasurement({ naturalWidth: 714, naturalHeight: 1280 }, downscaled, RECORD),
    ).toEqual({ width: 714, height: 1280 });
  });

  it("后端拒绝了这次降采样、直接给了原图:元素与记录逐像素相同,仍然算对得上", () => {
    expect(
      nodeBodyImageMeasurement({ naturalWidth: 5504, naturalHeight: 3072 }, downscaled, RECORD),
    ).toEqual(RECORD);
  });
});

describe("nodeBodyImageMeasurement", () => {
  // 5504x3072 忠实降采样到 card(1280) 就是 1280x714,与 BIG 对得上。
  const element = { naturalWidth: 1280, naturalHeight: 714 };

  // 关键不是「跳过测量」，而是换一个测量来源：后续的比例/尺寸/角标计算与喂原图
  // 时逐字节一致。
  it("measures from the record when the element holds a downscaled copy", () => {
    expect(
      nodeBodyImageMeasurement(element, { src: "x", original: "x", downscaled: true }, BIG),
    ).toEqual(BIG);
  });

  it("measures from the element when it holds the original", () => {
    expect(
      nodeBodyImageMeasurement(element, { src: "x", original: "x", downscaled: false }, BIG),
    ).toEqual({ width: 1280, height: 714 });
  });

  // downscaled 只可能在有记录时为 true，但真到了这里也不能返回一个空尺寸。
  it("falls back to the element when there is no record to trust", () => {
    expect(
      nodeBodyImageMeasurement(element, { src: "x", original: "x", downscaled: true }, null),
    ).toEqual({ width: 1280, height: 714 });
  });
});
