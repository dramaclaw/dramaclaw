// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LiexiaorenEntryOverlay } from "@/features/liexiaoren/LiexiaorenEntryOverlay";

describe("LiexiaorenEntryOverlay", () => {
  it("shows an explicit Escape hint and lets the user skip with Escape", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<LiexiaorenEntryOverlay onClose={onClose} />);

    expect(screen.getByRole("button", { name: "取消入场动画" })).toHaveTextContent(
      "ESC取消动画",
    );

    fireEvent.keyDown(window, { key: "Escape" });
    vi.advanceTimersByTime(420);

    expect(onClose).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
