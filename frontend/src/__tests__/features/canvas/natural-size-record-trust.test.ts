// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// imageNaturalWidth/Height 这组记录什么时候不能信。它撑着两件事：主体图敢不敢喂
// 降采样副本，以及 onLoad 拿什么当真尺寸写回节点数据。信错了不是画面糊一点，是
// 把一组属于别的图的数字落库，角标和自动尺寸一起错，而且会一直错下去。
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useNaturalSizeRecordTrust } from "@/features/canvas/hooks/useNaturalSizeRecordTrust";

const A = "/static/projects/p/a.png";
const B = "/static/projects/p/b.png";

describe("useNaturalSizeRecordTrust", () => {
  it("挂载时先信记录：持久化下来的数据没有「上一张」可比", () => {
    const { result } = renderHook(() => useNaturalSizeRecordTrust(A));
    expect(result.current.distrusted).toBe(false);
  });

  // 这条就是同比例换图那一幕。副本认不出它：5504x3072 和 2752x1536 的 card 副本
  // 都是 1280x714，nodeBodyRecordDescribesImage 一路放行。所以判据只能是换图本身。
  it("换了图就当场不信任，哪怕新图和旧图比例完全一样", () => {
    const { result, rerender } = renderHook(
      ({ subject }) => useNaturalSizeRecordTrust(subject),
      { initialProps: { subject: A } },
    );
    expect(result.current.distrusted).toBe(false);

    rerender({ subject: B });

    expect(result.current.distrusted).toBe(true);
  });

  // 不解除的话，这个节点从此永远喂原图——正好把这次改动的收益整个还回去。
  it("量到真尺寸之后解除，重新用回副本", () => {
    const { result, rerender } = renderHook(
      ({ subject }) => useNaturalSizeRecordTrust(subject),
      { initialProps: { subject: A } },
    );
    rerender({ subject: B });
    expect(result.current.distrusted).toBe(true);

    act(() => result.current.trustAgain());

    expect(result.current.distrusted).toBe(false);
  });

  // 退回原图也未必能落库（手动调过尺寸的节点在 onLoad 里提前 return）。那时记录
  // 仍然对不上，副本会再喊一次不信任——没有这道闸就是 副本→原图→副本 的死循环。
  it("同一张图只退一次，纠正没落库也不会来回抖", () => {
    const { result } = renderHook(() => useNaturalSizeRecordTrust(A));

    act(() => result.current.distrustRecord());
    expect(result.current.distrusted).toBe(true);
    act(() => result.current.trustAgain());
    act(() => result.current.distrustRecord());

    expect(result.current.distrusted).toBe(false);
  });

  it("闸是按图记的，不是按节点：换到下一张图还能再退一次", () => {
    const { result, rerender } = renderHook(
      ({ subject }) => useNaturalSizeRecordTrust(subject),
      { initialProps: { subject: A } },
    );
    act(() => result.current.distrustRecord());
    act(() => result.current.trustAgain());

    rerender({ subject: B });

    expect(result.current.distrusted).toBe(true);
  });

  it("没有图时无从不信任", () => {
    const { result } = renderHook(() => useNaturalSizeRecordTrust(null));
    act(() => result.current.distrustRecord());
    expect(result.current.distrusted).toBe(false);
  });

  // 生成流程真正走的是这条路：ImageGenNode 在 isGenerating 期间把主体图置空
  // （visiblePreviewUrl = null），于是 subject 序列是 旧图 → null → 新结果。把
  // null 也当成「上一张」的话，新结果到来时看到的 previous 就是 null，会被当成
  // 首次挂载而白白信任旧记录——偏偏这一刻最需要失信：同一个节点重出图，新旧结果
  // 通常同一目标宽高比，副本检查也认不出来。
  it("生成中把图暂时藏起来，不影响回来时认出这是换了图", () => {
    const { result, rerender } = renderHook(
      ({ subject }: { subject: string | null }) => useNaturalSizeRecordTrust(subject),
      { initialProps: { subject: A as string | null } },
    );
    expect(result.current.distrusted).toBe(false);

    rerender({ subject: null });
    rerender({ subject: B });

    expect(result.current.distrusted).toBe(true);
  });

  // 反过来也要成立：生成失败/取消后原样把旧图放回来，什么都没换，不该退回原图
  // 白跑一趟测量。
  it("藏起来又原样放回同一张图，不算换图", () => {
    const { result, rerender } = renderHook(
      ({ subject }: { subject: string | null }) => useNaturalSizeRecordTrust(subject),
      { initialProps: { subject: A as string | null } },
    );

    rerender({ subject: null });
    rerender({ subject: A });

    expect(result.current.distrusted).toBe(false);
  });
});
