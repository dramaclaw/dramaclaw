// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginRouteSwitch,
  endRouteSwitch,
} from "@/lib/route-switch-transition";

/**
 * 这个模块的全部价值就在于「遮罩先上屏、跳转后发生」这个顺序 —— 少等一帧，
 * 跳转的同步长任务就会把遮罩连同新页面一起吞进同一次 commit，用户看到的还是
 * 卡一下再换页。所以测的是帧序，不是渲染结果。
 */
describe("beginRouteSwitch", () => {
  let frames: Array<() => void>;

  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames[id - 1] = () => {};
    });
  });

  afterEach(() => {
    // phase 是模块级的。endRouteSwitch 只收 navigating，所以先把可能停在 armed
    // 的状态推完两帧，别把残留漏给下一个用例。
    flushFrame();
    flushFrame();
    endRouteSwitch();
    vi.unstubAllGlobals();
  });

  const flushFrame = () => {
    const pending = frames.splice(0, frames.length);
    pending.forEach((cb) => cb());
  };

  it("延后到第二帧才跳转", () => {
    const navigate = vi.fn();
    beginRouteSwitch(navigate);

    expect(navigate).not.toHaveBeenCalled();
    flushFrame();
    // 第一帧的回调还跑在这一帧绘制之前，遮罩没上屏，不能跳。
    expect(navigate).not.toHaveBeenCalled();
    flushFrame();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("连点两次只跳最后一次", () => {
    const first = vi.fn();
    const second = vi.fn();
    beginRouteSwitch(first);
    flushFrame();
    beginRouteSwitch(second);
    flushFrame();
    flushFrame();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("上一次跳转落地时，不吞掉刚点下、还没发车的那一次", () => {
    // 路由落地会调 endRouteSwitch。用户在上一页落地前的那两帧里点了第二个菜单，
    // 这一下必须照样发出去，否则他停在上一页且完全没有反馈。
    const navigate = vi.fn();
    beginRouteSwitch(navigate);
    flushFrame();
    endRouteSwitch();
    flushFrame();

    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("没有 rAF 时直接跳转，不把界面卡在遮罩里", () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    const navigate = vi.fn();
    beginRouteSwitch(navigate);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});
