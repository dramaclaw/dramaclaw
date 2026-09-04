// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from "i18next";

import { BackendStatusError } from "@/lib/api-errors";

const PAYMENT_ERROR_KEYS: Record<string, string> = {
  PAYMENT_TOO_MANY_PENDING: "credits.recharge.errors.tooManyPending",
  PAYMENT_PACKAGE_UNAVAILABLE: "credits.recharge.errors.packageUnavailable",
  PAYMENT_PACKAGE_NOT_FOUND: "credits.recharge.errors.packageUnavailable",
  PAYMENT_PACKAGE_PURCHASE_LIMIT: "credits.recharge.errors.purchaseLimit",
  PAYMENT_METHOD_UNAVAILABLE: "credits.recharge.errors.methodUnavailable",
  PAYMENT_ORG_CREDITS_INSUFFICIENT: "credits.recharge.errors.orgCreditsInsufficient",
  PAYMENT_PERSONAL_UNAVAILABLE: "credits.recharge.errors.accountUnavailable",
  PAYMENT_ORG_ADMIN_REQUIRED: "credits.recharge.errors.accountUnavailable",
  PAYMENT_ORG_MEMBER_REQUIRED: "credits.recharge.errors.accountUnavailable",
  PAYMENT_USER_UNAVAILABLE: "credits.recharge.errors.accountUnavailable",
  PAYMENT_RECHARGE_LINK_UNAVAILABLE: "credits.recharge.errors.linkUnavailable",
  PAYMENT_RECHARGE_LINK_SUBJECT_MISMATCH: "credits.recharge.errors.linkUnavailable",
  PAYMENT_IDEMPOTENCY_CONFLICT: "credits.recharge.errors.requestChanged",
  PAYMENT_CUSTOM_RECHARGE_VERSION_CONFLICT: "credits.recharge.errors.requestChanged",
};

export function paymentErrorToastMessage(
  error: unknown,
  t: TFunction,
  fallbackKey: string,
): string {
  const cause =
    error && typeof error === "object" && "cause" in error
      ? (error as { cause?: unknown }).cause
      : undefined;
  const paymentError = cause instanceof Error ? cause : error;
  const code = paymentError instanceof Error ? paymentError.message.trim() : "";
  const translationKey = PAYMENT_ERROR_KEYS[code];
  if (translationKey) return t(translationKey);
  if (paymentError instanceof BackendStatusError && paymentError.status >= 500) {
    return t("credits.recharge.errors.serviceUnavailable");
  }
  return t(fallbackKey);
}
