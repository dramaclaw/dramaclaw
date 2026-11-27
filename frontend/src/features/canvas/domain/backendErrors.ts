// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { humanizeTaskError, type TaskErrorTranslate } from './taskErrorText';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type TaskLaneLimitScope =
  | "project"
  | "user"
  | "channel"
  | "platform"
  | "global_lane_queue";

export class ProjectQueueLimitError extends Error {
  queueKind: string;
  limitScope: TaskLaneLimitScope;

  constructor(
    queueKind: string,
    message: string,
    limitScope: TaskLaneLimitScope = "project",
  ) {
    super(message);
    this.name = "ProjectQueueLimitError";
    this.queueKind = queueKind;
    this.limitScope = limitScope;
  }
}

export class BackendStatusError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "BackendStatusError";
  }
}

export class InsufficientCreditsError extends BackendStatusError {
  constructor(
    message: string,
    status: number,
    body?: unknown,
  ) {
    super(message, status, body);
    this.name = "InsufficientCreditsError";
  }
}

export class BillingRuleNotConfiguredError extends BackendStatusError {
  constructor(
    message: string,
    status: number,
    body?: unknown,
  ) {
    super(message, status, body);
    this.name = "BillingRuleNotConfiguredError";
  }
}

// 下面这两段合成的是 Error 对象自带的 message，只在拿不到 t 的地方兜底；界面上
// 真正显示的是 backendErrorToastMessage()，它按同样的措辞查 common.*QueueFull 词条。
// api-errors 位于 api/client 的依赖里，把 @/i18n 拉进来会在测试里二次 init i18next，
// 所以这里保留中文兜底，不入词条。
// i18n-exempt-start
function queueLabelForPlainMessage(queueKind: string): string {
  if (queueKind === "default") return "默认";
  if (queueKind === "image") return "图片";
  if (queueKind === "video") return "视频";
  if (queueKind === "world") return "世界";
  if (queueKind === "ffmpeg") return "合成";
  return queueKind;
}

function taskQueueLimitPlainMessage(
  queueKind: string,
  limitScope: TaskLaneLimitScope,
): string {
  const queueLabel = queueLabelForPlainMessage(queueKind);
  switch (limitScope) {
    case "user":
      return `你在当前${queueLabel}队列的任务已达个人上限`;
    case "channel":
      return `当前组织${queueLabel}队列已满`;
    case "platform":
      return `平台${queueLabel}队列已满`;
    case "global_lane_queue":
      return `当前节点${queueLabel}队列已满`;
    default:
      return `当前项目${queueLabel}队列已满`;
  }
}
// i18n-exempt-end

function taskLaneLimitScope(value: unknown): TaskLaneLimitScope | null {
  if (
    value === "project" ||
    value === "user" ||
    value === "channel" ||
    value === "platform" ||
    value === "global_lane_queue"
  ) {
    return value;
  }
  return null;
}

export function errorFromBackendBody(status: number, body: unknown, fallback: string): Error | null {
  if (!body || typeof body !== "object") {
    if (status === 402) {
      return new InsufficientCreditsError(fallback, status, body);
    }
    return null;
  }

  const findNestedString = (value: unknown, key: string): string | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    const direct = record[key];
    if (typeof direct === "string" && direct.trim()) return direct;
    for (const nested of Object.values(record)) {
      const found = findNestedString(nested, key);
      if (found) return found;
    }
    return undefined;
  };

  const data = (body as { data?: unknown }).data;
  const queueKind =
    data && typeof data === "object"
      ? (data as { queue_kind?: unknown }).queue_kind
      : undefined;
  const limitScope =
    data && typeof data === "object"
      ? (data as { limit_scope?: unknown }).limit_scope
      : undefined;
  const apiError = (body as { error?: unknown }).error;
  const detail = (body as { detail?: unknown }).detail;
  const directErrorCode =
    data && typeof data === "object"
      ? (data as { error_code?: unknown }).error_code
      : undefined;
  const errorCode =
    typeof directErrorCode === "string" && directErrorCode.trim()
      ? directErrorCode
      : findNestedString(body, "error_code");
  const message =
    typeof apiError === "string" && apiError.trim()
      ? apiError
      : typeof detail === "string" && detail.trim()
        ? detail
        : findNestedString(body, "message") ?? fallback;

  if (errorCode === "INSUFFICIENT_CREDITS") {
    return new InsufficientCreditsError(message, status, body);
  }
  if (status === 402) {
    return new InsufficientCreditsError(message, status, body);
  }
  if (errorCode === "BILLING_RULE_NOT_CONFIGURED") {
    return new BillingRuleNotConfiguredError(message, status, body);
  }
  // Some older responses lacked a structured error code.
  // Keep those responses on the same safe UI path.
  if (message.toLowerCase().includes("billing rule is not configured")) {
    return new BillingRuleNotConfiguredError(message, status, body);
  }
  // Keep legacy/wrapped Freezone 5xx responses on the safe billing path only
  // after every structured billing code has had a chance to classify them.
  if (
    status >= 500 &&
    status < 600 &&
    message.toLowerCase().includes("insufficient credits")
  ) {
    return new InsufficientCreditsError(message, status, body);
  }

  if (status === 429 && typeof queueKind === "string" && queueKind.trim()) {
    // Legacy responses did not include limit_scope and are project-scoped.
    // A supplied but unknown scope must keep the backend's generic message.
    const normalizedScope =
      limitScope === undefined ? "project" : taskLaneLimitScope(limitScope);
    if (!normalizedScope) {
      return new BackendStatusError(message, status, body);
    }
    return new ProjectQueueLimitError(
      queueKind,
      taskQueueLimitPlainMessage(queueKind, normalizedScope) || message,
      normalizedScope,
    );
  }
  if (typeof apiError === "string" && apiError.trim()) {
    return new BackendStatusError(apiError, status, body);
  }
  if (typeof detail === "string" && detail.trim()) {
    return new BackendStatusError(detail, status, body);
  }
  // FastAPI HTTPException 带结构化 detail（如技能接口的 SkillErrorEnvelope）。
  if (detail && typeof detail === "object") {
    const { message: detailMessage, user_action_hint: hint } = detail as {
      message?: unknown;
      user_action_hint?: unknown;
    };
    if (typeof detailMessage === "string" && detailMessage.trim()) {
      const text =
        typeof hint === "string" && hint.trim() ? `${detailMessage} ${hint}` : detailMessage;
      return new BackendStatusError(text, status, body);
    }
  }
  return null;
}

export function backendErrorToastMessage(error: unknown, t: TaskErrorTranslate): string {
  if (error instanceof InsufficientCreditsError) {
    return t("common.insufficientCredits", {
      defaultValue: error.message || t("common.error"),
    });
  }
  if (error instanceof BillingRuleNotConfiguredError) {
    return t("common.billingRuleNotConfigured", {
      defaultValue: error.message || t("common.error"),
    });
  }
  if (error instanceof ProjectQueueLimitError) {
    const translationScope =
      error.limitScope === "channel"
        ? "organization"
        : error.limitScope === "global_lane_queue"
          ? "node"
          : error.limitScope;
    if (error.queueKind === "default") {
      return t(`common.${translationScope}DefaultQueueFull`, {
        defaultValue: error.message,
      });
    }
    const queueLabel = t(`common.projectQueueKinds.${error.queueKind}`, {
      defaultValue: error.queueKind,
    });
    return t(`common.${translationScope}QueueFull`, {
      queue: queueLabel,
      defaultValue: error.message,
    });
  }
  if (error instanceof Error && error.message) {
    return humanizeTaskError(error.message, t);
  }
  return t("common.error");
}
