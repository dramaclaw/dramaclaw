// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";

import { taskErrorMessage } from "@/task-center/task-errors";
import type { TaskState } from "@/task-center/types";

function task(partial: Partial<TaskState>): TaskState {
  return {
    task_id: "task_1",
    task_type: "build_characters",
    project_id: "project_1",
    episode: 0,
    status: "failed",
    created_at: "",
    updated_at: "",
    ...partial,
  } as TaskState;
}

describe("taskErrorMessage", () => {
  it("uses i18n for missing billing rule task errors", () => {
    const tMock = vi.fn((key: string, options?: { defaultValue?: string }) => {
      if (key === "common.billingRuleNotConfigured") {
        return "Billing rule is not configured.";
      }
      return options?.defaultValue ?? key;
    });
    const t = tMock as unknown as TFunction;

    expect(
      taskErrorMessage(
        task({
          error_code: "BILLING_RULE_NOT_CONFIGURED",
          error: "计费规则未配置，请联系管理员设置积分规则",
        }),
        t,
      ),
    ).toBe("Billing rule is not configured.");
    expect(tMock).toHaveBeenCalledWith("common.billingRuleNotConfigured", {
      defaultValue: "计费规则未配置，请联系管理员设置积分规则",
    });
  });
});
