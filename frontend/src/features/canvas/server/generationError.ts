// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describeGenerationSubmitFailure, type GenerationErrorInfo, type GenerationSubmitFailure } from '../application/generationRequests';
import type { ReferenceIssue } from '../domain/referenceIssues';
import * as p from './generationPayload';
import { invalidRequest } from './requestPayload';
import { runServerRequest } from './requestScope';
import { createServerTranslate } from './i18n';

function referenceIssue(value: unknown): ReferenceIssue {
  const input = p.fields(value, ['media', 'index', 'name', 'reference_key', 'code', 'actual', 'expected', 'nodeId', 'label', 'role']);
  p.string(input.media); p.number(input.index); p.string(input.name); p.string(input.reference_key); p.string(input.code);
  p.optional(input.nodeId, p.string); p.optional(input.label, p.string); p.optional(input.role, p.string);
  // Preserve optional fields exactly after validating the boundary object.
  return input as unknown as ReferenceIssue;
}
export function parseGenerationErrorInfo(value: unknown): GenerationErrorInfo {
  const input = p.fields(value, ['name', 'message', 'status', 'display', 'details', 'requestId', 'referenceIssues']);
  return { name: p.string(input.name), message: p.string(input.message), status: p.nullable(input.status, p.number),
    display: p.string(input.display), details: p.nullable(input.details, p.string), requestId: p.nullable(input.requestId, p.string),
    referenceIssues: p.array(input.referenceIssues, referenceIssue) };
}
function parseFailure(value: unknown): GenerationSubmitFailure {
  const input = p.record(value);
  switch (input.kind) {
    case 'http':
      p.fields(input, ['kind', 'status', 'statusText', 'method', 'url', 'body']);
      return { kind: 'http', status: p.number(input.status), statusText: p.string(input.statusText),
        method: p.string(input.method), url: p.string(input.url), ...(p.hasField(input, 'body') ? { body: input.body } : {}) };
    case 'envelope':
      p.fields(input, ['kind', 'body']);
      if (!p.hasField(input, 'body')) invalidRequest('An envelope body is required');
      return { kind: 'envelope', body: input.body };
    case 'thrown':
      p.fields(input, ['kind', 'name', 'message']);
      return { kind: 'thrown', name: p.string(input.name), message: p.string(input.message) };
    default: return invalidRequest('Unknown generation submit failure kind');
  }
}
export async function serveGenerationErrorDescribe(payload: unknown) {
  const input = p.fields(payload, ['locale', 'failure', 'fallback_message']);
  const locale = p.optional(input.locale, p.string);
  const failure = parseFailure(input.failure);
  const fallback = p.string(input.fallback_message);
  return runServerRequest(locale, async () => describeGenerationSubmitFailure(failure, await createServerTranslate(locale), fallback));
}
