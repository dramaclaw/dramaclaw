// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";

const handleSessionExpiredMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/lib/api", () => ({
  handleSessionExpired: handleSessionExpiredMock,
}));

import { apiCall } from "@/api/client";
import {
  backendErrorToastMessage,
  BillingRuleNotConfiguredError,
  errorFromBackendBody,
  InsufficientCreditsError,
  ProjectQueueLimitError,
} from "@/lib/api-errors";

afterEach(() => {
  handleSessionExpiredMock.mockClear();
  vi.unstubAllGlobals();
});

describe("apiCall backend errors", () => {
  it("routes a 401 through the shared session-expired handler", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ detail: "Missing session or agent token" }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    await expect(
      apiCall("projects/demo/freezone/canvases/demo/projections:status", {
        prefix: "http://localhost/api/v1",
        method: "POST",
        json: { projection_keys: [] },
      } as Parameters<typeof apiCall>[1]),
    ).rejects.toMatchObject({ status: 401 });

    expect(handleSessionExpiredMock).toHaveBeenCalledOnce();
  });

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
      message: "当前项目默认队列已满",
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
      message: "你在当前默认队列的任务已达个人上限",
    });
    await expect(promise).rejects.toBeInstanceOf(ProjectQueueLimitError);
  });

  it.each([
    ["channel", "organization", "当前组织视频队列已满"],
    ["platform", "platform", "平台视频队列已满"],
    ["global_lane_queue", "node", "当前节点视频队列已满"],
  ] as const)("preserves the %s lane scope from EE", (limitScope, scopeKind, message) => {
    const error = errorFromBackendBody(
      429,
      {
        ok: false,
        error: "Task lane limit exceeded",
        data: {
          queue_kind: "video",
          limit_scope: limitScope,
          scope_kind: scopeKind,
          limit: 3,
          active: 3,
        },
      },
      "Too Many Requests",
    );

    expect(error).toMatchObject({
      name: "ProjectQueueLimitError",
      queueKind: "video",
      limitScope,
      message,
    });
  });

  it("keeps an unknown lane scope on the generic backend error path", () => {
    const error = errorFromBackendBody(
      429,
      {
        ok: false,
        error: "Task lane limit exceeded",
        data: {
          queue_kind: "video",
          limit_scope: "unknown_scope",
        },
      },
      "Too Many Requests",
    );

    expect(error).toMatchObject({
      name: "BackendStatusError",
      message: "Task lane limit exceeded",
      status: 429,
    });
  });

  it("uses i18n for project queue limit display text", () => {
    const tMock = vi.fn((key: string, options?: { queue?: string; defaultValue?: string }) => {
      if (key === "common.projectQueueKinds.video") return "视频";
      if (key === "common.projectQueueFull") return `当前项目${options?.queue}队列已满`;
      return options?.defaultValue ?? key;
    });
    const t = tMock as unknown as TFunction;

    const message = backendErrorToastMessage(
      new ProjectQueueLimitError("video", "backend message", "project"),
      t,
    );

    expect(message).toBe("当前项目视频队列已满");
    expect(tMock).toHaveBeenCalledWith("common.projectQueueKinds.video", {
      defaultValue: "video",
    });
    expect(tMock).toHaveBeenCalledWith("common.projectQueueFull", {
      queue: "视频",
      defaultValue: "backend message",
    });
  });

  it("uses i18n for personal queue limit display text", () => {
    const tMock = vi.fn((key: string, options?: { queue?: string; defaultValue?: string }) => {
      if (key === "common.userDefaultQueueFull") {
        return "你在当前默认队列的任务已达个人上限";
      }
      return options?.defaultValue ?? key;
    });
    const t = tMock as unknown as TFunction;

    const message = backendErrorToastMessage(
      new ProjectQueueLimitError("default", "backend message", "user"),
      t,
    );

    expect(message).toBe("你在当前默认队列的任务已达个人上限");
    expect(tMock).toHaveBeenCalledWith("common.userDefaultQueueFull", {
      defaultValue: "backend message",
    });
  });

  it.each([
    ["channel", "common.organizationQueueFull", "当前组织视频队列已满"],
    ["platform", "common.platformQueueFull", "平台视频队列已满"],
    ["global_lane_queue", "common.nodeQueueFull", "当前节点视频队列已满"],
  ] as const)("uses i18n for the %s queue pool", (limitScope, messageKey, expectedMessage) => {
    const tMock = vi.fn((key: string, options?: { queue?: string; defaultValue?: string }) => {
      if (key === "common.projectQueueKinds.video") return "视频";
      if (key === messageKey) return expectedMessage;
      return options?.defaultValue ?? key;
    });
    const t = tMock as unknown as TFunction;

    const message = backendErrorToastMessage(
      new ProjectQueueLimitError("video", "backend message", limitScope),
      t,
    );

    expect(message).toBe(expectedMessage);
    expect(tMock).toHaveBeenCalledWith(messageKey, {
      queue: "视频",
      defaultValue: "backend message",
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

  it("maps legacy wrapped Freezone insufficient-credit errors", () => {
    const error = errorFromBackendBody(
      503,
      {
        detail:
          "failed to start freezone image-to-video task: insufficient credits for user usr_1: required 40, available 8",
      },
      "Service Unavailable",
    );
    const tMock = vi.fn((key: string, options?: { defaultValue?: string }) => {
      if (key === "common.insufficientCredits") {
        return "积分不足，请联系管理员充值";
      }
      return options?.defaultValue ?? key;
    });

    expect(error).toBeInstanceOf(InsufficientCreditsError);
    expect(backendErrorToastMessage(error, tMock as unknown as TFunction)).toBe(
      "积分不足，请联系管理员充值",
    );
  });

  it("prefers a structured billing-rule code over legacy message text", () => {
    const error = errorFromBackendBody(
      503,
      {
        detail: {
          error_code: "BILLING_RULE_NOT_CONFIGURED",
          message: "billing rule is not configured; insufficient credits fallback",
        },
      },
      "Service Unavailable",
    );

    expect(error).toBeInstanceOf(BillingRuleNotConfiguredError);
  });

  it("does not classify non-5xx legacy text as insufficient credits", () => {
    const error = errorFromBackendBody(
      400,
      { detail: "invalid request: insufficient credits text from client" },
      "Bad Request",
    );

    expect(error).not.toBeInstanceOf(InsufficientCreditsError);
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
          billing_key: "mainline.build_characters",
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
            billing_key: "mainline.ingest_fast",
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
          billing_key: "mainline.ingest_fast",
        },
      },
      "Request failed with status code 409 Conflict",
    );

    expect(error).toBeInstanceOf(BillingRuleNotConfiguredError);
    expect(error?.message).toBe("计费规则未配置，请联系管理员设置积分规则");
  });
});
