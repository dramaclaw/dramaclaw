// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// onLoad 量到真尺寸之后要不要落库。这件事有两个坑，都不在「比例变了」这条明路上：
//
// 1. 记录本来就是空的。老项目里的节点比例早算对了、尺寸也早贴合了，比例和显示尺寸
//    两个条件永远为 false，于是 imageNaturalWidth/Height 一辈子写不进去；而
//    nodeBodyImageSrc 没有记录只能喂原图，这个节点从此享受不到降采样副本——整个
//    改动对存量项目静默失效。
// 2. 补记这类写入不是用户的改动。真进撤销栈，打开一个老项目就堆进几十条「忘掉一张
//    图的尺寸」，还会把重做栈清空。
import { describe, expect, it } from "vitest";

import { planNaturalSizeRecordWrite } from "@/features/canvas/application/imageData";
import { useCanvasStore } from "@/stores/canvasStore";

const MEASURED = { width: 5504, height: 3072 };
const SETTLED = {
  aspectRatioChanged: false,
  displaySizeMismatch: false,
  measured: MEASURED,
  measuringRecordSubject: true,
  sizeLockedByUser: false,
};

describe("planNaturalSizeRecordWrite", () => {
  it("记录空着就得补上，哪怕比例和显示尺寸都已经贴合", () => {
    expect(planNaturalSizeRecordWrite({ ...SETTLED, record: null })).toEqual({
      persist: true,
      recordHistory: false,
      applySize: false,
    });
  });

  // 同比例换图：5504x3072 -> 2752x1536，比例和显示尺寸都不动。
  it("记录和刚量到的真相对不上也得写回去", () => {
    expect(
      planNaturalSizeRecordWrite({ ...SETTLED, record: { width: 2752, height: 1536 } }),
    ).toEqual({ persist: true, recordHistory: false, applySize: false });
  });

  it("补记和纠正都不进撤销栈，它们不改变屏幕上的任何一个像素", () => {
    expect(planNaturalSizeRecordWrite({ ...SETTLED, record: null }).recordHistory).toBe(false);
    expect(
      planNaturalSizeRecordWrite({ ...SETTLED, record: { width: 1, height: 1 } }).recordHistory,
    ).toBe(false);
  });

  it("比例或显示尺寸变了是用户看得见的改动，进撤销栈", () => {
    expect(
      planNaturalSizeRecordWrite({ ...SETTLED, record: MEASURED, aspectRatioChanged: true }),
    ).toEqual({ persist: true, recordHistory: true, applySize: true });
    expect(
      planNaturalSizeRecordWrite({ ...SETTLED, record: MEASURED, displaySizeMismatch: true }),
    ).toEqual({ persist: true, recordHistory: true, applySize: true });
  });

  // 写完就收敛：同一份输入第二次算出来不再写，不会每次 onLoad 都更新一遍节点数据。
  it("记录已经是真相时什么都不写", () => {
    expect(planNaturalSizeRecordWrite({ ...SETTLED, record: MEASURED })).toEqual({
      persist: false,
      recordHistory: false,
      applySize: false,
    });
  });

  // ImageNode 放大到 1.45 以上喂的是 imageUrl，那可能是完全另一张图（旋转、补光、
  // 多视角的结果都写在 previewImageUrl 里）。拿它去补记录是把空的换成错的。
  it("量的不是记录该描述的那张图时，连补记都不做", () => {
    expect(
      planNaturalSizeRecordWrite({ ...SETTLED, record: null, measuringRecordSubject: false }),
    ).toEqual({ persist: false, recordHistory: false, applySize: false });
  });

  // 用户拖过尺寸的节点（isSizeManuallyAdjusted）。onLoad 原本在这里直接 return，于是
  // 换图之后真实尺寸永远写不回去：角标当次靠组件局部 state 还是对的，重新挂载读到的
  // 却是旧记录；同比例换图时降采样副本那层校验也认不出来，于是继续按旧尺寸挑变体。
  // 保住用户拖出来的显示尺寸，和把真实像素尺寸记对，是两件互不相干的事。
  describe("用户拖定过尺寸的节点", () => {
    const LOCKED = { ...SETTLED, sizeLockedByUser: true };

    it("不碰它的显示尺寸，但记录该补还是要补", () => {
      expect(planNaturalSizeRecordWrite({ ...LOCKED, record: null })).toEqual({
        persist: true,
        recordHistory: false,
        applySize: false,
      });
    });

    it("比例变了也只纠正记录，尺寸不动，也不进撤销栈", () => {
      expect(
        planNaturalSizeRecordWrite({
          ...LOCKED,
          record: { width: 2752, height: 1536 },
          aspectRatioChanged: true,
          displaySizeMismatch: true,
        }),
      ).toEqual({ persist: true, recordHistory: false, applySize: false });
    });

    it("记录已经是真相时什么都不写", () => {
      expect(planNaturalSizeRecordWrite({ ...LOCKED, record: MEASURED })).toEqual({
        persist: false,
        recordHistory: false,
        applySize: false,
      });
    });

    it("量的不是记录该描述的那张图时，连补记都不做", () => {
      expect(
        planNaturalSizeRecordWrite({ ...LOCKED, record: null, measuringRecordSubject: false }),
      ).toEqual({ persist: false, recordHistory: false, applySize: false });
    });
  });
});

describe("updateNodeSize 的 recordHistory", () => {
  const seed = (nodeId: string) => {
    useCanvasStore.setState({
      nodes: [
        {
          id: nodeId,
          type: "imageNode",
          position: { x: 0, y: 0 },
          width: 580,
          height: 326,
          data: { label: "image" },
        },
      ] as never,
      edges: [],
      history: { past: [], future: [] },
    } as never);
  };

  it("补记事实不进撤销栈，也不清空重做栈", () => {
    seed("n1");
    const future = useCanvasStore.getState().history.future;

    useCanvasStore.getState().updateNodeSize(
      "n1",
      { width: 580, height: 326 },
      { recordHistory: false, data: { imageNaturalWidth: 5504, imageNaturalHeight: 3072 } as never },
    );

    const after = useCanvasStore.getState();
    expect(after.history.past.length).toBe(0);
    expect(after.history.future).toBe(future);
    expect(after.nodes[0].data.imageNaturalWidth).toBe(5504);
  });

  it("默认仍然进撤销栈", () => {
    seed("n2");

    useCanvasStore.getState().updateNodeSize("n2", { width: 321, height: 123 });

    expect(useCanvasStore.getState().history.past.length).toBe(1);
  });
});
