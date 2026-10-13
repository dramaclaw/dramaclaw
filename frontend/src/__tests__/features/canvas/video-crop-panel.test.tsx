// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { VideoCropPanel } from "@/features/canvas/nodes/VideoCropPanel";

function renderPanel(overrides: Partial<Parameters<typeof VideoCropPanel>[0]> = {}) {
  const onRatioChange = vi.fn();
  const onCancel = vi.fn();
  const onSubmit = vi.fn();
  const onAbort = vi.fn();
  render(
    <VideoCropPanel
      ratioId="free"
      width={576}
      height={1024}
      isSubmitting={false}
      canSubmit
      onRatioChange={onRatioChange}
      onCancel={onCancel}
      onSubmit={onSubmit}
      onAbort={onAbort}
      {...overrides}
    />,
  );
  return { onRatioChange, onCancel, onSubmit, onAbort };
}

describe("VideoCropPanel", () => {
  it("lists the ratio presets and reports the picked one", () => {
    const { onRatioChange } = renderPanel();
    for (const name of ["自由", "原始", "1:1", "9:16", "16:9", "4:3", "3:4"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "自由" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "1:1" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(screen.getByRole("button", { name: "1:1" }));
    expect(onRatioChange).toHaveBeenCalledWith("1:1");
  });

  it("shows the crop size", () => {
    renderPanel();
    expect(screen.getByText("576 × 1024")).toBeInTheDocument();
  });

  it("wires cancel and submit", () => {
    const { onCancel, onSubmit } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "退出裁剪" }));
    fireEvent.click(screen.getByRole("button", { name: "生成裁剪" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("locks ratio and submit while submitting, but keeps the X enabled to abort", () => {
    const { onAbort, onCancel } = renderPanel({ isSubmitting: true });
    expect(screen.getByRole("button", { name: "生成裁剪" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "1:1" })).toBeDisabled();
    expect(screen.getByTestId("video-crop-submitting")).toBeInTheDocument();

    // 提交中 X 不再是「退出裁剪」，换成「取消裁剪」，且必须仍然可点。
    const abortButton = screen.getByRole("button", { name: "取消裁剪" });
    expect(abortButton).not.toBeDisabled();
    fireEvent.click(abortButton);
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("disables submit until there is a crop box", () => {
    renderPanel({ canSubmit: false, width: 0, height: 0 });
    expect(screen.getByRole("button", { name: "生成裁剪" })).toBeDisabled();
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
