// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 画面裁切在途状态的模块级登记表：VideoNode 卸载重挂、工具栏切模式都要读到
// 同一份事实，不能各自开一份 state 互相看不见。
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  cancelVideoCrop,
  clearVideoCropInFlight,
  isVideoCropInFlight,
  markVideoCropInFlight,
  useVideoCropInFlight,
} from "@/features/canvas/application/videoCrop/videoCropInFlight";

describe("videoCropInFlight", () => {
  it("marks, reports and clears a node id", () => {
    const nodeId = "v-mark-clear";
    expect(isVideoCropInFlight(nodeId)).toBe(false);

    markVideoCropInFlight(nodeId);
    expect(isVideoCropInFlight(nodeId)).toBe(true);

    clearVideoCropInFlight(nodeId);
    expect(isVideoCropInFlight(nodeId)).toBe(false);
  });

  it("re-renders the hook when the node's in-flight state changes", () => {
    const nodeId = "v-hook-rerender";
    const { result } = renderHook(() => useVideoCropInFlight(nodeId));
    expect(result.current).toBe(false);

    act(() => {
      markVideoCropInFlight(nodeId);
    });
    expect(result.current).toBe(true);

    act(() => {
      clearVideoCropInFlight(nodeId);
    });
    expect(result.current).toBe(false);
  });

  it("keeps two node ids independent", () => {
    const nodeA = "v-a";
    const nodeB = "v-b";

    markVideoCropInFlight(nodeA);
    expect(isVideoCropInFlight(nodeA)).toBe(true);
    expect(isVideoCropInFlight(nodeB)).toBe(false);

    clearVideoCropInFlight(nodeA);
    expect(isVideoCropInFlight(nodeA)).toBe(false);
    expect(isVideoCropInFlight(nodeB)).toBe(false);
  });

  it("returns a not-yet-aborted signal when marking", () => {
    const nodeId = "v-signal";
    const signal = markVideoCropInFlight(nodeId);
    expect(signal?.aborted).toBe(false);
    clearVideoCropInFlight(nodeId);
  });

  it("cancelVideoCrop aborts the signal but leaves the in-flight state to submit's cleanup", () => {
    const nodeId = "v-cancel";
    const signal = markVideoCropInFlight(nodeId);

    cancelVideoCrop(nodeId);

    expect(signal?.aborted).toBe(true);
    // 取消只是发信号，真正清登记表是提交流程的 finally，不然还没跑到 finally
    // 之前又点一次提交会看不出「已经在裁」。
    expect(isVideoCropInFlight(nodeId)).toBe(true);

    clearVideoCropInFlight(nodeId);
    expect(isVideoCropInFlight(nodeId)).toBe(false);
  });

  it("returns null instead of the existing signal when marking a node twice", () => {
    // 双重注册以前会把已有 signal 递回去，调用方误以为自己拿到了这次提交的
    // 控制权，跟第一个注册者抢同一个 finally 清表——见文件头注释。
    const nodeId = "v-double-mark";
    const first = markVideoCropInFlight(nodeId);
    expect(first).not.toBeNull();

    const second = markVideoCropInFlight(nodeId);
    expect(second).toBeNull();
    // 第二次失败的注册不能顶掉第一次的登记。
    expect(isVideoCropInFlight(nodeId)).toBe(true);
    expect(first?.aborted).toBe(false);

    clearVideoCropInFlight(nodeId);
  });

  it("is a no-op to cancel after the node has already been cleared", () => {
    const nodeId = "v-cancel-after-clear";
    markVideoCropInFlight(nodeId);
    clearVideoCropInFlight(nodeId);

    expect(() => cancelVideoCrop(nodeId)).not.toThrow();
    expect(isVideoCropInFlight(nodeId)).toBe(false);
  });

  it("is a no-op to cancel a node id that was never marked", () => {
    expect(() => cancelVideoCrop("v-never-marked")).not.toThrow();
    expect(isVideoCropInFlight("v-never-marked")).toBe(false);
  });

  it("keeps abort signals independent per node id", () => {
    const nodeA = "v-signal-a";
    const nodeB = "v-signal-b";
    const signalA = markVideoCropInFlight(nodeA);
    const signalB = markVideoCropInFlight(nodeB);

    cancelVideoCrop(nodeA);

    expect(signalA?.aborted).toBe(true);
    expect(signalB?.aborted).toBe(false);

    clearVideoCropInFlight(nodeA);
    clearVideoCropInFlight(nodeB);
  });
});
