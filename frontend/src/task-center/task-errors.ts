// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from "i18next";
import {
  backendErrorCodeToastMessage,
  humanizeTaskError,
} from "@/lib/api-errors";
import type { TaskState } from "./types";

export function taskErrorMessage(task: TaskState, t: TFunction): string {
  const localized = backendErrorCodeToastMessage(
    task.error_code,
    task.error || t("common.error"),
    t,
  );
  if (localized) return localized;
  if (task.error_code === "INSUFFICIENT_CREDITS") {
    return t("common.insufficientCredits", {
      defaultValue: task.error || t("common.error"),
    });
  }
  if (task.error_code === "BILLING_RULE_NOT_CONFIGURED") {
    return t("common.billingRuleNotConfigured", {
      defaultValue: task.error || t("common.error"),
    });
  }
  return humanizeTaskError(task.error, t);
}
