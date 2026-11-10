// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import * as pure from '../application/generationRequests';
import type { CameraMovementPreset } from '../domain/cameraMovementPresets';
import { videoModelOptionsFromPayload } from '../domain/modelCatalogPayload';
import { VIDEO_MODELS } from '../domain/modelOptions';
import * as p from './generationPayload';
import { parseGenerationErrorInfo } from './generationError';
import { invalidRequest } from './requestPayload';
import { createServerTranslate } from './i18n';
import { runServerRequest } from './requestScope';

function cameraTemplate(value: unknown): CameraMovementPreset {
  const input = p.fields(value, ['id', 'label', 'promptFragment', 'videoUrl']);
  return { id: p.string(input.id), label: p.string(input.label), promptFragment: p.string(input.promptFragment),
    videoUrl: p.nullable(input.videoUrl, p.string) };
}
function preparedClip(value: unknown): NonNullable<pure.VideoGenerationRequestContext['preparedExtendClip']> {
  const input = p.fields(value, ['sourceUrl', 'startMs', 'endMs', 'url', 'durationMs']);
  return { sourceUrl: p.string(input.sourceUrl), startMs: p.number(input.startMs), endMs: p.number(input.endMs),
    url: p.string(input.url), durationMs: p.number(input.durationMs) };
}
export async function serveVideoGenerationRequest(payload: unknown) {
  const input = p.record(payload);
  const { canvas, nodeId, env, locale, productOperation } = p.graph(input);
  const catalogs = p.optional(env.catalogs, p.record);
  const context: Omit<pure.VideoGenerationRequestContext, 'translate'> = {
    ...canvas, nodeId, projectId: p.string(env.project), canvasId: p.string(env.canvasId), productOperation,
    videoModels: catalogs?.video === undefined ? VIDEO_MODELS : videoModelOptionsFromPayload(catalogs.video),
    cameraTemplates: p.optional(env.camera_templates, value => p.nullable(value, value => p.array(value, cameraTemplate))) ?? null,
    executionSource: p.choice(env.executionSource, ['manual', 'workflow']),
    mediaDurationsMs: p.optional(env.media_durations_ms, value => Object.fromEntries(Object.entries(p.record(value)).map(([key, duration]) => [key, p.nullable(duration, p.number)]))),
    preparedExtendClip: p.optional(env.prepared_extend_clip, preparedClip), isGenerating: p.optional(env.is_generating, p.boolean),
  };
  const prompt = p.optional(env.prompt, p.string);
  return runServerRequest(locale, async () => {
    const ctx = { ...context, translate: await createServerTranslate(locale) };
    const trim_requirement = pure.videoExtendTrimRequirement(ctx);
    let compile_input;
    try { compile_input = pure.videoPromptCompileInput(ctx); }
    catch (error) {
      const request = pure.buildVideoGenerationRequest({ ...ctx, prompt: prompt ?? '' });
      if (!request.ok && request.code === 'not_video_node') return { compile_input: request, request, trim_requirement };
      throw error;
    }
    return { compile_input, request: pure.buildVideoGenerationRequest({ ...ctx, prompt: prompt ?? compile_input.fallbackPrompt }), trim_requirement };
  });
}
function runError(value: unknown): pure.VideoGenerationRunError {
  const input = p.record(value);
  if (input.kind === 'poll_timeout') { p.fields(input, ['kind']); return { kind: 'poll_timeout' }; }
  p.fields(input, ['kind', 'error']);
  if (input.kind !== 'failed') invalidRequest('Unknown video run error');
  return { kind: 'failed', error: parseGenerationErrorInfo(input.error) };
}
function runOutcome(value: unknown): pure.VideoGenerationRunOutcome {
  const input = p.record(value);
  if (input.kind === 'completed') {
    p.fields(input, ['kind', 'result', 'fallbackUrl']);
    return { kind: 'completed', result: p.nullable(input.result, p.record), fallbackUrl: p.nullable(input.fallbackUrl, p.string) };
  }
  if (input.kind === 'cancelled') { p.fields(input, ['kind']); return { kind: 'cancelled' }; }
  return runError(input);
}
function upscaleOutcome(value: unknown): pure.VideoUpscaleOutcome {
  const input = p.record(value);
  switch (input.kind) {
    case 'completed':
      p.fields(input, ['kind', 'result', 'fallbackUrl']);
      return { kind: 'completed', result: p.nullable(input.result, p.record), fallbackUrl: p.string(input.fallbackUrl) };
    case 'failed':
      p.fields(input, ['kind', 'message']);
      return { kind: 'failed', message: p.string(input.message) };
    case 'poll_timeout': p.fields(input, ['kind']); return { kind: 'poll_timeout' };
    default: return invalidRequest('Unknown upscale outcome');
  }
}
function durationRejection(value: unknown): NonNullable<Extract<pure.VideoGenerationRequestResult, { ok: false }>['rejection']> {
  const input = p.record(value);
  const kind = p.choice(input.kind, ['tooShort', 'tooLong', 'totalTooShort', 'totalTooLong']);
  p.fields(input, kind === 'tooShort' || kind === 'tooLong' ? ['kind', 'clips'] : ['kind', 'clips', 'totalMs', 'limitMs']);
  const clips = p.array(input.clips, value => {
    const clip = p.fields(value, ['label', 'durationMs', 'nodeId', 'url', 'index']);
    p.string(clip.label); p.number(clip.durationMs);
    p.optional(clip.nodeId, p.string); p.optional(clip.url, p.string); p.optional(clip.index, p.number);
    return clip as unknown as { label: string; durationMs: number; nodeId?: string; url?: string; index?: number };
  });
  return kind === 'tooShort' || kind === 'tooLong' ? { kind, clips } : { kind, clips, totalMs: p.number(input.totalMs), limitMs: p.number(input.limitMs) };
}
function refusalInput(value: unknown): pure.VideoGenerationRefusalInput {
  const input = p.record(value);
  if (input.ok !== false) invalidRequest('Expected a video refusal');
  const message = p.string(input.message), startedAtMs = p.number(input.startedAtMs);
  if (input.code === 'reference_duration_invalid') {
    p.fields(input, ['ok', 'code', 'message', 'startedAtMs', 'media', 'rejection', 'phase', 'durationLimits']);
    if (input.phase !== 'duration') invalidRequest('Expected duration refusal phase');
    const limits = p.fields(input.durationLimits, ['minMs', 'maxMs']);
    return { ok: false, code: input.code, message, startedAtMs, phase: 'duration', media: p.choice(input.media, ['audio', 'video']),
      rejection: durationRejection(input.rejection), durationLimits: { minMs: p.optional(limits.minMs, p.number), maxMs: p.optional(limits.maxMs, p.number) } };
  }
  p.fields(input, ['ok', 'code', 'message', 'startedAtMs', 'phase', 'isHappyHorseModel']);
  return { ok: false, message, startedAtMs,
    code: p.choice(input.code, ['not_video_node', 'no_model', 'no_project', 'generation_in_progress', 'no_effective_prompt', 'missing_media',
      'reference_limit_exceeded', 'model_capability_error', 'inline_media_reference', 'missing_source_video', 'missing_references',
      'mode_unsupported_by_model', 'extend_clip_not_prepared', 'missing_upscale_source']),
    phase: p.optional(input.phase, value => p.choice(value, ['guard', 'keyframes', 'images', 'source_video', 'references', 'unsupported_mode'])),
    isHappyHorseModel: p.optional(input.isHappyHorseModel, p.boolean) };
}
export async function serveVideoGenerationPatch(payload: unknown) {
  const { input, phase, locale } = p.patch(payload);
  // Parse before entering the request scope; all clocks and preparation are caller data.
  switch (phase) {
    case 'start': case 'upscale_start': {
      const time = p.number(input.started_at_ms);
      return runServerRequest(locale, async () => phase === 'start' ? pure.videoGenerationStartPatch(time) : pure.videoUpscaleStartPatch(time));
    }
    case 'submit': return runServerRequest(locale, async () => pure.videoGenerationSubmitPatch());
    case 'accepted': case 'upscale_accepted': {
      const ref = p.task(input.task);
      return runServerRequest(locale, async () => phase === 'accepted' ? pure.videoGenerationAcceptedPatch(ref) : pure.videoUpscaleAcceptedPatch(ref));
    }
    case 'compile_metadata': {
      const metadata = p.metadata(input.metadata), time = p.string(input.compiled_at);
      return runServerRequest(locale, async () => pure.videoPromptCompileMetadataPatch(metadata, time));
    }
    case 'refusal': {
      const refusal = refusalInput(input.refusal);
      return runServerRequest(locale, async () => pure.videoGenerationRefusalOutcome(refusal, await createServerTranslate(locale)));
    }
    case 'failure': {
      const error = parseGenerationErrorInfo(input.error);
      return runServerRequest(locale, async () => pure.videoGenerationFailurePatch(error));
    }
    case 'run_outcome': {
      const run = { runIndex: p.number(input.run_index), total: p.number(input.total), completedUrls: p.array(input.completed_urls, p.string), outcome: runOutcome(input.outcome) };
      return runServerRequest(locale, async () => pure.videoGenerationRunOutcome(run, await createServerTranslate(locale)));
    }
    case 'settle': {
      const settle = { completedUrls: p.array(input.completed_urls, p.string), runErrors: p.array(input.run_errors, runError), total: p.number(input.total),
        supportsHumanReview: p.boolean(input.supports_human_review), humanReview: p.boolean(input.human_review) };
      return runServerRequest(locale, async () => pure.videoGenerationSettleOutcome(settle, await createServerTranslate(locale)));
    }
    case 'action_result': case 'upscale_action_result': {
      const data = p.optional(input.final_node_data, value => p.nullable(value, p.record)), mode = p.optional(input.execution_mode, p.string);
      return runServerRequest(locale, async () => phase === 'action_result' ? pure.videoGenerationActionResult(data, mode) : pure.videoUpscaleActionResult(data, mode));
    }
    case 'upscale_outcome': {
      const outcome = upscaleOutcome(input.outcome);
      return runServerRequest(locale, async () => pure.videoUpscaleOutcomePatch(outcome));
    }
    default: return invalidRequest('Unknown video generation patch phase');
  }
}
