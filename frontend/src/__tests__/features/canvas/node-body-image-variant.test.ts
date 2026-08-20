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
  nodeBodyRequiredEdge,
  readNodeNaturalSize,
} from "@/features/canvas/application/imageData";
import { pickMediaVariant } from "@/lib/media-url";

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
      maxEdge: 1280,
    });
  });

  // 这一次加载还担着「测量」的职责：从降采样副本上读 naturalWidth 会把错的尺寸
  // 写进节点数据。尺寸未知时必须原图，测量落库后下次挂载自然就用上变体。
  it("stays on the original while the real size is still unknown", () => {
    expect(nodeBodyImageSrc(URL, null)).toEqual({
      src: URL,
      original: URL,
      downscaled: false,
      maxEdge: null,
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
        maxEdge: null,
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
      maxEdge: null,
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
      expect(result).toEqual({ src: url, original: url, downscaled: false, maxEdge: null });
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
  const downscaled = { src: "x", original: "x", downscaled: true, maxEdge: 1280 };

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

  // 盲区,记在这里以免下次有人以为它管得住换图:副本的长边被钉死在预算上,原图
  // 有多大这个信息在降采样时就丢了,所以同比例的另一张图看起来完全合规。真正堵
  // 住这一幕的是换图当下就不信任记录(useNaturalSizeRecordTrust),这里只兜底管
  // 挂载时就已经存歪了的旧数据。
  it("同比例换图看不出来:2752x1536 的副本与 5504x3072 的逐像素相同", () => {
    expect(
      nodeBodyImageMeasurement({ naturalWidth: 1280, naturalHeight: 714 }, downscaled, RECORD),
    ).toEqual(RECORD);
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
      nodeBodyImageMeasurement(element, { src: "x", original: "x", downscaled: true, maxEdge: 1280 }, BIG),
    ).toEqual(BIG);
  });

  it("measures from the element when it holds the original", () => {
    expect(
      nodeBodyImageMeasurement(element, { src: "x", original: "x", downscaled: false, maxEdge: null }, BIG),
    ).toEqual({ width: 1280, height: 714 });
  });

  // downscaled 只可能在有记录时为 true，但真到了这里也不能返回一个空尺寸。
  it("falls back to the element when there is no record to trust", () => {
    expect(
      nodeBodyImageMeasurement(element, { src: "x", original: "x", downscaled: true, maxEdge: 1280 }, null),
    ).toEqual({ width: 1280, height: 714 });
  });
});

// 固定档位挡不住这一幕：同一张 1280px 副本，画进 580 CSS px 的默认节点里绰绰有余，
// 画进用户拉到 1600px 的节点里就是放大糊；Retina 上这两个数还要各乘 2。所以档位
// 必须从「这一格要多少设备像素」倒推。
describe("按显示尺寸 x zoom x DPR 挑档", () => {
  it("nodeBodyRequiredEdge 三个因子都算进去，取长边", () => {
    expect(nodeBodyRequiredEdge({ width: 580, height: 326 }, 1, 1)).toBe(580);
    expect(nodeBodyRequiredEdge({ width: 580, height: 326 }, 1, 2)).toBe(1160);
    expect(nodeBodyRequiredEdge({ width: 900, height: 900 }, 0.35, 2)).toBe(630);
    expect(nodeBodyRequiredEdge({ width: 326, height: 580 }, 1, 1)).toBe(580);
  });

  it("坏值退回 1 倍，不至于挑出个荒唐档位", () => {
    expect(nodeBodyRequiredEdge({ width: 580, height: 326 }, Number.NaN, 0)).toBe(580);
  });

  it("pickMediaVariant 取阶梯上最便宜的那一档", () => {
    expect(pickMediaVariant(315)).toBe("thumb");
    expect(pickMediaVariant(320)).toBe("thumb");
    expect(pickMediaVariant(321)).toBe("thumb2x");
    expect(pickMediaVariant(630)).toBe("thumb2x");
    expect(pickMediaVariant(1160)).toBe("card");
    expect(pickMediaVariant(1280)).toBe("card");
  });

  // 放大糊是唯一不能接受的结果：宁可付原图的解码，也不给一张要放大 2.5 倍的副本。
  it("一档都盖不住时回原图", () => {
    expect(pickMediaVariant(1281)).toBeNull();
    expect(pickMediaVariant(Number.POSITIVE_INFINITY)).toBeNull();
  });

  // 评审给的那个例子：ImageNode 可以拉到 1600px，DPR=1 / zoom=1 也已经不够。
  it("拉大的节点拿原图，而不是被放大的 1280 副本", () => {
    const required = nodeBodyRequiredEdge({ width: 1600, height: 900 }, 1, 1);
    expect(nodeBodyImageSrc(URL, BIG, { requiredEdge: required })).toEqual({
      src: URL,
      original: URL,
      downscaled: false,
      maxEdge: null,
    });
  });

  it("默认尺寸的节点在 Retina 上仍然吃到 card", () => {
    const required = nodeBodyRequiredEdge({ width: 580, height: 326 }, 1, 2);
    expect(nodeBodyImageSrc(URL, BIG, { requiredEdge: required }).src).toBe(
      `${URL}?st_thumb=card`,
    );
  });

  // LOD 最宽的那一档：1x 屏落在 320，2x 屏落到 640——改前两者都是 320，Retina 上
  // 只有需要的一半分辨率。
  it("LOD 外壳按 DPR 分档", () => {
    const shell = { width: 900, height: 900 };
    expect(pickMediaVariant(nodeBodyRequiredEdge(shell, 0.35, 1))).toBe("thumb");
    expect(pickMediaVariant(nodeBodyRequiredEdge(shell, 0.35, 2))).toBe("thumb2x");
  });

  it("挑到的那一档不比源图小时仍然回原图", () => {
    expect(
      nodeBodyImageSrc(URL, { width: 600, height: 400 }, { requiredEdge: 630 }).downscaled,
    ).toBe(false);
  });

  it("不传 requiredEdge 时维持原来的 card 预算", () => {
    expect(nodeBodyImageSrc(URL, BIG).maxEdge).toBe(NODE_BODY_VARIANT_MAX_EDGE);
  });
});
