// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from "i18next";
import type { TaskState } from "./types";

export function taskErrorMessage(task: TaskState, t: TFunction): string {
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
  return task.error || t("common.error");
}
