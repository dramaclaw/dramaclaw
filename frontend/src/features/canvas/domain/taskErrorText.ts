// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CanvasEnvironment } from '../core/environment';

export type TaskErrorTranslate = CanvasEnvironment['translate'];

export function mediaStorageErrorMessage(raw: string, t: TaskErrorTranslate): string | null {
  // Generation errors can wrap this code in several provider/task exceptions.
  const code = raw.match(/\b(MEDIA_STORAGE_[A-Z_]+)\b/)?.[1];
  if (!code) return null;
  const translated = t(`settings.mediaStorage.errors.${code}`, { defaultValue: "" });
  return translated ? `${code}: ${translated}` : null;
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
export type GatewayErrorKind =
  | "channel_policy"
  | "rate_limit"
  | "input_content_policy"
  | "output_content_policy"
  | "content_policy";

function parseJsonValueAt(text: string, start: number): unknown | null {
  const opener = text[start];
  if (opener !== "{" && opener !== "[") return null;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char !== "}" && char !== "]") continue;
    const expected = char === "}" ? "{" : "[";
    if (stack.pop() !== expected) return null;
    if (stack.length === 0) {
      try {
        return JSON.parse(text.slice(start, index + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function providerErrorPayload(raw: string): unknown | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Gateway failures commonly wrap the provider response as
    // `HTTP ...; body={...}`. Preserve the wrapper for diagnostics while
    // parsing only the JSON body for the user-facing message.
  }

  const bodyMatch = /\bbody\s*=\s*/gi.exec(text);
  if (bodyMatch) {
    const jsonStart = bodyMatch.index + bodyMatch[0].length;
    const payload = parseJsonValueAt(text, jsonStart);
    if (payload) return payload;
  }

  // Video task errors use `HTTP <status> - {...}` rather than `body={...}`.
  // Scan JSON object boundaries so the structured gateway error survives the
  // Python task wrapper and remains available for localization.
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{") continue;
    const payload = parseJsonValueAt(text, index);
    if (payload) return payload;
  }
  return null;
}

function messageFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (record.error && typeof record.error === "object") {
    const nested = messageFromPayload(record.error);
    if (nested) return nested;
  }
  if (typeof record.message === "string" && record.message.trim()) {
    return record.message.trim();
  }
  return null;
}

/** Extract the provider's concise message without discarding the raw error. */
export function providerErrorMessage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return messageFromPayload(providerErrorPayload(raw));
}

interface HumanReviewAssetFailure {
  index: number;
  reasonCode: string;
}

function humanReviewAssetFailure(payload: unknown): HumanReviewAssetFailure | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (record.code === "human_review_asset_failed") {
    const data =
      record.data && typeof record.data === "object"
        ? (record.data as Record<string, unknown>)
        : {};
    return {
      index:
        typeof data.asset_index === "number" && Number.isFinite(data.asset_index)
          ? Math.max(1, Math.floor(data.asset_index))
          : 1,
      reasonCode:
        typeof data.reason_code === "string" && data.reason_code.trim()
          ? data.reason_code
          : "unknown_review_error",
    };
  }
  for (const nested of Object.values(record)) {
    const found = humanReviewAssetFailure(nested);
    if (found) return found;
  }
  return null;
}

function humanReviewAssetMessage(raw: string, t: TaskErrorTranslate): string | null {
  const failure = humanReviewAssetFailure(providerErrorPayload(raw));
  if (!failure) return null;
  const keyByReason: Record<string, string> = {
    asset_fetch_failed: "assetFetchFailed",
    asset_expired: "assetExpired",
    unsupported_image: "unsupportedImage",
    content_rejected: "contentRejected",
    review_timeout: "reviewTimeout",
    unknown_review_error: "unknownReviewError",
  };
  const reasonKey = keyByReason[failure.reasonCode] ?? "unknownReviewError";
  return t(`node.videoNode.humanReviewErrors.${reasonKey}`, {
    index: failure.index,
  });
}

export function classifyGatewayError(
  raw: string | null | undefined,
): GatewayErrorKind | null {
  if (!raw) return null;
  // `"type":"channel_policy"` is the authoritative marker; `_skipped` codes
  // (huimeng_low_quality_skipped, ...) are the same route-layer family.
  if (/channel[_-]?policy/i.test(raw) || /_skipped\b/i.test(raw)) {
    return "channel_policy";
  }
  if (/InputImageSensitiveContentDetected/i.test(raw)) {
    return "input_content_policy";
  }
  if (/Output(?:Video|Image)SensitiveContentDetected/i.test(raw)) {
    return "output_content_policy";
  }
  if (
    /content[_-]?policy[_-]?violation/i.test(raw)
    || /moderation[_-]?blocked/i.test(raw)
    || /failed safety review/i.test(raw)
    || /内容未通过安全审核/i.test(raw) // i18n-exempt -- backend error matching
  ) {
    return "content_policy";
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
  t: TaskErrorTranslate,
): string {
  const fallback = raw && raw.trim() ? raw : t("common.error");
  const storageMessage = raw ? mediaStorageErrorMessage(raw, t) : null;
  if (storageMessage) return storageMessage;
  if (raw && /billing rule is not configured/i.test(raw)) {
    return t("common.billingRuleNotConfigured", {
      defaultValue: "计费规则未配置，请联系管理员设置积分规则",
    });
  }
  const reviewMessage = raw ? humanReviewAssetMessage(raw, t) : null;
  if (reviewMessage) return reviewMessage;
  switch (classifyGatewayError(raw)) {
    case "channel_policy":
      return t("common.generationChannelPolicyBlocked", { defaultValue: fallback });
    case "input_content_policy":
      return t("common.generationInputContentPolicyBlocked", { defaultValue: fallback });
    case "output_content_policy":
      return t("common.generationOutputContentPolicyBlocked", { defaultValue: fallback });
    case "content_policy":
      return t("common.generationContentPolicyBlocked", { defaultValue: fallback });
    case "rate_limit":
      return t("common.generationRateLimited", { defaultValue: fallback });
    default:
      return providerErrorMessage(raw) ?? fallback;
  }
}
