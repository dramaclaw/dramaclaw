// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import * as pure from '../application/generationRequests';
import * as p from './generationPayload';
import { project, productOperation } from './toolPayload';
import { invalidRequest } from './requestPayload';
import { runServerRequest } from './requestScope';

export async function serveAudioTranslateRequest(payload: unknown) {
  const input = p.fields(payload, ['canvas', 'node_id', 'env']);
  const { canvas, nodeId, env, locale } = p.graph(input);
  p.fields(env, ['locale', 'project', 'canvas_id', 'product_operation']);
  const context = { nodes: canvas.nodes, nodeId, projectId: project(env.project), canvasId: p.string(env.canvas_id),
    productOperation: productOperation(env.product_operation) };
  return runServerRequest(locale, async () => pure.buildAudioTranslateRequest(context));
}

export async function serveAudioTranslatePatch(payload: unknown) {
  const { input, phase, locale } = p.patch(payload);
  switch (phase) {
    case 'result': {
      p.fields(input, ['phase', 'locale', 'translated_text']);
      const text = p.string(input.translated_text);
      return runServerRequest(locale, async () => pure.audioTranslateResultPatch(text));
    }
    case 'action_result': {
      if (p.hasField(input, 'text') === p.hasField(input, 'error')) invalidRequest('Expected exactly one text or error');
      p.fields(input, ['phase', 'locale', 'text', 'error']);
      const parsed = p.hasField(input, 'error') ? { error: p.string(input.error) } : { text: p.string(input.text) };
      return runServerRequest(locale, async () => pure.audioTranslateActionResult(parsed));
    }
    default: return invalidRequest('Unknown audio translate patch phase');
  }
}
