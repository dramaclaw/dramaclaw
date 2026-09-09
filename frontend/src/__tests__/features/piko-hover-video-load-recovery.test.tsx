// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PikoInspirationStation } from "@/features/piko-mini-game/PikoInspirationStation";

// jsdom 没实现 HTMLMediaElement 的加载/播放，直接调会抛 "Not implemented"。
const loadSpy = vi.fn();

beforeEach(() => {
  loadSpy.mockClear();
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(loadSpy);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderLibrary() {
  const { container } = render(<PikoInspirationStation open onClose={() => {}} />);
  const video = container.querySelector("video");
  expect(video).not.toBeNull();
  const card = video!.closest("button");
  expect(card).not.toBeNull();
  return { card: card!, video: video! };
}

describe("piko hover 视频加载失败后的恢复", () => {
  it("load() 失败后再次 hover 应重新加载，而不是永久跳过", () => {
    const { card, video } = renderLibrary();

    fireEvent.pointerEnter(card);
    expect(loadSpy).toHaveBeenCalledTimes(1);

    // 瞬时网络错误：这次加载已经终止，守卫必须放行下一次 hover，
    // 否则这张卡只能靠关弹窗重新挂载才能恢复。
    fireEvent.pointerLeave(card);
    fireEvent.error(video);

    fireEvent.pointerEnter(card);
    expect(loadSpy).toHaveBeenCalledTimes(2);
  });

  it("加载失败后装回封面，不留黑图", () => {
    const { card, video } = renderLibrary();
    const poster = video.getAttribute("poster");
    expect(poster).toBeTruthy();

    fireEvent.pointerEnter(card);
    // 首帧就绪会摘掉 poster；这里模拟它已经摘过、随后播放中断的情形。
    video.removeAttribute("poster");
    fireEvent.error(video);

    expect(video.getAttribute("poster")).toBe(poster);
  });

  it("加载进行中重复 hover 不得打断，仍然只 load 一次", () => {
    const { card } = renderLibrary();

    fireEvent.pointerEnter(card);
    fireEvent.pointerLeave(card);
    fireEvent.pointerEnter(card);
    fireEvent.pointerLeave(card);
    fireEvent.pointerEnter(card);

    expect(loadSpy).toHaveBeenCalledTimes(1);
  });
});
