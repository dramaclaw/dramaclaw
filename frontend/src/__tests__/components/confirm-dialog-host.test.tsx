// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { ConfirmDialogHost, confirmDialog } from "@/components/confirm-dialog-host";

describe("ConfirmDialogHost", () => {
  it("resolves true when the user confirms", async () => {
    const user = userEvent.setup();
    render(<ConfirmDialogHost />);

    const pending = confirmDialog({
      title: "终止任务",
      description: "终止不会退还积分",
      confirmText: "确认终止",
      cancelText: "继续执行",
    });

    await user.click(await screen.findByRole("button", { name: "确认终止" }));

    await expect(pending).resolves.toBe(true);
  });

  it("resolves false when the user cancels", async () => {
    const user = userEvent.setup();
    render(<ConfirmDialogHost />);

    const pending = confirmDialog({ description: "终止不会退还积分" });

    expect(await screen.findByText("终止不会退还积分")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "common.cancel" }));

    await expect(pending).resolves.toBe(false);
  });

  it("supersedes an unanswered request by resolving it as declined", async () => {
    render(<ConfirmDialogHost />);

    const first = confirmDialog({ description: "第一个请求" });
    const second = confirmDialog({ description: "第二个请求" });

    await expect(first).resolves.toBe(false);
    await waitFor(() =>
      expect(screen.getByText("第二个请求")).toBeInTheDocument(),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "common.confirm" }));
    await expect(second).resolves.toBe(true);
  });

  // 回归位：确认框曾经停在 shadcn 原版的 z-50，而素材库弹窗是 z-[300]、画布书签菜单
  // 是 z-[10010]。结果是从素材库里点「删除」，确认框弹在弹窗背后——删不掉也退不出。
  // jsdom 量不了层叠顺序（Tailwind 的类没编译成 CSS），所以这里直接把类名里的 z 值
  // 抠出来跟已知最高层比大小；换算法可以，压不住整个浮层栈不行。
  it("renders above the canvas overlay stack so in-modal confirms stay reachable", async () => {
    const HIGHEST_OVERLAY_Z = 10010; // CanvasBookmarkContextMenu，全仓最高的一层

    render(<ConfirmDialogHost />);
    void confirmDialog({ description: "确定要删除「封面」？" });

    await screen.findByText("确定要删除「封面」？");

    for (const slot of ["alert-dialog-overlay", "alert-dialog-content"]) {
      const el = document.querySelector(`[data-slot="${slot}"]`);
      expect(el, `${slot} 没渲染出来`).not.toBeNull();
      const match = /z-\[(\d+)\]/.exec(el!.className);
      expect(match, `${slot} 身上没有 z-[N]，很可能被改回了 z-50`).not.toBeNull();
      expect(Number(match![1])).toBeGreaterThan(HIGHEST_OVERLAY_Z);
    }
  });
});
