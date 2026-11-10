// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import * as p from './generationPayload';
import { parseCanvasPayload } from './requestPayload';

export function project(value: unknown) {
  return p.optional(value, value => p.nullable(value, p.string));
}

export function productOperation(value: unknown) {
  if (value === undefined || value === null) return null;
  const input = p.fields(value, ['project_id', 'operation_id', 'generation_attempt_id']);
  return { projectId: p.string(input.project_id), operationId: p.string(input.operation_id),
    generationAttemptId: p.optional(input.generation_attempt_id, p.string) };
}

export function node(value: unknown) {
  const { canvas } = parseCanvasPayload({ canvas: { nodes: [value], edges: [] }, envelopes: [] });
  return canvas.nodes[0];
}
