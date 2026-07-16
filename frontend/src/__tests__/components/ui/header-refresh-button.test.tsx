// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toastError = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => (key === "common.refreshDone" ? "Done" : "Error"),
  }),
}));

vi.mock("sonner", () => ({ toast: { error: toastError } }));

import { HeaderRefreshButton } from "@/components/ui/header-refresh-button";

describe("HeaderRefreshButton", () => {
  beforeEach(() => {
    toastError.mockClear();
  });

  it("shows an inline confirmation after a successful refresh", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn().mockResolvedValue(true);
    render(
      <HeaderRefreshButton
        label="Refresh"
        onRefresh={onRefresh}
        refreshing={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(onRefresh).toHaveBeenCalledOnce();
    expect(await screen.findByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("reports unexpected refresh failures without confirming success", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn().mockRejectedValue(new Error("network"));
    render(
      <HeaderRefreshButton
        label="Refresh"
        onRefresh={onRefresh}
        refreshing={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(toastError).toHaveBeenCalledWith("Error");
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });
});
