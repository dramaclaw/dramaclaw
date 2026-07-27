// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// SuperTale API client. All freezone HTTP traffic goes through this single
// ky instance so we set credentials + base URL + error normalization once.

import ky, { HTTPError, type KyInstance, type Options } from "ky";
import { errorFromBackendBody } from "@/lib/api-errors";
import { handleSessionExpired } from "@/lib/api";

export interface ApiEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

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

const baseClient: KyInstance = ky.create({
  prefix: "/api/v1",
  credentials: "include", // share st_session cookie set by SuperTale login
  // The freezone backend is a remote dev box; transient drops (ECONNRESET) and
  // 5xx blips are common. ky retries network errors + 408/429/5xx with backoff,
  // but only on idempotent methods. Every canvas op here is idempotent (PUT is a
  // full replace), so retrying is safe and keeps a single blip off the page.
  retry: {
    limit: 2,
    methods: ["get", "put", "delete"],
    backoffLimit: 3_000,
  },
  timeout: 30_000,
  hooks: {
    afterResponse: [
      async ({ response }) => {
        if (response.status === 401) {
          await handleSessionExpired();
        }
      },
    ],
    beforeError: [
      async ({ error }) => {
        if (!(error instanceof HTTPError)) {
          return error;
        }
        let body: unknown = (error as HTTPError & { data?: unknown }).data;
        if (body === undefined) {
          try {
            body = await error.response.clone().json();
          } catch {
            try {
              body = await error.response.clone().text();
            } catch {
              body = undefined;
            }
          }
        }
        const message =
          (typeof body === "object" &&
            body &&
            "error" in body &&
            typeof (body as { error: unknown }).error === "string" &&
            (body as { error: string }).error) ||
          error.message ||
          `HTTP ${error.response.status}`;
        const apiErr =
          errorFromBackendBody(error.response.status, body, message) ??
          new ApiError(message, error.response.status, body);
        // ky expects an HTTPError, but we attach .cause for the caller.
        (error as HTTPError & { cause?: unknown }).cause = apiErr;
        return error;
      },
    ],
  },
});

/**
 * Unwrap the canonical SuperTale `{ ok, data, error }` envelope.
 * Throws ApiError on non-ok responses.
 */
export async function apiCall<T>(
  path: string,
  options?: Options,
): Promise<T> {
  try {
    const response = await baseClient(path, options).json<ApiEnvelope<T>>();
    if (!response.ok) {
      throw new ApiError(
        response.error ?? "API returned ok=false",
        200,
        response,
      );
    }
    if (response.data === undefined) {
      // Some endpoints return `{ ok: true }` with no data. Caller decides.
      return undefined as T;
    }
    return response.data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof HTTPError) {
      const cause = (err as HTTPError & { cause?: unknown }).cause;
      if (cause instanceof Error) throw cause;
      throw new ApiError(err.message, err.response.status);
    }
    throw err;
  }
}

export const apiClient = baseClient;
