// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { regionAbortController } from "@/lib/region-abort";

type ApiEnvelope<T> = { ok: boolean; data: T };

export class AuthApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "AuthApiError";
  }
}

export interface OtpChallenge {
  verification_id: string;
  phone_masked: string;
  expires_in_seconds: number;
}

export interface OtpLoginResult {
  phone_masked: string;
  role: string;
  created_user: boolean;
  password_configured: boolean;
}

async function authError(response: Response, fallback: string): Promise<AuthApiError> {
  const body = (await response.json().catch(() => null)) as
    | { detail?: unknown; error?: unknown }
    | null;
  const detail = body?.detail;
  const message =
    (typeof detail === "string" && detail) ||
    (typeof body?.error === "string" && body.error) ||
    fallback;
  return new AuthApiError(message, response.status);
}

export function newAuthIdempotencyKey(): string {
  return `web:${crypto.randomUUID()}`;
}

export async function requestOtp(
  phone: string,
  idempotencyKey: string,
): Promise<OtpChallenge> {
  const response = await fetch("/api/v1/auth/otp/request", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    credentials: "include",
    body: JSON.stringify({ phone }),
    signal: regionAbortController().signal,
  });
  if (!response.ok) throw await authError(response, "Could not send verification code");
  const body = (await response.json()) as ApiEnvelope<OtpChallenge>;
  return body.data;
}

export async function verifyOtp(
  input: {
    phone: string;
    verificationId: string;
    code: string;
  },
  idempotencyKey: string,
): Promise<OtpLoginResult> {
  const response = await fetch("/api/v1/auth/otp/verify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    credentials: "include",
    body: JSON.stringify({
      phone: input.phone,
      verification_id: input.verificationId,
      code: input.code,
    }),
    signal: regionAbortController().signal,
  });
  if (!response.ok) throw await authError(response, "Verification failed");
  const body = (await response.json()) as ApiEnvelope<OtpLoginResult>;
  return body.data;
}
