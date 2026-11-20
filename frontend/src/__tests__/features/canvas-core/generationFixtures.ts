// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import * as pure from '@/features/canvas/application/generationRequests';
import { CANVAS_NODE_TYPES, type CanvasNode, type AudioNodeData } from '@/features/canvas/domain/canvasNodes';
import { videoModelOptionsFromPayload } from '@/features/canvas/domain/modelCatalogPayload';
import { VIDEO_MODELS } from '@/features/canvas/domain/modelOptions';
import { createServerTranslate } from '@/features/canvas/server/i18n';
import { requestPayload as imageRequest, requestContext as imageContext, outcomePayload, outcomeInput, task, compileMetadata } from './imageGenerationFixtures';

export interface Fixture { name: string; op: string; payload: Record<string, unknown>; expected: () => unknown | Promise<unknown> }
export const error: pure.GenerationErrorInfo = {
  name: 'ApiError', message: 'request_id=req-1 failed', status: 422, display: 'Try again',
  details: 'request_id=req-1 failed', requestId: 'req-1', referenceIssues: [],
};
export const issue = { media: 'audio', index: 1, name: 'Clip', reference_key: '/clip.wav', code: 'minDuration',
  nodeId: 'source', label: 'Clip', role: '', actual: 1, expected: 2 };
export const operation = { projectId: 'test/project', operationId: 'operation-1', generationAttemptId: 'attempt-1' };
export const catalog = { models: [{ id: 'test-video', model: 'test-video', provider: 'seedance',
  supported_modes: ['text_to_video', 'image_to_video', 'image_reference', 'first_frame', 'first_last_frame', 'all_reference', 'video_edit', 'video_extend'],
  reference_image_max: 9, reference_video_max: 3, reference_audio_max: 3 }] };
export function videoPayload(data: Record<string, unknown> = {}) {
  const nodes: CanvasNode[] = [{ id: 'video', type: CANVAS_NODE_TYPES.video, position: { x: 0, y: 0 },
    data: { prompt: 'A cat runs', model: 'test-video', genMode: 'textToVideo', ...data } }];
  return { canvas: { nodes, edges: [] as { id: string; source: string; target: string }[] }, node_id: 'video', env: {
    locale: 'en', project: 'test/project', canvasId: 'canvas-1', catalogs: { video: catalog } as { video?: unknown } | undefined,
    executionSource: 'workflow' as 'manual' | 'workflow', productOperation: operation as typeof operation | null,
    camera_templates: null as pure.VideoGenerationRequestContext['cameraTemplates'],
    media_durations_ms: {} as Record<string, number | null>,
    prepared_extend_clip: undefined as pure.VideoGenerationRequestContext['preparedExtendClip'],
    is_generating: false, prompt: undefined as string | undefined,
  } };
}
export async function videoExpected(p: ReturnType<typeof videoPayload>) {
  const ctx: pure.VideoGenerationRequestContext = { ...p.canvas, nodeId: p.node_id,
    projectId: p.env.project, canvasId: p.env.canvasId, executionSource: p.env.executionSource,
    productOperation: p.env.productOperation, cameraTemplates: p.env.camera_templates,
    videoModels: p.env.catalogs?.video === undefined ? VIDEO_MODELS : videoModelOptionsFromPayload(p.env.catalogs.video),
    translate: await createServerTranslate(p.env.locale), mediaDurationsMs: p.env.media_durations_ms,
    preparedExtendClip: p.env.prepared_extend_clip, isGenerating: p.env.is_generating };
  if (!ctx.nodes.some(n => n.id === ctx.nodeId && n.type === CANVAS_NODE_TYPES.video)) {
    const request = pure.buildVideoGenerationRequest({ ...ctx, prompt: p.env.prompt ?? '' });
    return { compile_input: request, request, trim_requirement: pure.videoExtendTrimRequirement(ctx) };
  }
  const compile_input = pure.videoPromptCompileInput(ctx);
  return { compile_input, request: pure.buildVideoGenerationRequest({ ...ctx, prompt: p.env.prompt ?? compile_input.fallbackPrompt }),
    trim_requirement: pure.videoExtendTrimRequirement(ctx) };
}
export function audioPayload(data: Record<string, unknown> = {}) {
  const nodes: CanvasNode[] = [{ id: 'audio', type: CANVAS_NODE_TYPES.audio, position: { x: 0, y: 0 },
    data: { audioUrl: null, audioKind: 'music', text: 'Gentle piano', model: 'suno_music', ...data } }];
  return { canvas: { nodes, edges: [] }, node_id: 'audio', env: { locale: 'en', project: 'test/project',
    canvasId: 'canvas-1', productOperation: operation as typeof operation | null, is_generating: false,
    prompt: undefined as string | undefined, compile_mode: null as string | null, recipe_ids: [] as string[] } };
}
export async function audioContext(p: ReturnType<typeof audioPayload>): Promise<pure.AudioGenerationRequestContext> {
  return { ...p.canvas, nodeId: p.node_id, projectId: p.env.project, canvasId: p.env.canvasId,
    productOperation: p.env.productOperation, isGenerating: p.env.is_generating, translate: await createServerTranslate(p.env.locale) };
}
export async function audioExpected(p: ReturnType<typeof audioPayload>) {
  const ctx = await audioContext(p);
  const compile_input = pure.audioPromptCompileInput(ctx);
  const fallback = compile_input.kind === 'compile' ? compile_input.input.fallbackPrompt
    : compile_input.kind === 'literal' ? compile_input.prompt : '';
  return { compile_input, request: pure.buildAudioGenerationRequest({ ...ctx, prompt: p.env.prompt ?? fallback,
    compileMode: p.env.compile_mode, recipeIds: p.env.recipe_ids }) };
}
export function textPayload(data: Record<string, unknown> = {}) {
  const node_data = { content: 'Write a scene', workflowCatalog: { recipeId: 'recipe-1' }, ...data };
  const nodes: CanvasNode[] = [{ id: 'text', type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 0, y: 0 }, data: { content: 'Old render' } }];
  return { canvas: { nodes, edges: [] }, node_id: 'text', node_data, env: { locale: 'en', productOperation: operation as typeof operation | null } };
}
export function textExpected(p: ReturnType<typeof textPayload>) {
  return pure.buildTextGenerationRequest({ ...p.canvas, nodeId: p.node_id, nodeData: p.node_data, productOperation: p.env.productOperation });
}
export function requestFixtures(): Fixture[] {
  const out: Fixture[] = [];
  const video = (name: string, p = videoPayload()) => out.push({ name, op: 'video_generation_request', payload: p, expected: () => videoExpected(p) });
  video('video-default');
  for (const prompt of ['', 'Compiled prompt\n']) { const p = videoPayload(); p.env.prompt = prompt; video(`video-prompt-${prompt}`, p); }
  for (const catalogs of [undefined, {}, { video: [] }, { video: { data: catalog.models } }]) {
    const p = videoPayload(); p.env.catalogs = catalogs; video(`video-catalog-${JSON.stringify(catalogs)}`, p);
  }
  for (const node_id of ['missing', 'source']) { const p = videoPayload(); p.node_id = node_id; video(`video-target-${node_id}`, p); }
  { const p = videoPayload(); p.env.is_generating = true; video('video-busy', p); }
  { const p = videoPayload(); p.env.executionSource = 'manual'; p.env.productOperation = null; p.env.camera_templates = [{ id: 'custom', label: 'Camera', promptFragment: 'Pan slowly', videoUrl: null }]; p.canvas.nodes[0].data.cameraMovement = 'custom'; video('video-camera-manual', p); }
  for (const genMode of ['imageToVideo', 'imageReference', 'firstFrame', 'firstLastFrame', 'videoEdit', 'videoExtend', 'allReference']) {
    for (const inline of [false, true]) {
      const p = videoPayload({ genMode });
      const isVideo = ['videoEdit', 'videoExtend', 'allReference'].includes(genMode);
      p.canvas.nodes.push({ id: 'source', type: isVideo ? CANVAS_NODE_TYPES.video : CANVAS_NODE_TYPES.upload,
        position: { x: 1, y: 0 }, data: isVideo ? { videoUrl: inline ? 'data:video/mp4;base64,AA==' : '/source.mp4', durationMs: 5000 }
          : { imageUrl: inline ? 'data:image/png;base64,AA==' : '/source.png' } });
      p.canvas.edges.push({ id: 'edge', source: 'source', target: 'video' });
      video(`video-${genMode}-${inline ? 'inline' : 'uploaded'}`, p);
    }
  }
  for (const prepared of [false, true]) for (const locale of ['en', 'zh']) {
    const p = videoPayload({ genMode: 'allReference', isExtendMode: true, extendStartMs: 1000, extendEndMs: 3000 });
    p.env.locale = locale; p.env.media_durations_ms = { '/source.mp4': 5000, '/unknown.wav': null };
    p.canvas.nodes.push({ id: 'source', type: CANVAS_NODE_TYPES.video, position: { x: 0, y: 1 }, data: { videoUrl: '/source.mp4', durationMs: 5000 } });
    p.canvas.edges.push({ id: 'edge', source: 'source', target: 'video' });
    if (prepared) p.env.prepared_extend_clip = { sourceUrl: '/source.mp4', startMs: 1000, endMs: 3000, url: '/trim.mp4', durationMs: 2000 };
    video(`video-trim-${prepared}-${locale}`, p);
    if (prepared) {
      const inline = structuredClone(p);
      if (inline.env.prepared_extend_clip) inline.env.prepared_extend_clip.url = 'data:video/mp4;base64,AA==';
      video(`video-trim-inline-${locale}`, inline);
    }
  }
  for (const url of ['/source.mp4?x=1', 'data:video/mp4;base64,AA==', '']) video(`video-upscale-${url}`, videoPayload({ isUpscaleNode: true, upscaleSourceUrl: url }));
  for (const measured of [null, 1000, 3000]) {
    const p = videoPayload({ genMode: 'allReference' });
    p.env.catalogs = { video: { models: catalog.models.map(model => ({ ...model, reference_audio_min_seconds: 2 })) } };
    p.canvas.nodes.push({ id: 'source', type: CANVAS_NODE_TYPES.audio, position: { x: 1, y: 0 }, data: { audioUrl: '/source.wav' } });
    p.canvas.edges.push({ id: 'edge', source: 'source', target: 'video' });
    p.env.media_durations_ms = { '/source.wav': measured };
    video(`video-measured-audio-${measured}`, p);
  }
  const audio = (name: string, p = audioPayload()) => out.push({ name, op: 'audio_generation_request', payload: p, expected: () => audioExpected(p) });
  audio('audio-music');
  for (const locale of ['en', 'zh']) {
    for (const data of [{ audioKind: 'speech', model: 'indextts2', text: 'Hello there', voicePolicyConfirmed: true, voiceAvailable: false },
      { audioKind: 'speech', model: 'edge_tts', text: 'Hello there', speechMode: 'preset' },
      { audioKind: 'speech', model: 'indextts2', text: 'Hello there', voiceAvailable: true, voiceRef: { scope: 'user_custom', voiceId: 'voice-1' }, workflowCatalog: { recipeId: 'drama-shot-voice' } },
      { audioKind: 'speech', text: '\u6839\u636e\u811a\u672c\u751f\u6210\u65c1\u767d\u914d\u97f3' },
      { text: '' }]) { const p = audioPayload(data); p.env.locale = locale; audio(`audio-${locale}-${JSON.stringify(data)}`, p); }
    const p = audioPayload(); p.env.project = ''; p.env.locale = locale; audio(`audio-no-project-${locale}`, p);
  }
  { const p = audioPayload(); p.env.is_generating = true; audio('audio-busy', p); }
  { const p = audioPayload(); p.node_id = 'missing'; audio('audio-wrong-node', p); }
  { const p = audioPayload(); p.env.prompt = 'Compiled music'; p.env.compile_mode = 'model'; p.env.recipe_ids = ['recipe-1']; audio('audio-compiled', p); }
  { const p = textPayload(); delete (p.node_data as Record<string, unknown>).content; out.push({ name: 'text-no-content', op: 'text_generation_request', payload: p, expected: () => textExpected(p) }); }
  for (const data of [{}, { content: '' }, { content: 17 }, { workflowCatalog: {} },{ workflowCatalog: { recipeId: 'r', skillId: 'skill-1', skillVersion: '1', confirmedInputs: { mood: 'calm' }, recipePipeline: ['r'] } }]) {
    const p = textPayload(data); out.push({ name: `text-${JSON.stringify(data)}`, op: 'text_generation_request', payload: p, expected: () => textExpected(p) });
  }
  return out;
}
export async function patchFixtures(): Promise<Fixture[]> {
  const out: Fixture[] = [];
  const add = (op: string, name: string, payload: Record<string, unknown>, expected: Fixture['expected']) => out.push({ op, name, payload, expected });
  for (const locale of ['en', 'zh']) {
    const t = () => createServerTranslate(locale);
    const v = (phase: string, name: string, fields: Record<string, unknown>, expected: Fixture['expected']) => add('video_generation_patch', `video-${phase}-${name}-${locale}`, { phase, locale, ...fields }, expected);
    const a = (phase: string, name: string, fields: Record<string, unknown>, expected: Fixture['expected']) => add('audio_generation_patch', `audio-${phase}-${name}-${locale}`, { phase, locale, ...fields }, expected);
    const im = (phase: string, name: string, fields: Record<string, unknown>, expected: Fixture['expected']) => add('image_generation_patch', `image-${phase}-${name}-${locale}`, { phase, locale, ...fields }, expected);
    for (const started_at_ms of [0, 123.5]) {
      v('start', String(started_at_ms), { started_at_ms }, () => pure.videoGenerationStartPatch(started_at_ms));
      v('upscale_start', String(started_at_ms), { started_at_ms }, () => pure.videoUpscaleStartPatch(started_at_ms));
      a('start', String(started_at_ms), { started_at_ms }, () => pure.audioGenerationStartPatch(started_at_ms));
      add('text_generation_patch', `text-start-${started_at_ms}-${locale}`, { phase: 'start', locale, started_at_ms }, () => pure.textGenerationStartPatch(started_at_ms));
    }
    v('submit', '', {}, pure.videoGenerationSubmitPatch);
    for (const ref of [task, { task_key: '', task_type: '', job_id: '' }]) {
      v('accepted', ref.task_key, { task: ref }, () => pure.videoGenerationAcceptedPatch(ref));
      v('upscale_accepted', ref.task_key, { task: ref }, () => pure.videoUpscaleAcceptedPatch(ref));
      a('accepted', ref.task_key, { task: ref }, () => pure.audioGenerationAcceptedPatch(ref));
    }
    for (const info of [error, { ...error, referenceIssues: [issue] }, { ...error, status: null, details: null, requestId: null, message: '' }]) {
      v('failure', String(info.referenceIssues.length), { error: info }, () => pure.videoGenerationFailurePatch(info));
      a('voice_prerequisite', String(info.referenceIssues.length), { error: info }, () => pure.isAudioVoicePrerequisiteFailure(info));
    }
    a('voice_prerequisite', 'matching', { error: { ...error, message: 'missing custom voice' } }, () => pure.isAudioVoicePrerequisiteFailure({ ...error, message: 'missing custom voice' }));
    for (const outcome of [
      { kind: 'completed', result: { output_url: '/cat.mp4' }, fallbackUrl: null },
      { kind: 'completed', result: null, fallbackUrl: '/fallback.mp4' },
      { kind: 'completed', result: null, fallbackUrl: null },
      { kind: 'failed', error }, { kind: 'cancelled' }, { kind: 'poll_timeout' },
    ] satisfies pure.VideoGenerationRunOutcome[]) for (const run_index of [0, 1]) {
      const completed_urls = run_index ? ['/previous.mp4'] : [];
      v('run_outcome', `${outcome.kind}-${JSON.stringify(outcome)}-${run_index}`, { run_index, total: 2, completed_urls, outcome },
        async () => pure.videoGenerationRunOutcome({ runIndex: run_index, total: 2, completedUrls: completed_urls, outcome }, await t()));
    }
    for (const run_errors of [[], [{ kind: 'poll_timeout' }], [{ kind: 'failed', error }], [{ kind: 'failed', error: { ...error, referenceIssues: [issue] } }], [{ kind: 'poll_timeout' }, { kind: 'failed', error }]] satisfies pure.VideoGenerationRunError[][]) {
      for (const completed_urls of [[], ['/cat.mp4']]) v('settle', JSON.stringify({ run_errors, completed_urls }), { completed_urls, run_errors, total: 2, supports_human_review: true, human_review: false },
        async () => pure.videoGenerationSettleOutcome({ completedUrls: completed_urls, runErrors: run_errors, total: 2, supportsHumanReview: true, humanReview: false }, await t()));
    }
    for (const outcome of [{ kind: 'completed', result: { output_url: '/up.mp4' }, fallbackUrl: '' }, { kind: 'completed', result: null, fallbackUrl: '/fallback.mp4' }, { kind: 'failed', message: 'Failed' }, { kind: 'poll_timeout' }] satisfies pure.VideoUpscaleOutcome[]) v('upscale_outcome', JSON.stringify(outcome), { outcome }, () => pure.videoUpscaleOutcomePatch(outcome));
    for (const final_node_data of [undefined, null, {}, { videoUrl: '/old.mp4' }, { generationError: 'Failed', upscaleSourceUrl: '/source.mp4' }]) for (const execution_mode of [undefined, 'single']) {
      v('action_result', JSON.stringify({ final_node_data, execution_mode }), { final_node_data, execution_mode }, () => pure.videoGenerationActionResult(final_node_data, execution_mode));
      v('upscale_action_result', JSON.stringify({ final_node_data, execution_mode }), { final_node_data, execution_mode }, () => pure.videoUpscaleActionResult(final_node_data, execution_mode));
    }
    for (const code of ['not_video_node', 'no_model', 'no_project', 'generation_in_progress', 'no_effective_prompt', 'missing_media', 'reference_limit_exceeded', 'model_capability_error', 'inline_media_reference', 'missing_source_video', 'missing_references', 'mode_unsupported_by_model', 'extend_clip_not_prepared', 'missing_upscale_source'] as const) {
      for (const phase of ['guard', 'keyframes', 'images', 'source_video', 'references', 'unsupported_mode'] as const) {
        const refusal = { ok: false as const, code, message: 'Refused', startedAtMs: 123, phase, isHappyHorseModel: true };
        v('refusal', `${code}-${phase}`, { refusal }, async () => pure.videoGenerationRefusalOutcome(refusal, await t()));
      }
    }
    for (const kind of ['tooShort', 'tooLong', 'totalTooShort', 'totalTooLong'] as const) {
      const clips = [{ label: 'Clip', durationMs: 1000, nodeId: 'source', url: '/clip.wav', index: 1 }];
      const rejection = kind === 'tooShort' || kind === 'tooLong' ? { kind, clips } : { kind, clips, totalMs: 1000, limitMs: 2000 };
      const refusal: pure.VideoGenerationRefusalInput = { ok: false, code: 'reference_duration_invalid', message: 'Duration', media: 'audio', startedAtMs: 123, phase: 'duration', durationLimits: { minMs: 2000, maxMs: 5000 }, rejection };
      v('refusal', kind, { refusal }, async () => pure.videoGenerationRefusalOutcome(refusal, await t()));
    }
    for (const outcome of [{ kind: 'completed', url: '/cat.wav' }, { kind: 'completed', url: '' }, { kind: 'failed', message: '', isError: true, voicePrerequisite: false }, { kind: 'failed', message: 'missing voice', isError: false, voicePrerequisite: true }] satisfies pure.AudioGenerationOutcome[]) a('outcome', JSON.stringify(outcome), { outcome }, async () => pure.audioGenerationOutcomePatch({ outcome, translate: await t() }));
    for (const hook_output of [{ audioUrl: '/hook.wav' }, {}, { skipped: true, reason: 'missing_custom_voice' }]) for (const latest_node_data of [undefined, {}, { audioUrl: '/latest.wav' }]) a('action_result', JSON.stringify({ hook_output, latest_node_data }), { hook_output, latest_node_data }, () => pure.audioGenerationActionResult({ hookOutput: hook_output, latestNodeData: latest_node_data }));
    for (const voicePrerequisite of [false, true]) {
      const hook_error = { message: 'Failure', isError: true, voicePrerequisite };
      a('action_result', JSON.stringify(hook_error), { hook_error }, () => pure.audioGenerationActionResult({ hookError: hook_error, latestNodeData: undefined }));
    }
    for (const data of [{ audioKind: 'music', text: 'Piano', audioUrl: null }, { title: 'Background music', model: 'suno_music', text: 'Piano', audioUrl: null }, { audioKind: 'speech', text: '\u6839\u636e\u811a\u672c\u751f\u6210\u65c1\u767d\u914d\u97f3', audioUrl: '/old.wav' }] satisfies AudioNodeData[]) {
      a('repair', JSON.stringify(data), { node_data: data, now_iso: 'caller-time' }, () => pure.audioNodeRepairPatch(data, 'caller-time'));
    }
    for (const mode of ['deterministic', 'model', 'timeout_fallback'] as const) {
      const metadata = { ...compileMetadata, mode };
      v('compile_metadata', mode, { metadata, compiled_at: 'caller-time' }, () => pure.videoPromptCompileMetadataPatch(metadata, 'caller-time'));
      const p = audioPayload(); p.env.locale = locale;
      a('compile_metadata', mode, { ...p, metadata, compiled_at: 'caller-time' }, async () => pure.audioPromptCompileMetadataPatch(await audioContext(p), metadata, 'caller-time'));
    }
    for (const outcome of [{ kind: 'completed', content: 'Scene' }, { kind: 'completed', content: '' }, { kind: 'failed', message: '', isError: true }, { kind: 'failed', message: '42', isError: false }] satisfies pure.TextGenerationOutcome[]) add('text_generation_patch', `text-outcome-${JSON.stringify(outcome)}-${locale}`, { phase: 'outcome', locale, outcome }, () => pure.textGenerationOutcomePatch({ outcome }));
    const settledCases: pure.ImageGenerationSettledRun[][] = [[], [{ status: 'fulfilled', value: 'completed' }], [{ status: 'fulfilled', value: 'submitted' }], [{ status: 'fulfilled', value: 'ignored' }], [{ status: 'fulfilled', value: 'handled' }], [{ status: 'rejected', message: 'Failed' }]];
    for (const settled of settledCases) for (const completion_mode of ['completed', 'submitted'] as const) for (const completed_urls of [[], ['/cat.png']]) {
      const accepted_refs = completion_mode === 'submitted' ? [task] : [];
      const expected = async () => pure.imageGenerationSettleOutcome({ settled, completedUrls: completed_urls, acceptedRefs: accepted_refs, completionMode: completion_mode, translate: await t() });
      im('settle', JSON.stringify({ settled, completion_mode, completed_urls }), { settled, completed_urls, accepted_refs, completion_mode }, expected);
      const settle_outcome = await expected();
      im('action_result', JSON.stringify({ settled, settle_outcome }), { settled, settle_outcome }, () => pure.imageGenerationActionResult({ settled, settleOutcome: settle_outcome }));
    }
    im('action_result', 'thrown', { error_message: 'Thrown' }, () => pure.imageGenerationActionResult({ errorMessage: 'Thrown' }));
    for (const run_index of [0, 1]) for (const accepted_refs of [[], [task]]) im('run_accepted', `${run_index}-${accepted_refs.length}`, { run_index, accepted_refs, task }, () => pure.imageGenerationRunAccepted({ runIndex: run_index, acceptedRefs: accepted_refs, task }));
    for (const run_index of [0, 1]) for (const info of [undefined, error]) im('background_failure', `${run_index}-${Boolean(info)}`, { run_index, message: '', error: info }, async () => pure.imageGenerationBackgroundFailurePatch({ runIndex: run_index, message: '', error: info, translate: await t() }));
    const p = outcomePayload({ kind: 'failed', message: error.message, error }, locale);
    add('image_generation_patch', `image-outcome-error-${locale}`, p, async () => pure.imageGenerationOutcomePatch(await outcomeInput(p)));
  }
  return out;
}
export async function materializeFixtures() {
  const fixtures = [...requestFixtures(), ...await patchFixtures(), ...errorFixtures()];
  return fixtures;
}
export function errorFixtures(): Fixture[] {
  const failures: pure.GenerationSubmitFailure[] = [
    { kind: 'http', status: 500, statusText: 'Failure', method: 'POST', url: 'https://example.test/generate' },
    ...[null, '', { error: 'content_policy_violation', request_id: 'req-1' }, { detail: { code: 'REFERENCE_MEDIA_INVALID', errors: [issue] } }].map(body => ({ kind: 'http' as const, status: 422, statusText: '', method: 'POST', url: 'https://example.test/generate', body })),
    { kind: 'envelope', body: { ok: false, error: 'Failed' } }, { kind: 'envelope', body: false },
    { kind: 'thrown', name: 'TypeError', message: 'Failed' }, { kind: 'thrown', name: 'Error', message: '' },
  ];
  return failures.flatMap(failure => ['en', 'zh'].map(locale => ({ name: `error-${failure.kind}-${JSON.stringify(failure)}-${locale}`, op: 'generation_error_describe', payload: { locale, failure, fallback_message: 'Fallback' }, expected: async () => pure.describeGenerationSubmitFailure(failure, await createServerTranslate(locale), 'Fallback') })));
}
export async function imageInlineFixture() {
  const p = imageRequest(true); p.canvas.nodes[1].data.imageUrl = 'data:image/png;base64,AA==';
  const ctx = imageContext(p);
  return { payload: p, expected: { compile_input: pure.imagePromptCompileInput(ctx), request: pure.buildImageGenerationRequest({ ...ctx, prompt: 'A cat' }) } };
}
