// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { expect } from 'vitest';
import type { FreezoneRecipeCompileMetadata } from '@/api/ops';
import { isVideoNode, type CanvasNode, type CanvasEdge } from '@/features/canvas/domain/canvasNodes';
import { selectVideoModel } from '@/features/canvas/domain/catalogVideoModels';
import type { ModelOption } from '@/features/canvas/domain/modelOptions';
import { TaskCompletionError } from '@/features/canvas/domain/taskCompletionError';
import {
  buildVideoGenerationRequest, videoPromptCompileInput, videoPromptCompileMetadataPatch,
  videoExtendTrimRequirement, videoReferenceDurationProbe, type VideoGenerationRequestContext,
  type VideoGenerationRequestResult,
} from '@/features/canvas/application/generationRequests/videoGenerationRequest';
import {
  videoGenerationStartPatch, videoGenerationSubmitPatch, videoGenerationAcceptedPatch,
  videoGenerationRefusalOutcome, videoGenerationFailurePatch, videoGenerationRunOutcome,
  videoGenerationSettleOutcome, videoGenerationActionResult, videoUpscaleStartPatch,
  videoUpscaleAcceptedPatch, videoUpscaleOutcomePatch, videoUpscaleActionResult,
  type VideoGenerationRunError, type VideoGenerationNotice,
} from '@/features/canvas/application/generationRequests/videoGenerationResult';
import {
  describeGenerationError, describeGenerationSubmitFailure, generationErrorFromSubmitFailure,
  type GenerationSubmitFailure,
} from '@/features/canvas/application/generationRequests/generationSubmitError';
import expected from './videoGenerationExpected.json';

type Group = 'request' | 'media' | 'result';
type Translate = (key: string, options?: Record<string, unknown>) => string;
type Run = { kind: 'completed'; result: Record<string, unknown>; fallback?: string }
  | { kind: 'failed'; message: string } | { kind: 'cancelled' } | { kind: 'poll_timeout' }
  | { kind: 'submit_failed'; failure: GenerationSubmitFailure };
export type VideoFixture = Partial<Omit<VideoGenerationRequestContext, 'nodes' | 'edges'>> & {
  name: string; refusal?: string; rejection?: { media: string; kind: string }; forwardRefusal?: { code: string; phase: string };
  metadata?: FreezoneRecipeCompileMetadata; compiledPrompt?: string; compileFailure?: boolean;
  trim?: { url: string; durationMs: number }; runs?: Run[]; order?: number[];
  executionMode?: 'single' | 'workflow'; lastSlot?: boolean; upscale?: boolean;
};
interface Capture {
  graph: { nodes: CanvasNode[]; edges: CanvasEdge[] };
  compileInput: unknown; writes: unknown[]; requests: unknown[]; result: unknown;
  probeUrls?: string[]; trims?: unknown[]; finalData?: unknown;
  dialogs?: unknown[]; toasts?: unknown; dialogDom?: string[];
}
const startedAtMs = 1234567890000;
function restore(value: unknown): unknown {
  if (value === '__undefined__') return undefined;
  if (Array.isArray(value)) return value.map(restore);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restore(item)]));
  }
  return value;
}
function recorded(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item) => item === undefined ? '__undefined__' : item));
}
export function captureKeys(group: Group): string[] {
  return Object.keys(expected).filter(key => key.startsWith(`${group}/`)).map(key => key.slice(group.length + 1));
}
function exact(actual: unknown, captured: unknown) {
  expect(actual).toStrictEqual(captured);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(captured));
}
function taskRef(index: number) {
  return { task_key: `task-${index}`, task_type: 'freezone_video_gen', job_id: `job-${index}` };
}
function errorFor(run: Run, index: number): Error {
  if (run.kind === 'submit_failed') return generationErrorFromSubmitFailure(run.failure);
  return new TaskCompletionError(run.kind === 'failed' ? run.message : 'Cancelled',
    run.kind === 'cancelled' ? 'cancelled' : 'failed', taskRef(index).task_key);
}
function dialogsFor(notice: VideoGenerationNotice, upscale: boolean, t: Translate) {
  if (notice?.kind === 'error_dialog') return [{ title: notice.title, message: notice.message.trim(),
    details: notice.details?.trim() || undefined, copyText: undefined, variant: 'error' }];
  if (notice?.kind === 'still_running') return [{
    title: upscale ? 'Still generating' : t('errorDialog.stillRunningTitle'),
    message: upscale
      ? 'This generation is taking longer than expected. The page has stopped waiting, but the task is still running in the background. Refresh later or check the task centre for progress.'
      : t('errorDialog.stillRunningMessage'), details: undefined, variant: 'pending',
  }];
  return [];
}
export function checkCapture(group: Group, fixture: VideoFixture, catalog: ModelOption[], t: Translate) {
  const key = `${group}/${fixture.name}`;
  if (!(key in expected)) throw new Error(`Missing capture: ${key}`);
  // The checked-in recording uses JSON strings for the graph's discriminants and undefined sentinel.
  const E = expected[key as keyof typeof expected] as Capture;
  const graph = restore(E.graph) as Capture['graph'];
  const ctx: VideoGenerationRequestContext = {
    ...fixture, ...graph, nodeId: 'vid-1',
    projectId: fixture.projectId ?? `${group === 'result' ? 'result' : 'video'}-parity/${fixture.name}`,
    canvasId: 'canvas-7', executionSource: 'workflow', videoModels: fixture.videoModels ?? catalog,
    cameraTemplates: fixture.cameraTemplates ?? null, productOperation: fixture.productOperation ?? null,
    translate: t, inlineMedia: 'forward', mediaDurationsMs: undefined,
  };
  const target = ctx.nodes.find(node => node.id === 'vid-1');
  if (!isVideoNode(target)) throw new Error('Missing target video');
  const upscale = target.data.isUpscaleNode === true;
  const input = videoPromptCompileInput(ctx);
  const pre = buildVideoGenerationRequest({ ...ctx, prompt: input.fallbackPrompt });
  const writes: Record<string, unknown>[] = [];
  const requests: unknown[] = [];
  const trims: unknown[] = [];
  const probed: string[] = [];
  let notice: VideoGenerationNotice = null;
  let finalRefusal: Extract<VideoGenerationRequestResult, { ok: false }> | undefined;
  if (!pre.ok && pre.phase === 'guard') {
    finalRefusal = pre;
    const outcome = videoGenerationRefusalOutcome({ ...pre, startedAtMs }, t);
    expect(outcome.patches).toStrictEqual([]);
    writes.push(...outcome.patches); notice = outcome.notice;
    expect(E.compileInput).toBeNull();
  } else {
    writes.push(upscale ? videoUpscaleStartPatch(startedAtMs) : videoGenerationStartPatch(startedAtMs));
    if (upscale) expect(E.compileInput).toBeNull();
    else expect(input).toStrictEqual(restore(E.compileInput));
    if (fixture.compileFailure) {
      writes.push(videoGenerationFailurePatch(describeGenerationError(new Error('compile failed'), t,
        t('node.videoNode.generation.failed'))));
    } else {
      if (!upscale && fixture.metadata) writes.push(videoPromptCompileMetadataPatch(fixture.metadata, '2009-02-13T23:31:30.000Z'));
      const prompt = fixture.metadata?.prompt ?? fixture.compiledPrompt ?? input.fallbackPrompt;
      const post = { ...ctx, isGenerating: false };
      const requirement = videoExtendTrimRequirement(post);
      if (requirement) {
        const { videoUrl, startMs, endMs } = requirement;
        trims.push({ projectId: post.projectId, videoUrl, range: { startMs, endMs } });
        post.preparedExtendClip = { sourceUrl: videoUrl, startMs, endMs,
          ...(fixture.trim ?? { url: '/static/prepared.mp4', durationMs: 5000 }) };
      }
      for (let round = 0; round < 2; round += 1) {
        const probe = videoReferenceDurationProbe(post);
        if (!probe) break;
        probed.push(...probe.urls);
        post.mediaDurationsMs = { ...post.mediaDurationsMs,
          ...Object.fromEntries(probe.urls.map(url => [url,
            typeof fixture.mediaDurationsMs?.[url] === 'number' ? fixture.mediaDurationsMs[url] : null])) };
      }
      expect(videoReferenceDurationProbe(post)).toBeNull();
      const built = buildVideoGenerationRequest({ ...post, prompt });
      if (!built.ok) {
        finalRefusal = built;
        const outcome = videoGenerationRefusalOutcome({ ...built, startedAtMs }, t);
        expect(outcome.patches.slice(1).length).toBeGreaterThan(0);
        writes.push(...outcome.patches.slice(1)); notice = outcome.notice;
      } else {
        requests.push(...JSON.parse(JSON.stringify(built.requests)));
        if (!upscale) writes.push(videoGenerationSubmitPatch());
        const runs: Run[] = fixture.runs ?? built.requests.map((_, index) => ({ kind: 'completed',
          result: { video_url: `/static/task-${index + 1}.mp4`,
            ...(group === 'media' ? { output_url: `/static/task-${index + 1}.mp4` } : {}) } }));
        const offset = group === 'result' ? 0 : 1;
        if (runs[0]?.kind !== 'submit_failed') writes.push(upscale
          ? videoUpscaleAcceptedPatch(taskRef(offset)) : videoGenerationAcceptedPatch(taskRef(offset)));
        let completedUrls: string[] = [];
        const runErrors: VideoGenerationRunError[] = [];
        for (const index of fixture.order ?? runs.map((_, index) => index)) {
          const run = runs[index];
          if (upscale) {
            const outcome = run.kind === 'completed'
              ? run.fallback === 'throws' ? { kind: 'failed' as const, message: 'fallback failed' }
                : { kind: 'completed' as const, result: run.result, fallbackUrl: run.fallback ?? '' }
              : run.kind === 'poll_timeout' ? run
                : { kind: 'failed' as const, message: errorFor(run, index).message };
            const patch = videoUpscaleOutcomePatch(outcome);
            if (patch) writes.push(patch);
            if (run.kind === 'poll_timeout') notice = { kind: 'still_running' };
          } else {
            const outcome = run.kind === 'completed'
              ? { kind: 'completed' as const, result: run.result, fallbackUrl: run.fallback === 'throws' ? null : run.fallback ?? null }
              : run.kind === 'cancelled' || run.kind === 'poll_timeout' ? run
                : { kind: 'failed' as const, error: run.kind === 'submit_failed'
                  ? describeGenerationSubmitFailure(run.failure, t, t('node.videoNode.generation.failed'))
                  : describeGenerationError(errorFor(run, index), t, t('node.videoNode.generation.failed')) };
            const outcomeResult = videoGenerationRunOutcome({ runIndex: index, total: runs.length, completedUrls, outcome }, t);
            completedUrls = outcomeResult.completedUrls;
            if (outcomeResult.patch) writes.push(outcomeResult.patch);
            if (outcomeResult.runError) runErrors.push(outcomeResult.runError);
          }
        }
        if (!upscale) {
          const settled = videoGenerationSettleOutcome({ completedUrls, runErrors, total: runs.length,
            supportsHumanReview: target.data.genMode !== 'textToVideo'
              && selectVideoModel(ctx.videoModels, target.data.model)?.humanReview === true,
            humanReview: target.data.humanReview === true }, t);
          if (settled.patch) writes.push(settled.patch);
          notice = settled.notice;
        }
      }
    }
  }
  expect(finalRefusal && { code: finalRefusal.code, phase: finalRefusal.phase }).toStrictEqual(fixture.forwardRefusal);
  if (fixture.rejection) expect(finalRefusal).toMatchObject({
    media: fixture.rejection.media, rejection: { kind: fixture.rejection.kind },
  });
  if (fixture.refusal) {
    const requirement = videoExtendTrimRequirement(ctx);
    expect(buildVideoGenerationRequest({ ...ctx, inlineMedia: 'refuse', prompt: input.fallbackPrompt,
      mediaDurationsMs: fixture.mediaDurationsMs,
      preparedExtendClip: requirement && fixture.trim ? { sourceUrl: requirement.videoUrl,
        startMs: requirement.startMs, endMs: requirement.endMs, ...fixture.trim } : undefined,
    })).toMatchObject({ ok: false, code: fixture.refusal });
  }
  exact(requests, E.requests);
  expect(recorded(writes)).toStrictEqual(E.writes);
  const finalData = Object.assign({}, target.data, ...writes);
  expect({ requestId: fixture.name, nodeId: 'vid-1', action: 'generate_video',
    ...(upscale ? videoUpscaleActionResult : videoGenerationActionResult)(finalData, fixture.executionMode ?? 'workflow'),
  }).toStrictEqual(E.result);
  if (group === 'media') {
    expect(probed).toStrictEqual(E.probeUrls?.filter(url => !url.startsWith('/static/task-')));
    // Trim recordings retain the call argument array around each request.
    expect(trims.map(trim => [trim])).toStrictEqual(E.trims);
  }
  if (group === 'result') {
    expect(recorded(finalData)).toStrictEqual(E.finalData);
    exact(recorded(dialogsFor(notice, upscale, t)), E.dialogs);
    expect(notice?.kind === 'partial_failure'
      ? { error: [[t('node.videoNode.partialBatchFailed', { ok: notice.ok, total: notice.total })]] } : {}).toStrictEqual(E.toasts);
    if (notice?.kind !== 'reference_issues') expect(E.dialogDom).toStrictEqual([]);
    else {
      let position = -1;
      for (const text of ['referenceValidation.title', ...notice.issues.map(issue => `referenceValidation.${issue.code}`)]) {
        position = E.dialogDom![0].indexOf(text, position + 1);
        expect(position).toBeGreaterThanOrEqual(0);
      }
    }
  }
}
