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
});
