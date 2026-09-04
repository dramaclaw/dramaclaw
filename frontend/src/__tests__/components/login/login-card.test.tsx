// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LoginCard } from "@/components/login/login-card";

const navigate = vi.hoisted(() => vi.fn());
const login = vi.hoisted(() => vi.fn());
const loginWithOtp = vi.hoisted(() => vi.fn());
const requestOtp = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const otpEntryVisible = vi.hoisted(() => vi.fn(() => true));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/components/login/region-selector", () => ({ RegionSelector: () => null }));
vi.mock("@/lib/cluster-config", () => ({
  clusterConfig: { mode: "none", regions: [] },
}));
vi.mock("@/lib/runtime-config", () => ({ phoneOtpEntryVisible: otpEntryVisible }));
vi.mock("@/stores/region-store", () => ({
  useRegionStore: (selector: (state: { selectedRegionId: null }) => unknown) =>
    selector({ selectedRegionId: null }),
}));
vi.mock("@/stores/auth-store", () => ({
  useAuthStore: (selector: (state: { login: typeof login; loginWithOtp: typeof loginWithOtp }) => unknown) =>
    selector({ login, loginWithOtp }),
}));
vi.mock("@/lib/auth-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth-api")>("@/lib/auth-api");
  return {
    ...actual,
    newAuthIdempotencyKey: () => "web:test-key-0001",
    requestOtp,
  };
});
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
  }),
}));

describe("LoginCard", () => {
  beforeEach(() => {
    navigate.mockReset();
    login.mockReset();
    loginWithOtp.mockReset();
    requestOtp.mockReset();
    toast.success.mockReset();
    toast.error.mockReset();
    otpEntryVisible.mockReturnValue(true);
  });

  it("uses OTP as the default sign-in path and completes auto-registration", async () => {
    requestOtp.mockResolvedValue({
      verification_id: "A".repeat(26),
      phone_masked: "138****8000",
      expires_in_seconds: 300,
    });
    loginWithOtp.mockResolvedValue({
      username: `u_${"B".repeat(26)}`,
      phone_masked: "138****8000",
      role: "worker",
      created_user: true,
      password_configured: false,
    });
    render(<LoginCard />);

    fireEvent.change(screen.getByLabelText("auth.otp.phone"), {
      target: { value: "13800138000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "auth.otp.send" }));

    await waitFor(() => expect(requestOtp).toHaveBeenCalledWith("13800138000", "web:test-key-0001"));
    fireEvent.change(screen.getByLabelText("auth.otp.code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "auth.otp.loginButton" }));

    await waitFor(() =>
      expect(loginWithOtp).toHaveBeenCalledWith(
        "13800138000",
        "A".repeat(26),
        "123456",
        "web:test-key-0001",
      ),
    );
    expect(toast.success).toHaveBeenCalledWith("auth.otp.accountCreated");
    expect(navigate).toHaveBeenCalledWith({ to: "/", replace: true });
  });

  it("keeps account/password login available as the second mode", async () => {
    login.mockResolvedValue(undefined);
    render(<LoginCard />);

    fireEvent.click(screen.getByRole("tab", { name: "auth.passwordTab" }));
    fireEvent.change(screen.getByLabelText("auth.accountOrPhone"), {
      target: { value: "13800138000" },
    });
    fireEvent.change(screen.getByLabelText("auth.password"), {
      target: { value: "password123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "auth.loginButton" }));

    await waitFor(() => expect(login).toHaveBeenCalledWith("13800138000", "password123"));
    expect(navigate).toHaveBeenCalledWith({ to: "/", replace: true });
  });

  it("shows only account/password login while the OTP entry is hidden", async () => {
    otpEntryVisible.mockReturnValue(false);
    login.mockResolvedValue(undefined);
    render(<LoginCard />);

    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByLabelText("auth.otp.phone")).toBeNull();
    expect(screen.queryByLabelText("auth.accountOrPhone")).toBeNull();
    expect(screen.getByLabelText("auth.account")).toBeTruthy();
    expect(screen.getByPlaceholderText("auth.accountPlaceholder")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("auth.account"), {
      target: { value: "legacy-account" },
    });
    fireEvent.change(screen.getByLabelText("auth.password"), {
      target: { value: "password123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "auth.loginButton" }));

    await waitFor(() => expect(login).toHaveBeenCalledWith("legacy-account", "password123"));
    expect(requestOtp).not.toHaveBeenCalled();
  });
});
