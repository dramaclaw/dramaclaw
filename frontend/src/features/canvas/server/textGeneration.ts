// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import * as pure from '../application/generationRequests';
import * as p from './generationPayload';
import { invalidRequest } from './requestPayload';
import { runServerRequest } from './requestScope';

export async function serveTextGenerationRequest(payload: unknown) {
  const input = p.record(payload);
  const { canvas, nodeId, locale, productOperation } = p.graph(input);
  const data = p.record(input.node_data);
  // Node data is opaque here: the pure builder already reads a non-string content as ''.
  const content = typeof data.content === 'string' ? data.content : '';
  const context = { ...canvas, nodeId, nodeData: { ...data, content }, productOperation };
  return runServerRequest(locale, async () => pure.buildTextGenerationRequest(context));
}
function outcome(value: unknown): pure.TextGenerationOutcome {
  const input = p.record(value);
  if (input.kind === 'completed') {
    p.fields(input, ['kind', 'content']);
    return { kind: 'completed', content: p.string(input.content) };
  }
  if (input.kind !== 'failed') invalidRequest('Unknown text outcome');
  p.fields(input, ['kind', 'message', 'isError']);
  return { kind: 'failed', message: p.string(input.message), isError: p.boolean(input.isError) };
}
export async function serveTextGenerationPatch(payload: unknown) {
  const { input, phase, locale } = p.patch(payload);
  switch (phase) {
    case 'start': {
      const time = p.number(input.started_at_ms);
      return runServerRequest(locale, async () => pure.textGenerationStartPatch(time));
    }
    case 'outcome': {
      const parsed = outcome(input.outcome);
      return runServerRequest(locale, async () => pure.textGenerationOutcomePatch({ outcome: parsed }));
    }
    default: return invalidRequest('Unknown text generation patch phase');
  }
}
