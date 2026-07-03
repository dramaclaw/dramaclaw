// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from "i18next";
import { HTTPError } from "ky";

export class ProjectQueueLimitError extends Error {
  queueKind: string;
  limitScope: "project" | "user";

  constructor(
    queueKind: string,
    message: string,
    limitScope: "project" | "user" = "project",
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

function queueLabelForPlainMessage(queueKind: string): string {
  if (queueKind === "default") return "默认";
  if (queueKind === "video") return "视频";
  if (queueKind === "world") return "世界";
  if (queueKind === "ffmpeg") return "合成";
  return queueKind;
}

function projectQueueLimitPlainMessage(
  queueKind: string,
  limitScope: "project" | "user",
): string {
  const queueLabel = queueLabelForPlainMessage(queueKind);
  if (limitScope === "user") {
    return `你在当前项目${queueLabel}队列的任务已达个人上限`;
  }
  return `当前项目${queueLabel}队列已达团队上限`;
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

  if (status === 429 && typeof queueKind === "string" && queueKind.trim()) {
    const normalizedScope = limitScope === "user" ? "user" : "project";
    return new ProjectQueueLimitError(
      queueKind,
      projectQueueLimitPlainMessage(queueKind, normalizedScope) || message,
      normalizedScope,
    );
  }
  if (typeof apiError === "string" && apiError.trim()) {
    return new BackendStatusError(apiError, status, body);
  }
  if (typeof detail === "string" && detail.trim()) {
    return new BackendStatusError(detail, status, body);
  }
  return null;
}

async function safeJsonFromResponse(response: Response): Promise<unknown> {
  try {
    return await response.clone().json();
  } catch {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
}

async function backendError(error: unknown): Promise<Error | null> {
  if (!(error instanceof HTTPError)) return null;
  const body = await safeJsonFromResponse(error.response);
  return errorFromBackendBody(error.response.status, body, error.message);
}

export async function jsonWithBackendError<T>(request: Promise<Response>): Promise<T> {
  try {
    const response = await request;
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const parsedError = errorFromBackendBody(response.status, body, response.statusText);
      if (parsedError) throw parsedError;
      throw new Error(response.statusText);
    }
    return body as T;
  } catch (error) {
    const parsedError = await backendError(error);
    if (parsedError) throw parsedError;
    throw error;
  }
}

/**
 * Classify a raw generation-task error string coming back from the model
 * gateway. Sketch/render/video failures surface as a RuntimeError whose text
 * embeds the gateway response, e.g.
 *
 *   草图重生未生成可用图片（...）: HTTP 429: ...; body={"error":{"code":"huimeng_low_quality_skipped","type":"channel_policy",...}}
 *
 * A `channel_policy` rejection is a *route-layer* refusal (the gateway skipped
 * the channel before dispatching, e.g. low-quality sketch regen), NOT real
 * upstream throttling — even though it too rides on an HTTP 429. Callers need
 * to tell the two apart so users don't read a policy block as "try again in a
 * bit". Order matters: check the policy signal before the bare-429 signal.
 */
export type GatewayErrorKind = "channel_policy" | "rate_limit";

export function classifyGatewayError(
  raw: string | null | undefined,
): GatewayErrorKind | null {
  if (!raw) return null;
  // `"type":"channel_policy"` is the authoritative marker; `_skipped` codes
  // (huimeng_low_quality_skipped, ...) are the same route-layer family.
  if (/channel[_-]?policy/i.test(raw) || /_skipped\b/i.test(raw)) {
    return "channel_policy";
  }
  // Genuine upstream limit. `HTTP 429` is how run_core stamps the status.
  if (/\bHTTP 429\b/.test(raw) || /\b429\b.*rate/i.test(raw)) {
    return "rate_limit";
  }
  return null;
}

/**
 * Turn a raw task-error string into a user-facing toast message, giving
 * `channel_policy` and real rate-limit failures their own explanation instead
 * of leaking the generic "…未生成可用图片: HTTP 429: …body={…}" blob.
 */
export function humanizeTaskError(
  raw: string | null | undefined,
  t: TFunction,
): string {
  const fallback = raw && raw.trim() ? raw : t("common.error");
  switch (classifyGatewayError(raw)) {
    case "channel_policy":
      return t("common.generationChannelPolicyBlocked", { defaultValue: fallback });
    case "rate_limit":
      return t("common.generationRateLimited", { defaultValue: fallback });
    default:
      return fallback;
  }
}

export function backendErrorToastMessage(error: unknown, t: TFunction): string {
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
    const scopeSuffix = error.limitScope === "user" ? "UserFull" : "ProjectFull";
    if (error.queueKind === "default") {
      return t(`common.projectDefaultQueue${scopeSuffix}`, {
        defaultValue: t("common.projectDefaultQueueFull"),
      });
    }
    const queueLabel = t(`common.projectQueueKinds.${error.queueKind}`, {
      defaultValue: error.queueKind,
    });
    return t(`common.projectQueue${scopeSuffix}`, {
      queue: queueLabel,
      defaultValue: t("common.projectQueueFull", { queue: queueLabel }),
    });
  }
  return error instanceof Error && error.message ? error.message : t("common.error");
}
