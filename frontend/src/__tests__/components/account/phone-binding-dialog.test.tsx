// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PhoneBindingDialog } from "@/components/account/phone-binding-dialog";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

const challenge = {
  verification_id: "A".repeat(26),
  phone_masked: "138****8000",
  expires_in_seconds: 300,
};
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("PhoneBindingDialog", () => {
  beforeEach(() => vi.restoreAllMocks());

  async function requestCode() {
    fireEvent.change(
      screen.getByLabelText("header.account.passwordDialog.current"),
      { target: { value: "current-password" } },
    );
    fireEvent.change(screen.getByLabelText("auth.otp.phone"), {
      target: { value: "13800138000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "auth.otp.send" }));
    await screen.findByLabelText("auth.otp.code");
  }

  it("binds via authenticated account endpoints without replacing the session", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(reply({ ok: true, data: challenge }))
      .mockResolvedValueOnce(
        reply({
          ok: true,
          data: {
            phone: "+8613800138000",
            phone_masked: challenge.phone_masked,
          },
        }),
      );
    const onBound = vi.fn();
    const onClose = vi.fn();
    render(<PhoneBindingDialog onBound={onBound} onClose={onClose} />);
    expect(
      screen.getByRole("button", { name: "auth.otp.send" }),
    ).toBeDisabled();
    await requestCode();
    fireEvent.change(screen.getByLabelText("auth.otp.code"), {
      target: { value: "123456" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "header.account.phoneBinding.submit",
      }),
    );
    await waitFor(() => expect(onBound).toHaveBeenCalledOnce());
    expect(onClose).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/account/phone/request",
      expect.objectContaining({
        credentials: "include",
        body: JSON.stringify({
          phone: "13800138000",
          current_password: "current-password",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/account/phone/verify",
      expect.objectContaining({
        credentials: "include",
        body: JSON.stringify({
          phone: "13800138000",
          current_password: "current-password",
          code: "123456",
          verification_id: challenge.verification_id,
        }),
      }),
    );
  });

  it("keeps the existing account when a verified phone is already in use", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(reply({ ok: true, data: challenge }))
      .mockResolvedValueOnce(reply({ detail: { code: "PHONE_IN_USE" } }, 409));
    const onBound = vi.fn();
    render(<PhoneBindingDialog onBound={onBound} onClose={vi.fn()} />);
    await requestCode();
    fireEvent.change(screen.getByLabelText("auth.otp.code"), {
      target: { value: "123456" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "header.account.phoneBinding.submit",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "header.account.phoneBinding.inUse",
    );
    expect(onBound).not.toHaveBeenCalled();
  });

  it("invalidates the challenge when phone or password changes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      reply({ ok: true, data: challenge }),
    );
    render(<PhoneBindingDialog onBound={vi.fn()} onClose={vi.fn()} />);
    await requestCode();
    fireEvent.change(screen.getByLabelText("auth.otp.phone"), {
      target: { value: "13900139000" },
    });
    expect(screen.queryByLabelText("auth.otp.code")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "header.account.phoneBinding.submit",
      }),
    ).toBeDisabled();
  });

  it("reuses the verification idempotency key after a lost response", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(reply({ ok: true, data: challenge }))
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(
        reply({ ok: true, data: { phone: "+8613800138000" } }),
      );
    const onBound = vi.fn();
    render(<PhoneBindingDialog onBound={onBound} onClose={vi.fn()} />);
    await requestCode();
    fireEvent.change(screen.getByLabelText("auth.otp.code"), {
      target: { value: "123456" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "header.account.phoneBinding.submit",
      }),
    );
    await screen.findByRole("alert");
    fireEvent.click(
      screen.getByRole("button", {
        name: "header.account.phoneBinding.submit",
      }),
    );
    await waitFor(() => expect(onBound).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[1][1]?.headers).toEqual(
      fetchMock.mock.calls[2][1]?.headers,
    );
  });
});
