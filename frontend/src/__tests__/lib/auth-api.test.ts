// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  newAuthIdempotencyKey,
  requestOtp,
  verifyOtp,
} from "@/lib/auth-api";

describe("phone auth API", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends an idempotent OTP request without putting the phone in the URL", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          data: {
            verification_id: "A".repeat(26),
            phone_masked: "138****8000",
            expires_in_seconds: 300,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(requestOtp("13800138000", "web:request-key-0001")).resolves.toMatchObject({
      phone_masked: "138****8000",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/auth/otp/request",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({ "Idempotency-Key": "web:request-key-0001" }),
        body: JSON.stringify({ phone: "13800138000" }),
      }),
    );
  });

  it("verifies the challenge using the same phone and a separate idempotency key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          data: {
            phone_masked: "138****8000",
            role: "worker",
            created_user: true,
            password_configured: false,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await verifyOtp(
      { phone: "13800138000", verificationId: "A".repeat(26), code: "123456" },
      "web:verify-key-0001",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/auth/otp/verify",
      expect.objectContaining({
        headers: expect.objectContaining({ "Idempotency-Key": "web:verify-key-0001" }),
        body: JSON.stringify({
          phone: "13800138000",
          verification_id: "A".repeat(26),
          code: "123456",
        }),
      }),
    );
  });

  it("generates an allowlisted web idempotency key", () => {
    expect(newAuthIdempotencyKey()).toMatch(/^web:[0-9a-f-]{36}$/);
  });
});
