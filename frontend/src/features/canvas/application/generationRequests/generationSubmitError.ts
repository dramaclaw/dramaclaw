// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CanvasEnvironment } from '../../core/environment';
import { ApiError, backendErrorToastMessage, errorFromBackendBody } from '../../domain/backendErrors';
import { resolveErrorContent } from '../../domain/errorContent';
import { referenceIssues, type ReferenceIssue } from '../../domain/referenceIssues';
import { resolveGenerationErrorDiagnostics } from '../generationErrorReport';

/** Plain submit-failure data; never put Error, Request or Response objects here. */
export type GenerationSubmitFailure =
  | {
      kind: 'http';
      status: number;
      statusText: string;
      /** The browser request method (normally POST), already normalised by Request. */
      method: string;
      /** Absolute request URL, as exposed by the browser's Request.url. */
      url: string;
      /**
       * The body seen by api/client's beforeError, after ky has consumed the response:
       * - Empty body: omit (undefined), including an empty JSON response.
       * - JSON Content-Type (including +json): parsed JSON, including null.
       * - Other Content-Type: the non-empty response text, even if it looks like JSON.
       * - Invalid JSON with JSON Content-Type: omit (undefined), not the raw text.
       * ky leaves data undefined for empty/invalid bodies; the hook's clone().json()
       * and clone().text() fallbacks also fail because the body is already consumed.
       * Do not preclassify or substitute statusText for a missing body.
       * method/url feed ky's HTTPError message. That text reaches node diagnostics
       * when the body supplies no non-empty error string or other recognised message.
       */
      body?: unknown;
    }
  | {
      kind: 'envelope';
      /** Parsed, non-null 2xx envelope with falsy ok, passed intact to ApiError. */
      body: unknown;
    }
  | {
      kind: 'thrown';
      /**
       * Error rethrown by apiCall without HTTP/envelope classification.
       * ky NetworkError: "Request failed due to a network error: METHOD ABSOLUTE_URL".
       * ky TimeoutError: "Request timed out: METHOD ABSOLUTE_URL".
       * Capture the actual name/message: unrecognised fetch failures may stay TypeError.
       * Reconstruction preserves name/message using Error; ky constructors, request,
       * cause and stack cannot be recovered from this serialised form.
       */
      name: string;
      message: string;
    };

export function generationErrorFromSubmitFailure(failure: GenerationSubmitFailure): Error {
  switch (failure.kind) {
    case 'http': {
      const { status, statusText, method, url, body } = failure;
      const statusLabel = `${status} ${statusText}`.trim();
      const httpMessage = `Request failed with status code ${statusLabel}: ${method} ${url}`;
      const message = (typeof body === 'object' && body !== null && 'error' in body
        && typeof body.error === 'string' && body.error) || httpMessage;
      return errorFromBackendBody(status, body, message) ?? new ApiError(message, status, body);
    }
    case 'envelope': {
      const body = failure.body;
      const message = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
      return new ApiError(String(message ?? 'API returned ok=false'), 200, body);
    }
    case 'thrown': {
      const error = new Error(failure.message);
      error.name = failure.name;
      return error;
    }
  }
}

export interface GenerationErrorInfo {
  name: string;
  message: string;
  status: number | null;
  display: string;
  details: string | null;
  requestId: string | null;
  referenceIssues: ReferenceIssue[];
}

export function describeGenerationError(
  error: unknown,
  translate: CanvasEnvironment['translate'],
  fallbackMessage: string,
): GenerationErrorInfo {
  const content = resolveErrorContent(error, fallbackMessage);
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : content.message,
    status: error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
      ? error.status : null,
    display: backendErrorToastMessage(error, translate),
    ...resolveGenerationErrorDiagnostics(error, content.details),
    referenceIssues: referenceIssues(error),
  };
}

export function describeGenerationSubmitFailure(
  failure: GenerationSubmitFailure,
  translate: CanvasEnvironment['translate'],
  fallbackMessage: string,
): GenerationErrorInfo {
  return describeGenerationError(generationErrorFromSubmitFailure(failure), translate, fallbackMessage);
}
