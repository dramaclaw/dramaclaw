// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PasswordChangeDialog } from "@/components/account/password-change-dialog";

const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn() }));

vi.mock("sonner", () => ({ toast }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("PasswordChangeDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    toast.success.mockReset();
    toast.warning.mockReset();
  });

  function fillValidForm() {
    fireEvent.change(screen.getByLabelText("header.account.passwordDialog.current"), {
      target: { value: "current-password" },
    });
    fireEvent.change(screen.getByLabelText("header.account.passwordDialog.new"), {
      target: { value: "brand-new-password" },
    });
    fireEvent.change(screen.getByLabelText("header.account.passwordDialog.confirm"), {
      target: { value: "brand-new-password" },
    });
  }

  it("submits the current and new password, then signs the local session out", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          data: { sessions_revoked: 2, agent_sessions_revoked: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const onPasswordChanged = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <PasswordChangeDialog
        open
        onOpenChange={onOpenChange}
        onPasswordChanged={onPasswordChanged}
      />,
    );

    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: "header.account.passwordDialog.submit" }));

    await waitFor(() => expect(onPasswordChanged).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/account/password",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          current_password: "current-password",
          new_password: "brand-new-password",
        }),
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalledWith("header.account.passwordDialog.success");
  });

  it("keeps the dialog open when the current password is incorrect", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "current password incorrect" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const onPasswordChanged = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <PasswordChangeDialog
        open
        onOpenChange={onOpenChange}
        onPasswordChanged={onPasswordChanged}
      />,
    );

    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: "header.account.passwordDialog.submit" }));

    expect(
      await screen.findByText("header.account.passwordDialog.currentIncorrect"),
    ).toBeInTheDocument();
    expect(onPasswordChanged).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("blocks mismatched confirmation before making a request", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(
      <PasswordChangeDialog open onOpenChange={vi.fn()} onPasswordChanged={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText("header.account.passwordDialog.current"), {
      target: { value: "current-password" },
    });
    fireEvent.change(screen.getByLabelText("header.account.passwordDialog.new"), {
      target: { value: "brand-new-password" },
    });
    fireEvent.change(screen.getByLabelText("header.account.passwordDialog.confirm"), {
      target: { value: "different-password" },
    });

    expect(screen.getByText("header.account.passwordDialog.mismatch")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "header.account.passwordDialog.submit" }),
    ).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("signs out after a committed password change with partial cache invalidation", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ detail: { code: "PASSWORD_CHANGED_CACHE_PARTIAL" } }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      ),
    );
    const onPasswordChanged = vi.fn();
    render(
      <PasswordChangeDialog open onOpenChange={vi.fn()} onPasswordChanged={onPasswordChanged} />,
    );

    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: "header.account.passwordDialog.submit" }));

    await waitFor(() => expect(onPasswordChanged).toHaveBeenCalledOnce());
    expect(toast.warning).toHaveBeenCalledWith(
      "header.account.passwordDialog.partialSuccess",
    );
  });
});
