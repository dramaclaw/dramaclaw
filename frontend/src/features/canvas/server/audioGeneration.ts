// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import * as pure from '../application/generationRequests';
import { isAudioNode } from '../domain/canvasNodes';
import * as p from './generationPayload';
import { parseGenerationErrorInfo } from './generationError';
import { invalidRequest } from './requestPayload';
import { createServerTranslate } from './i18n';
import { runServerRequest } from './requestScope';

function requestContext(payload: unknown) {
  const input = p.record(payload);
  const { canvas, nodeId, env, locale, productOperation } = p.graph(input);
  const prompt = p.optional(env.prompt, p.string);
  const compileMode = p.optional(env.compile_mode, value => p.nullable(value, p.string)) ?? null;
  const recipeIds = p.optional(env.recipe_ids, value => p.array(value, p.string)) ?? [];
  return { locale, prompt, compileMode, recipeIds, context: { ...canvas, nodeId, projectId: p.string(env.project), canvasId: p.string(env.canvasId),
    productOperation, isGenerating: p.optional(env.is_generating, p.boolean) } };
}
export async function serveAudioGenerationRequest(payload: unknown) {
  const { locale, prompt, compileMode, recipeIds, context } = requestContext(payload);
  return runServerRequest(locale, async () => {
    const ctx = { ...context, translate: await createServerTranslate(locale) };
    const compile_input = pure.audioPromptCompileInput(ctx);
    const fallback = compile_input.kind === 'compile' ? compile_input.input.fallbackPrompt
      : compile_input.kind === 'literal' ? compile_input.prompt : '';
    return { compile_input, request: pure.buildAudioGenerationRequest({ ...ctx, prompt: prompt ?? fallback, compileMode, recipeIds }) };
  });
}
function hookError(value: unknown): pure.AudioGenerationHookError {
  const input = p.fields(value, ['message', 'isError', 'voicePrerequisite']);
  return { message: p.string(input.message), isError: p.boolean(input.isError), voicePrerequisite: p.boolean(input.voicePrerequisite) };
}
function hookOutput(value: unknown): pure.AudioGenerationHookOutput {
  const input = p.fields(value, ['audioUrl', 'skipped', 'reason']);
  p.optional(input.audioUrl, p.string); p.optional(input.skipped, p.boolean); p.optional(input.reason, p.string);
  return input;
}
function outcome(value: unknown): pure.AudioGenerationOutcome {
  const input = p.record(value);
  if (input.kind === 'completed') {
    p.fields(input, ['kind', 'url', 'durationMs']);
    const durationMs = p.optional(input.durationMs, value => p.nullable(value, p.number));
    return { kind: 'completed', url: p.string(input.url),
      ...(durationMs !== undefined ? { durationMs } : {}) };
  }
  if (input.kind !== 'failed') invalidRequest('Unknown audio outcome');
  p.fields(input, ['kind', 'message', 'isError', 'voicePrerequisite']);
  return { kind: 'failed', message: p.string(input.message), isError: p.boolean(input.isError), voicePrerequisite: p.boolean(input.voicePrerequisite) };
}
export async function serveAudioGenerationPatch(payload: unknown) {
  const { input, phase, locale } = p.patch(payload);
  switch (phase) {
    case 'start': {
      const time = p.number(input.started_at_ms);
      return runServerRequest(locale, async () => pure.audioGenerationStartPatch(time));
    }
    case 'accepted': {
      const task = p.task(input.task);
      return runServerRequest(locale, async () => pure.audioGenerationAcceptedPatch(task));
    }
    case 'voice_prerequisite': {
      const error = parseGenerationErrorInfo(input.error);
      return runServerRequest(locale, async () => pure.isAudioVoicePrerequisiteFailure(error));
    }
    case 'outcome': {
      const parsed = outcome(input.outcome);
      return runServerRequest(locale, async () => pure.audioGenerationOutcomePatch({ outcome: parsed, translate: await createServerTranslate(locale) }));
    }
    case 'action_result': {
      const latestNodeData = p.optional(input.latest_node_data, p.record);
      if (p.hasField(input, 'hook_output') === p.hasField(input, 'hook_error')) invalidRequest('Expected exactly one hook output or error');
      const action = p.hasField(input, 'hook_output') ? { latestNodeData, hookOutput: hookOutput(input.hook_output) }
        : { latestNodeData, hookError: hookError(input.hook_error) };
      return runServerRequest(locale, async () => pure.audioGenerationActionResult(action));
    }
    case 'repair': {
      const raw = p.record(input.node_data), time = p.string(input.now_iso);
      const data = { ...raw, audioUrl: p.nullable(raw.audioUrl, p.string) };
      return runServerRequest(locale, async () => pure.audioNodeRepairPatch(data, time));
    }
    case 'compile_metadata': {
      const { context, locale: contextLocale } = requestContext(input);
      if (!isAudioNode(context.nodes.find(node => node.id === context.nodeId))) invalidRequest('Expected an audio node for compile metadata');
      const metadata = p.metadata(input.metadata), time = p.string(input.compiled_at);
      return runServerRequest(contextLocale, async () => pure.audioPromptCompileMetadataPatch({ ...context,
        translate: await createServerTranslate(contextLocale) }, metadata, time));
    }
    default: return invalidRequest('Unknown audio generation patch phase');
  }
}
