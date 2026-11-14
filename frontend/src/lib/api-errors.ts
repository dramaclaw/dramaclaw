// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TaskErrorTranslate } from '@/features/canvas/domain/taskErrorText';
import { HTTPError } from "ky";
import type { ErrorResponse } from "@/types/api";

import { mediaStorageErrorMessage } from '@/features/canvas/domain/taskErrorText';
export { humanizeTaskError, mediaStorageErrorMessage, providerErrorMessage, classifyGatewayError } from '@/features/canvas/domain/taskErrorText';
export type { GatewayErrorKind } from '@/features/canvas/domain/taskErrorText';

import { errorFromBackendBody, backendErrorToastMessage } from '@/features/canvas/domain/backendErrors';
export {
  ProjectQueueLimitError, BackendStatusError, InsufficientCreditsError,
  BillingRuleNotConfiguredError, errorFromBackendBody, backendErrorToastMessage,
} from '@/features/canvas/domain/backendErrors';

export const NOVEL_IMPORT_REQUIRED_CODE = "NOVEL_IMPORT_REQUIRED";

export function backendErrorCodeToastMessage(
  errorCode: string | null | undefined,
  fallback: string,
  t: TaskErrorTranslate,
): string | null {
  if (errorCode === NOVEL_IMPORT_REQUIRED_CODE) {
    return t("common.novelImportRequired", { defaultValue: fallback });
  }
  return errorCode ? mediaStorageErrorMessage(errorCode, t) : null;
}

/**
 * 排队接口成功时的 toast 文案。
 *
 * 后端给了 message_code 就按词条翻，没给的（还没迁移的接口）照旧回显 message
 * 里那句中文 —— 和进度/日志走同一套约定，接口可以一个一个迁。
 */
export function taskResponseToastMessage(
  response: {
    message?: string | null;
    message_code?: string | null;
    message_params?: Record<string, unknown> | null;
  },
  t: TaskErrorTranslate,
): string {
  const text = String(response.message ?? "");
  if (!response.message_code) return text;
  return t(response.message_code, { defaultValue: text, ...(response.message_params ?? {}) });
}

export function backendErrorResponseToastMessage(
  response: Pick<ErrorResponse, "code" | "error">,
  t: TaskErrorTranslate,
): string {
  return (
    backendErrorCodeToastMessage(response.code, response.error, t) ??
    backendErrorToastMessage(new Error(response.error), t)
  );
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
  // ky 2 会先把错误响应体解析到 error.data（此时 response 已读完），与 api/client 的 beforeError 一致。
  const data = (error as HTTPError & { data?: unknown }).data;
  const body = data !== undefined ? data : await safeJsonFromResponse(error.response);
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
