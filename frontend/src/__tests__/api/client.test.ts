// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";

import { apiCall } from "@/api/client";
import {
  backendErrorToastMessage,
  BillingRuleNotConfiguredError,
  errorFromBackendBody,
  InsufficientCreditsError,
  ProjectQueueLimitError,
} from "@/lib/api-errors";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiCall backend errors", () => {
  it("keeps status on string detail backend errors", () => {
    const error = errorFromBackendBody(
      409,
      { detail: "canvas base_revision is required" },
      "Conflict",
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error & { status?: number }).status).toBe(409);
    expect(error?.message).toBe("canvas base_revision is required");
  });

  it("surfaces project queue limit responses as ProjectQueueLimitError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: "当前项目 default 队列任务已满，请等待已有任务完成后再提交",
            data: {
              project_id: "demo",
              queue_kind: "default",
              limit: 3,
              active: 3,
              limit_scope: "project",
            },
          }),
          {
            status: 429,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    const promise = apiCall("projects/demo/freezone/gen", {
      prefix: "http://localhost/api/v1",
      method: "POST",
      json: {
        prompt: "生成一张图",
      },
    } as Parameters<typeof apiCall>[1]);

    await expect(promise).rejects.toMatchObject({
      name: "ProjectQueueLimitError",
      queueKind: "default",
      limitScope: "project",
    });
    await expect(promise).rejects.toBeInstanceOf(ProjectQueueLimitError);
  });

  it("surfaces personal queue limit responses with a personal limit message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: "你在当前项目 default 队列任务已满，请等待自己的任务完成后再提交",
            data: {
              project_id: "demo",
              requester_user_id: "user_1",
              queue_kind: "default",
              limit: 3,
              active: 3,
              limit_scope: "user",
            },
          }),
          {
            status: 429,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    const promise = apiCall("projects/demo/freezone/gen", {
      prefix: "http://localhost/api/v1",
      method: "POST",
      json: {
        prompt: "生成一张图",
      },
    } as Parameters<typeof apiCall>[1]);

    await expect(promise).rejects.toMatchObject({
      name: "ProjectQueueLimitError",
      queueKind: "default",
      limitScope: "user",
      message: "你在当前项目默认队列的任务已达个人上限",
    });
    await expect(promise).rejects.toBeInstanceOf(ProjectQueueLimitError);
  });

  it("uses i18n for project queue limit display text", () => {
    const tMock = vi.fn((key: string, options?: { queue?: string; defaultValue?: string }) => {
      if (key === "common.projectQueueKinds.video") return "视频";
      if (key === "common.projectQueueProjectFull") {
        return `当前项目${options?.queue}队列已达团队上限`;
      }
      if (key === "common.projectQueueFull") return `当前项目${options?.queue}队列已满`;
      return options?.defaultValue ?? key;
    });
    const t = tMock as unknown as TFunction;

    const message = backendErrorToastMessage(
      new ProjectQueueLimitError("video", "backend message", "project"),
      t,
    );

    expect(message).toBe("当前项目视频队列已达团队上限");
    expect(tMock).toHaveBeenCalledWith("common.projectQueueKinds.video", {
      defaultValue: "video",
    });
    expect(tMock).toHaveBeenCalledWith("common.projectQueueProjectFull", {
      queue: "视频",
      defaultValue: "当前项目视频队列已满",
    });
  });

  it("uses i18n for personal queue limit display text", () => {
    const tMock = vi.fn((key: string, options?: { queue?: string; defaultValue?: string }) => {
      if (key === "common.projectDefaultQueueUserFull") {
        return "你在当前项目默认队列的任务已达个人上限";
      }
      return options?.defaultValue ?? key;
    });
    const t = tMock as unknown as TFunction;

    const message = backendErrorToastMessage(
      new ProjectQueueLimitError("default", "backend message", "user"),
      t,
    );

    expect(message).toBe("你在当前项目默认队列的任务已达个人上限");
    expect(tMock).toHaveBeenCalledWith("common.projectDefaultQueueUserFull", {
      defaultValue: "common.projectDefaultQueueFull",
    });
  });

  it("uses i18n for insufficient credits display text", () => {
    const error = errorFromBackendBody(
      402,
      {
        ok: false,
        error: "积分不足，请联系管理员充值",
        data: {
          error_code: "INSUFFICIENT_CREDITS",
          required: 6,
          balance: 1,
        },
      },
      "Payment Required",
    );
    const tMock = vi.fn((key: string, options?: { defaultValue?: string }) => {
      if (key === "common.insufficientCredits") {
        return "Insufficient credits. Please contact your administrator to recharge.";
      }
      return options?.defaultValue ?? key;
    });
    const t = tMock as unknown as TFunction;

    expect(error).toBeInstanceOf(InsufficientCreditsError);
    expect(backendErrorToastMessage(error, t)).toBe(
      "Insufficient credits. Please contact your administrator to recharge.",
    );
    expect(tMock).toHaveBeenCalledWith("common.insufficientCredits", {
      defaultValue: "积分不足，请联系管理员充值",
    });
  });

  it("treats bare 402 responses as insufficient credits", () => {
    const error = errorFromBackendBody(402, null, "Payment Required");
    const tMock = vi.fn((key: string, options?: { defaultValue?: string }) => {
      if (key === "common.insufficientCredits") {
        return "Insufficient credits. Please contact your administrator to recharge.";
      }
      return options?.defaultValue ?? key;
    });
    const t = tMock as unknown as TFunction;

    expect(error).toBeInstanceOf(InsufficientCreditsError);
    expect(backendErrorToastMessage(error, t)).toBe(
      "Insufficient credits. Please contact your administrator to recharge.",
    );
  });

  it("uses i18n for missing billing rule display text", () => {
    const error = errorFromBackendBody(
      409,
      {
        ok: false,
        error: "计费规则未配置，请联系管理员设置积分规则",
        data: {
          error_code: "BILLING_RULE_NOT_CONFIGURED",
          billing_kind: "feature",
          billing_key: "build_characters",
        },
      },
      "Conflict",
    );
    const tMock = vi.fn((key: string, options?: { defaultValue?: string }) => {
      if (key === "common.billingRuleNotConfigured") {
        return "Billing rule is not configured. Please contact an administrator to set credit pricing.";
      }
      return options?.defaultValue ?? key;
    });
    const t = tMock as unknown as TFunction;

    expect(error).toBeInstanceOf(BillingRuleNotConfiguredError);
    expect(backendErrorToastMessage(error, t)).toBe(
      "Billing rule is not configured. Please contact an administrator to set credit pricing.",
    );
    expect(tMock).toHaveBeenCalledWith("common.billingRuleNotConfigured", {
      defaultValue: "计费规则未配置，请联系管理员设置积分规则",
    });
  });

  it("maps task metadata missing billing rule responses to the billing rule error", () => {
    const error = errorFromBackendBody(
      409,
      {
        ok: false,
        error: "计费规则未配置，请联系管理员设置积分规则",
        data: {
          task_id: "task_1",
          status: "failed",
          metadata: {
            error_code: "BILLING_RULE_NOT_CONFIGURED",
            billing_kind: "feature",
            billing_key: "ingest_fast",
          },
        },
      },
      "Request failed with status code 409 Conflict",
    );

    expect(error).toBeInstanceOf(BillingRuleNotConfiguredError);
    expect(error?.message).toBe("计费规则未配置，请联系管理员设置积分规则");
  });

  it("maps FastAPI detail object missing billing rule responses to the billing rule error", () => {
    const error = errorFromBackendBody(
      409,
      {
        detail: {
          error_code: "BILLING_RULE_NOT_CONFIGURED",
          message: "计费规则未配置，请联系管理员设置积分规则",
          billing_kind: "feature",
          billing_key: "ingest_fast",
        },
      },
      "Request failed with status code 409 Conflict",
    );

    expect(error).toBeInstanceOf(BillingRuleNotConfiguredError);
    expect(error?.message).toBe("计费规则未配置，请联系管理员设置积分规则");
  });
});
