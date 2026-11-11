// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterAll, describe, expect, it } from 'vitest';
import * as patches from '@/features/canvas/application/generationRequests';
import type { ImageGenerationOutcome, ImageGenerationEffect } from '@/features/canvas/application/generationRequests';
import type { GenerationSubmitFailure } from '@/features/canvas/application/generationRequests/generationSubmitError';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import type { ModelOption } from '@/features/canvas/domain/modelOptions';
import { humanizeTaskError } from '@/features/canvas/domain/taskErrorText';
import { extractRequestId } from '@/features/canvas/domain/generationRequestId';
import { assertCaptureCoverage, assertObserved, expectedEntries, translate, errorTranslate } from './imageGenerationTestKit';

const catalog: ModelOption[] = [{
  id: 'openai/test-image', providerId: 'openai', apiModel: 'test-image-api', label: 'Test image',
}];
const startedAt = Date.parse('2026-11-11T04:05:06Z');
function ref(index = 0) {
  return { task_key: `task-${index}`, task_type: 'freezone_gen' as const, job_id: `job-${index}` };
}
function imageNode(data: Record<string, unknown> = {}): CanvasNode {
  return {
    id: 'img-1', type: CANVAS_NODE_TYPES.imageGen, position: { x: 0, y: 0 },
    data: {
      displayName: 'Image', prompt: 'A cat', model: catalog[0].id, aspectRatio: '16:9',
      size: '2K', count: 1, imageUrl: null, previewImageUrl: null,
      isGenerating: false, generationStartedAt: null,
      isSizeManuallyAdjusted: false, requestAspectRatio: 'auto', styleTemplateId: null,
      focusRegion: null, cameraSelection: null, referenceImageUrl: null, marks: [],
      generationDurationMs: 60000, ...data,
    },
  };
}
function derive(nodeData: Record<string, unknown>, outcome: ImageGenerationOutcome, overrides: Partial<patches.ImageGenerationOutcomeInput> = {}) {
  return patches.imageGenerationOutcomePatch({
    nodeId: 'img-1', nodeData, taskKey: ref().task_key, firstAcceptedTask: ref(),
    runIndex: 0, total: 1, completedUrls: [], attachStoryFrame: false,
    outcome, translate, ...overrides,
  });
}
const singleSuccess = {
  imageUrl: '/static/a.png', previewImageUrl: '/static/a.png', isGenerating: false,
  generationStartedAt: null, generationTaskKey: null, generationTaskType: null,
  generationTaskJobId: null, generationError: null, generationErrorDetails: null,
  generationErrorRequestId: null,
};
type Fixture = {
  name: string; outcome: ImageGenerationOutcome; data?: Record<string, unknown>;
  attach?: boolean; stale?: boolean; rejectSubmit?: boolean; rejectFallback?: boolean; literal?: Record<string, unknown>;
};
const fixtures: Fixture[] = [
  { name: 'success single workflow', outcome: { kind: 'completed', result: { output_url: '/static/a.png' } }, literal: singleSuccess },
  { name: 'workflow count three', data: { count: 3 }, outcome: { kind: 'completed', result: { output_urls: ['/static/a.png', '/static/b.png', '/static/c.png'] } } },
  { name: 'fallback URL', outcome: { kind: 'completed', result: null, fallbackUrl: '/static/fallback.png' } },
  { name: 'no URL or fallback', outcome: { kind: 'completed', result: {} } },
  { name: 'fallback fetch fails', rejectFallback: true, outcome: { kind: 'completed', result: null } },
  { name: 'submit rejected', rejectSubmit: true, outcome: { kind: 'failed', message: 'Submit rejected' } },
  { name: 'empty task failure', outcome: { kind: 'failed', message: '' } },
  { name: 'empty compile failure', outcome: { kind: 'compile_failed', message: '' } },
  { name: 'stale success still writes', stale: true, outcome: { kind: 'completed', result: { url: '/static/a.png' } } },
  { name: 'stale missing URL resets loading before catch', stale: true, outcome: { kind: 'completed', result: null } },
  { name: 'stale cancellation with media resets loading first', stale: true, data: { previewImageUrl: '/static/old.png' }, outcome: { kind: 'cancelled', message: 'Stopped' } },
  { name: 'plain failure', outcome: { kind: 'failed', message: 'Rendering failed' } },
  { name: 'failure with request id', outcome: { kind: 'failed', message: 'Rendering failed request_id=req-123' }, literal: {
    isGenerating: false, generationStartedAt: null,
    generationError: 'Rendering failed request_id=req-123',
    generationErrorDetails: 'Rendering failed request_id=req-123', generationErrorRequestId: 'req-123',
  } },
  { name: 'content policy failure', outcome: { kind: 'failed', message: 'content_policy_violation' } },
  { name: 'cancelled with media', data: { imageUrl: '/static/old.png' }, outcome: { kind: 'cancelled', message: 'Stopped' },
    literal: { isGenerating: false, generationStartedAt: null } },
  { name: 'cancelled without media', outcome: { kind: 'cancelled', message: 'Stopped' } },
  { name: 'stale task failure', stale: true, outcome: { kind: 'failed', message: 'Late failure' } },
  { name: 'reference issues on submit', outcome: { kind: 'reference_invalid', message: 'Invalid reference' } },
  { name: 'compile failure preserves previous album', data: { generationBatch: ['/static/old.png'] }, outcome: { kind: 'compile_failed', message: 'Compile failed request_id=compile-1' } },
  { name: 'auto commit success', data: { autoCommitOnGenerate: true, preset_managed: true, count: 3 }, outcome: { kind: 'completed', result: { output_url: '/static/a.png' } } },
  { name: 'story frame success', attach: true, data: { storyFrameTarget: { nodeId: 'video-1', role: 'first_frame' } }, outcome: { kind: 'completed', result: { output_url: '/static/a.png' } } },
];
const manualFixtures = [
    { name: 'run 1 completes, run 0 completes, run 2 fails', order: [1, 0, 2], kinds: ['completed', 'completed', 'failed'], urls: ['/static/1.png', '/static/0.png'] },
    { name: 'secondary failure before success', order: [1, 0, 2], kinds: ['completed', 'failed', 'completed'], urls: ['/static/0.png', '/static/2.png'] },
    { name: 'secondary missing URL before success', order: [1, 0, 2], kinds: ['completed', 'missing', 'completed'], urls: ['/static/0.png', '/static/2.png'] },
    { name: 'run 1 accepted before run 0', secondaryAcceptedFirst: true, order: [1, 0, 2], kinds: ['completed', 'completed', 'failed'], urls: ['/static/1.png', '/static/0.png'] },
    { name: 'duplicate completion URLs', order: [1, 0, 2], kinds: ['duplicate', 'completed', 'failed'], urls: ['/static/1.png'] },
  ];
function accept(expected: Record<string, unknown>, refs: patches.ImageGenerationTaskRef[], index: number, task = ref(index)) {
  const input = { runIndex: index, acceptedRefs: refs, task };
  const before = structuredClone(input);
  const accepted = patches.imageGenerationRunAccepted(input);
  expect(input).toStrictEqual(before);
  return {
    expected: accepted.action === 'accepted' && accepted.applyPatch
      ? { ...expected, ...patches.imageGenerationAcceptedPatch(task) } : expected,
    refs: accepted.acceptedRefs,
    accepted,
  };
}
function settle(settled: patches.ImageGenerationSettledRun[], urls: string[], refs: patches.ImageGenerationTaskRef[], completionMode: 'completed' | 'submitted' = 'completed') {
  const input = { settled, completedUrls: urls, acceptedRefs: refs, completionMode, translate };
  const before = { ...structuredClone({ settled, completedUrls: urls, acceptedRefs: refs, completionMode }), translate };
  const outcome = patches.imageGenerationSettleOutcome(input);
  expect(input).toStrictEqual(before);
  return outcome;
}
function complete(expected: Record<string, unknown>, refs: patches.ImageGenerationTaskRef[], urls: string[], index: number, total: number, outcome: ImageGenerationOutcome) {
  const pure = patches.imageGenerationOutcomePatch({ nodeId: 'img-1', nodeData: expected,
    taskKey: ref(index).task_key, firstAcceptedTask: refs[0] ?? null, runIndex: index, total,
    completedUrls: urls, attachStoryFrame: false, outcome, translate });
  return pure.action === 'write'
    ? { expected: { ...expected, ...pure.patch }, urls: pure.completedUrls }
    : { expected, urls };
}
function returned(outcome: patches.ImageGenerationSettleOutcome) {
  if (outcome.kind === 'output') return outcome.output;
  if (outcome.kind === 'undefined') return undefined;
  throw new Error('Expected a returned settle result');
}

const backgroundFixtures = [
  { name: 'submitted count 1 background success', count: 1, order: [0], failures: [] },
  { name: 'submitted count 2 background success', count: 2, order: [1, 0], failures: [] },
  { name: 'submitted run 0 background failure', count: 2, order: [0, 1], failures: [0] },
  { name: 'submitted run 1 background failure before success', count: 2, order: [1, 0], failures: [1] },
  { name: 'submitted run 1 background failure after success', count: 2, order: [0, 1], failures: [1] },
  { name: 'submitted background insufficient credits', count: 1, order: [0], failures: [0], credits: true },
  { name: 'submitted stale cancellation with previous media still writes', count: 1, order: [0], failures: [0], stale: true },
  { name: 'submitted reference failure still writes raw error', count: 1, order: [0], failures: [0], reference: true },
  { name: 'submitted empty Error message uses name', count: 1, order: [0], failures: [0], empty: true },
];
const fallback = 'Generation failed';
const http = (status: number, body?: unknown): GenerationSubmitFailure => ({
  kind: 'http', status, statusText: '', method: 'POST',
  url: 'https://canvas.example/api/v1/projects/demo/freezone/gen', body,
});
const submitErrorFixtures: { name: string; failure: GenerationSubmitFailure }[] = [
  { name: 'insufficient credits with message', failure: http(402, { error: 'Add credits' }) },
  { name: 'insufficient credits without message', failure: http(402) },
  { name: 'billing rule', failure: http(400, { error: 'No billing rule', data: { error_code: 'BILLING_RULE_NOT_CONFIGURED' } }) },
  { name: 'queue default', failure: http(429, { data: { queue_kind: 'default' } }) },
  { name: 'queue video project', failure: http(429, { data: { queue_kind: 'video', limit_scope: 'project' } }) },
  { name: 'queue video user', failure: http(429, { data: { queue_kind: 'video', limit_scope: 'user' } }) },
  { name: 'backend request id', failure: http(400, { error: 'Submit failed request_id=req-123' }) },
  { name: 'envelope failure', failure: { kind: 'envelope', body: { ok: false, error: 'Rejected envelope' } } },
  { name: 'envelope empty message', failure: { kind: 'envelope', body: { ok: false, error: '' } } },
  { name: 'reference invalid', failure: http(422, { detail: {
    code: 'REFERENCE_MEDIA_INVALID', message: 'Invalid reference',
    errors: [{ media: 'image', index: 1, name: 'Reference', code: 'missing', reference_key: 'ref.png' }],
  } }) },
];
const prefix = 'https://canvas.example/api/v1';
const path = 'projects/demo/freezone/gen';
const url = `${prefix}/${path}`;
type SubmitFailureFixture = { name: string; status: number; statusText?: string; body?: unknown; raw?: string; contentType?: string };
const submitFailureFixtures: SubmitFailureFixture[] = [
  { name: '402 empty body', status: 402, raw: '' },
  { name: '402 JSON body', status: 402, body: { error: 'Balance too low' } },
  { name: 'nested insufficient credits code', status: 400, body: { detail: { nested: { error_code: 'INSUFFICIENT_CREDITS', message: 'Add credits' } } } },
  { name: 'billing rule code', status: 400, body: { data: { error_code: 'BILLING_RULE_NOT_CONFIGURED' }, error: 'No billing rule' } },
  { name: 'legacy billing rule message', status: 400, body: { error: 'billing rule is not configured' } },
  { name: '500 legacy insufficient credits', status: 500, body: { error: 'insufficient credits' } },
  ...['default', 'image', 'video'].flatMap(queueKind =>
    [undefined, 'project', 'user', 'channel', 'platform', 'global_lane_queue', 'unknown_scope'].map(scope => ({
      name: `429 ${queueKind} scope ${scope ?? 'absent'}`, status: 429,
      body: { error: 'Queue rejected', data: { queue_kind: queueKind, ...(scope === undefined ? {} : { limit_scope: scope }) } },
    }))),
  { name: '400 request id', status: 400, body: { error: 'Submit failed request_id=req-123' } },
  { name: '422 string detail', status: 422, body: { detail: 'Invalid input' } },
  { name: '422 detail message and hint', status: 422, body: { detail: { message: 'Invalid input', user_action_hint: 'Choose another image' } } },
  { name: '422 reference valid and invalid items', status: 422, body: { detail: { code: 'REFERENCE_MEDIA_INVALID', errors: [
    { media: 'image', index: 1, name: 'Image', code: 'missing', reference_key: 'ref.png' },
    null, {}, { media: 'image', index: '1', code: 'missing', reference_key: 'bad.png' },
    { media: 'image', index: 2, code: 9, reference_key: 'bad.png' },
    { media: 'image', index: 2, code: 'missing' },
    { index: 2, code: 'missing', reference_key: 'bad.png' },
  ] } } },
  { name: '500 plain text', status: 500, raw: 'Upstream unavailable', body: 'Upstream unavailable', contentType: 'text/plain' },
  { name: '502 empty body', status: 502, raw: '', statusText: 'Bad Gateway' },
  { name: 'invalid JSON body', status: 500, raw: '{broken' },
  { name: 'JSON null body', status: 500, body: null },
  { name: 'JSON subtype body', status: 400, body: { error: 'Problem' }, contentType: 'application/problem+json; charset=utf-8' },
  { name: 'non-JSON JSON-looking text', status: 500, raw: '{"error":"Text only"}', body: '{"error":"Text only"}', contentType: 'text/plain' },
  { name: 'HTTP empty error string', status: 400, body: { error: '' } },
  { name: 'envelope error', status: 200, body: { ok: false, error: 'Rejected envelope' } },
  { name: 'envelope missing error', status: 200, body: { ok: false } },
  { name: 'envelope empty error', status: 200, body: { ok: false, error: '' } },
];

describe('image generation result literals', () => {
  it.each(fixtures)('$name', fixture => {
    const { outcome } = fixture;
    const initial = imageNode(fixture.data ?? {}).data;
    const compileFailed = outcome.kind === 'compile_failed';
    let node = { ...initial, ...(compileFailed
      ? patches.imageGenerationStartPatch(startedAt) : patches.imageGenerationSubmitPatch(startedAt)) };
    const accepted = !compileFailed && outcome.kind !== 'reference_invalid' && !fixture.rejectSubmit;
    if (accepted) {
      node = { ...node, ...patches.imageGenerationAcceptedPatch(ref()) };
      if (fixture.stale) node.generationTaskKey = 'replacement';
    }
    const before = structuredClone(node);
    const pure = derive(node, outcome, {
      taskKey: accepted ? ref().task_key : null, firstAcceptedTask: accepted ? ref() : null,
      total: fixture.data?.count === 3 && !fixture.data?.autoCommitOnGenerate ? 3 : 1,
      attachStoryFrame: fixture.attach ?? false,
    });
    expect(node).toStrictEqual(before);
    if (pure.action === 'write' && fixture.literal) expect(pure.patch).toStrictEqual(fixture.literal);
    assertObserved(`result/${fixture.name}`, {
      nodes: [pure.action === 'write' ? { ...node, ...pure.patch } : node],
      output: pure.action === 'write' ? pure.output : undefined,
      errorMessage: pure.action === 'write' ? pure.error?.message : undefined,
      effects: pure.action === 'write' ? pure.effects : [],
    });
  });
  it.each(manualFixtures)('manual count three: $name', ({ name, order, kinds, urls, secondaryAcceptedFirst }) => {
    let node = { ...imageNode({ count: 3 }).data, ...patches.imageGenerationSubmitPatch(startedAt),
      ...(secondaryAcceptedFirst ? patches.imageGenerationAcceptedPatch(ref(1)) : {}),
      ...patches.imageGenerationAcceptedPatch(ref()),
    };
    let completedUrls: string[] = [];
    const effects: ImageGenerationEffect[] = [];
    const nodes: Record<string, unknown>[] = [];
    let output: unknown;
    for (const index of order) {
      const outcome: ImageGenerationOutcome = kinds[index] === 'failed' ? { kind: 'failed', message: 'Run failed' }
        : { kind: 'completed', result: kinds[index] === 'missing' ? {} : { output_url: `/static/${kinds[index] === 'duplicate' ? 1 : index}.png` } };
      const before = structuredClone({ node, completedUrls });
      const pure = derive(node, outcome, {
        runIndex: index, total: 3, taskKey: ref(index).task_key,
        firstAcceptedTask: ref(secondaryAcceptedFirst ? 1 : 0), completedUrls, attachStoryFrame: true,
      });
      expect({ node, completedUrls }).toStrictEqual(before);
      if (pure.action === 'write') {
        node = { ...node, ...pure.patch };
        completedUrls = pure.completedUrls;
        effects.push(...pure.effects);
        output = pure.output;
      }
      nodes.push(node);
    }
    expect(completedUrls).toStrictEqual(urls);
    assertObserved(`result/manual count three: ${name}`, { nodes, output, effects });
  });
});

describe('pure lifecycle literal values', () => {
  it('writes submit fields and the accepted descriptor', () => {
    expect(patches.imageGenerationSubmitPatch(123)).toStrictEqual({
      isGenerating: true, generationStartedAt: 123, generationError: null,
      generationErrorDetails: null, generationErrorRequestId: null, generationBatch: null,
    });
    expect(patches.imageGenerationAcceptedPatch(ref())).toStrictEqual({
      generationTaskKey: 'task-0', generationTaskType: 'freezone_gen', generationTaskJobId: 'job-0',
    });
  });
  it('retains a handled batch before reference and stale checks', () => {
    const input = {
      nodeId: 'img-1', nodeData: { generationTaskKey: 'replacement' }, taskKey: 'old',
      firstAcceptedTask: ref(), runIndex: 0, total: 3, completedUrls: ['/static/first.png'],
      attachStoryFrame: true, outcome: { kind: 'reference_invalid', message: 'Invalid reference' },
      translate,
    } satisfies patches.ImageGenerationOutcomeInput;
    const before = { ...input, completedUrls: [...input.completedUrls] };
    expect(patches.imageGenerationOutcomePatch(input)).toStrictEqual({
      action: 'write', patch: {}, completedUrls: ['/static/first.png'], effects: [],
      output: { ...ref(), imageUrl: '/static/first.png', imageUrls: ['/static/first.png'] },
    });
    expect(input).toStrictEqual(before);
  });
  it('does not apply run-0 arbitration or loading reset to a secondary failure', () => {
    expect(derive({ generationTaskKey: 'task-0' }, { kind: 'failed', message: 'Secondary failed' }, {
      taskKey: 'task-1', runIndex: 1,
    })).toStrictEqual({
      action: 'write', patch: { generationError: 'Secondary failed', generationErrorDetails: 'Secondary failed', generationErrorRequestId: null },
      completedUrls: [], effects: [], error: { message: 'Secondary failed' },
    });
  });
  it('ignores stale run 0, cancelled secondary run with media, and duplicate URLs', () => {
    expect(derive({ generationTaskKey: 'new' }, { kind: 'failed', message: 'Old' })).toStrictEqual({ action: 'ignore' });
    expect(derive({ imageUrl: '/old.png' }, { kind: 'cancelled', message: 'Stopped' }, { runIndex: 1 })).toStrictEqual({ action: 'ignore' });
    expect(derive({}, { kind: 'completed', result: { url: '/a.png' } }, { completedUrls: ['/a.png'] })).toStrictEqual({ action: 'ignore' });
  });
});

describe('image settlement literals', () => {
  it.each([
    { name: 'count 1 completed', count: 1, fail: false, cancelled: false },
    { name: 'workflow batch variants single submit', count: 3, fail: false, cancelled: false },
    { name: 'subscriber thrown error', count: 1, fail: true, cancelled: false },
    { name: 'subscriber ignored cancellation publishes success without output', count: 1, fail: false, cancelled: true },
  ])('$name', ({ name, count, fail, cancelled }) => {
    const initial = imageNode({ count, ...(cancelled ? { imageUrl: '/static/old.png' } : {}) }).data;
    const a = accept({ ...initial, ...patches.imageGenerationSubmitPatch(startedAt) }, [], 0);
    const urls = count === 1 ? ['/static/0.png'] : ['/static/0.png', '/static/1.png', '/static/2.png'];
    const message = 'Task failed request_id=req-sub';
    const applied = complete(a.expected, a.refs, [], 0, count, cancelled ? { kind: 'cancelled', message } : fail
      ? { kind: 'failed', message } : { kind: 'completed', result: { output_urls: urls } });
    const settled: patches.ImageGenerationSettledRun[] = fail ? [{ status: 'rejected', message }]
      : [{ status: 'fulfilled', value: cancelled ? 'ignored' : 'completed' }];
    const outcome = settle(settled, applied.urls, a.refs);
    assertObserved(`settle/${name}`, {
      nodes: [a.expected, applied.expected],
      published: patches.imageGenerationActionResult({ settleOutcome: outcome, settled }),
    });
    if (fail) assertObserved(`settle/${name}`, {
      published: patches.imageGenerationActionResult({ errorMessage: message }),
    });
  });

  it('workflow batch variants forces completed despite submitted request', () => {
    const accepted = accept({ ...imageNode({ count: 3 }).data, ...patches.imageGenerationSubmitPatch(startedAt) }, [], 0);
    const urls = ['/static/a.png', '/static/b.png', '/static/c.png'];
    const applied = complete(accepted.expected, accepted.refs, [], 0, 3, { kind: 'completed', result: { output_urls: urls } });
    assertObserved('settle/workflow batch variants forces completed despite submitted request', {
      nodes: [applied.expected],
      output: returned(settle([{ status: 'fulfilled', value: 'completed' }], urls, accepted.refs)),
    });
  });

  it.each([
    { name: 'count 3 failure after success', stale: false, allFail: false, order: [1, 2, 0] },
    { name: 'count 3 all fail in different rejection order', stale: false, allFail: true, order: [2, 1, 0] },
    { name: 'all runs ignored after invalidation', stale: true, allFail: false, order: [2, 0, 1] },
  ])('$name', ({ name, stale, allFail, order }) => {
    let expected = { ...imageNode({ count: 3 }).data, ...patches.imageGenerationSubmitPatch(startedAt) };
    let refs: patches.ImageGenerationTaskRef[] = [];
    for (const index of [0, 1, 2]) ({ expected, refs } = accept(expected, refs, index));
    const nodes = [expected];
    let urls: string[] = [];
    const settled: patches.ImageGenerationSettledRun[] = [];
    for (const index of order) {
      const failed = allFail || index === 2;
      const message = `Run ${index} failed`;
      if (!stale) ({ expected, urls } = complete(expected, refs, urls, index, 3,
        failed ? { kind: 'failed', message } : { kind: 'completed', result: { url: `/static/${index}.png` } }));
      settled[index] = stale ? { status: 'fulfilled', value: 'ignored' }
        : failed && urls.length === 0 ? { status: 'rejected', message }
        : { status: 'fulfilled', value: failed ? 'handled' : 'completed' };
      nodes.push(expected);
    }
    const outcome = settle(settled, urls, refs);
    let output: unknown;
    let thrown: string | undefined;
    if (outcome.kind === 'rethrow') {
      expect(outcome.runIndex).toStrictEqual(0);
      const failure = settled[outcome.runIndex];
      thrown = failure.status === 'rejected' ? failure.message : undefined;
    } else output = returned(outcome);
    assertObserved(`settle/${name}`, { nodes, output, thrown });
  });

  it.each(backgroundFixtures)('$name', fixture => {
    let expected = { ...imageNode({ count: fixture.count, ...(fixture.stale ? { imageUrl: '/static/old.png' } : {}) }).data,
      ...patches.imageGenerationSubmitPatch(startedAt) };
    let refs: patches.ImageGenerationTaskRef[] = [];
    for (let index = 0; index < fixture.count; index++) ({ expected, refs } = accept(expected, refs, index));
    const outcome = settle(refs.map(() => ({ status: 'fulfilled', value: 'submitted' })), [], refs, 'submitted');
    const nodes = [expected];
    if (fixture.stale) expected = { ...expected, generationTaskKey: 'replacement' };
    let urls: string[] = [];
    for (const index of fixture.order) {
      const failure: GenerationSubmitFailure = fixture.credits
        ? http(402, { error: 'Insufficient credits request_id=req-credit' })
        : fixture.reference ? http(422, { detail: { code: 'REFERENCE_MEDIA_INVALID', message: 'Reference failed', errors: [{ media: 'image', index: 1, name: 'Reference', code: 'missing', reference_key: 'ref.png' }] } })
        : { kind: 'thrown', name: fixture.stale ? 'TaskCompletionError' : 'Error',
          message: fixture.stale ? 'Stopped request_id=req-stop' : fixture.empty ? '' : `Background ${index} request_id=req-${index}` };
      const error = patches.generationErrorFromSubmitFailure(failure);
      if (fixture.failures.includes(index)) {
        const info = patches.describeGenerationError(error, translate, 'Fallback');
        expected = { ...expected, ...patches.imageGenerationBackgroundFailurePatch({ runIndex: index, message: error.message, error: info, translate }) };
        if (fixture.credits) expect(info.display).toStrictEqual('translated:common.insufficientCredits');
      } else ({ expected, urls } = complete(expected, refs, urls, index, fixture.count, { kind: 'completed', result: { url: `/static/${index}.png` } }));
      nodes.push(expected);
    }
    assertObserved(`settle/${fixture.name}`, { nodes, output: returned(outcome) });
  });

  it('duplicate task key returned by two submits', () => {
    const first = accept({ ...imageNode({ count: 2 }).data, ...patches.imageGenerationSubmitPatch(startedAt) }, [], 0);
    const duplicate = accept(first.expected, first.refs, 1, ref());
    expect(duplicate.accepted).toStrictEqual({ action: 'handled', acceptedRefs: [ref()] });
    const applied = complete(duplicate.expected, duplicate.refs, [], 0, 2, { kind: 'completed', result: { url: '/static/a.png' } });
    assertObserved('settle/duplicate task key returned by two submits', {
      nodes: [applied.expected],
      output: returned(settle([{ status: 'fulfilled', value: 'completed' }, { status: 'fulfilled', value: 'handled' }], applied.urls, first.refs)),
    });
  });

  it('run 1 accepted before run 0 keeps acceptance order but run 0 owns descriptor', () => {
    let expected = { ...imageNode({ count: 2 }).data, ...patches.imageGenerationSubmitPatch(startedAt) };
    let refs: patches.ImageGenerationTaskRef[] = [];
    const nodes: Record<string, unknown>[] = [];
    for (const index of [1, 0]) {
      ({ expected, refs } = accept(expected, refs, index));
      nodes.push(expected);
    }
    let urls: string[] = [];
    for (const index of [0, 1]) {
      ({ expected, urls } = complete(expected, refs, urls, index, 2, { kind: 'completed', result: { url: `/static/${index}.png` } }));
    }
    nodes.push(expected);
    const outcome = settle([0, 1].map(() => ({ status: 'fulfilled', value: 'completed' })), urls, refs);
    assertObserved('settle/run 1 accepted before run 0 keeps acceptance order but run 0 owns descriptor', { nodes, output: returned(outcome) });
  });

  it('duplicate task plus ignored cancellation reaches no_result', () => {
    const first = accept({ ...imageNode({ count: 2, imageUrl: '/static/old.png' }).data, ...patches.imageGenerationSubmitPatch(startedAt) }, [], 0);
    const duplicate = accept(first.expected, first.refs, 1, ref());
    expect(duplicate.accepted.action).toStrictEqual('handled');
    const cancelled = complete(first.expected, first.refs, [], 0, 2, { kind: 'cancelled', message: 'Stopped' });
    const settled: patches.ImageGenerationSettledRun[] = [{ status: 'fulfilled', value: 'ignored' }, { status: 'fulfilled', value: 'handled' }];
    const outcome = settle(settled, [], first.refs);
    if (outcome.kind !== 'no_result') throw new Error('Expected no_result');
    const message = expectedEntries['settle/duplicate task plus ignored cancellation reaches no_result'].thrown;
    expect(outcome).toStrictEqual({ kind: 'no_result', error: { message }, patch: {
      isGenerating: false, generationStartedAt: null, generationTaskKey: null,
      generationTaskType: null, generationTaskJobId: null, generationError: message,
      generationErrorDetails: message, generationErrorRequestId: null,
    } });
    assertObserved('settle/duplicate task plus ignored cancellation reaches no_result', {
      thrown: outcome.error.message, nodes: [{ ...cancelled.expected, ...outcome.patch }],
    });
    expect(patches.imageGenerationActionResult({ settleOutcome: outcome, settled })).toStrictEqual({ status: 'error', error: message });
    expect(settle([], [], [])).toStrictEqual(outcome);
  });
});

describe('pure aggregate protocol edges', () => {
  it('URLs win over rejection; rejection wins over submitted handles', () => {
    const settled: patches.ImageGenerationSettledRun[] = [{ status: 'rejected', message: 'First' }];
    const output = settle(settled, ['/a.png'], []);
    expect(output).toStrictEqual({ kind: 'output', output: { imageUrl: '/a.png', imageUrls: ['/a.png'] } });
    expect(settle(settled, [], [ref()], 'submitted')).toStrictEqual({ kind: 'rethrow', runIndex: 0 });
  });
  it('undefined publishes success without output and thrown values preserve caller text', () => {
    const settled: patches.ImageGenerationSettledRun[] = [{ status: 'fulfilled', value: 'ignored' }];
    const outcome = settle(settled, [], []);
    expect(outcome).toStrictEqual({ kind: 'undefined' });
    expect(patches.imageGenerationActionResult({ settleOutcome: outcome, settled })).toStrictEqual({ status: 'success' });
    expect(patches.imageGenerationActionResult({ errorMessage: 'raw thrown value' })).toStrictEqual({ status: 'error', error: 'raw thrown value' });
    const submitted = settle([{ status: 'fulfilled', value: 'submitted' }], [], [ref()], 'submitted');
    expect(patches.imageGenerationActionResult({ settleOutcome: submitted, settled: [] })).toStrictEqual({ status: 'success', output: returned(submitted) });
  });
  it('background fallback without error info preserves empty-message diagnostics', () => {
    expect(patches.imageGenerationBackgroundFailurePatch({ runIndex: 1, message: '', translate })).toStrictEqual({
      generationError: 'translated:common.error', generationErrorDetails: 'Error', generationErrorRequestId: null,
    });
  });
});

describe('image submit error literals', () => {
  it.each(submitErrorFixtures)('$name', fixture => {
    const error = patches.generationErrorFromSubmitFailure(fixture.failure);
    const info = patches.describeGenerationError(error, errorTranslate, fallback);
    const beforeOutcome = { ...imageNode().data, ...patches.imageGenerationStartPatch(startedAt), ...patches.imageGenerationSubmitPatch(startedAt) };
    const pure = derive(beforeOutcome, info.referenceIssues.length > 0
      ? { kind: 'reference_invalid', message: error.message }
      : { kind: 'failed', message: error.message, error: info }, {
      taskKey: null, firstAcceptedTask: null, translate: errorTranslate,
    });
    expect(pure.action).toBe('write');
    if (pure.action !== 'write') throw new Error('Expected failure patch');
    expect(pure.error).toStrictEqual({ message: error.message });
    assertObserved(`submitError/${fixture.name}`, {
      nodes: [{ ...beforeOutcome, ...pure.patch }], effects: pure.effects,
      error: { name: error.name, message: pure.error?.message, status: Reflect.get(error, 'status') },
    });
    if (info.referenceIssues.length === 0) {
      expect(pure.patch).toStrictEqual({
        isGenerating: false, generationStartedAt: null, generationError: info.display,
        generationErrorDetails: error.message || String(error),
        generationErrorRequestId: extractRequestId(error.message || String(error)),
      });
    }
    const previous = derive(beforeOutcome, { kind: 'failed', message: error.message }, {
      taskKey: null, firstAcceptedTask: null, translate: errorTranslate,
    });
    expect(previous).toStrictEqual({
      action: 'write', patch: {
        isGenerating: false, generationStartedAt: null,
        generationError: humanizeTaskError(error.message, errorTranslate),
        generationErrorDetails: error.message || 'Error',
        generationErrorRequestId: extractRequestId(error.message || 'Error'),
      }, completedUrls: [], effects: [], error: { message: error.message },
    });
  });
});

function assertFailure(name: string, failure: GenerationSubmitFailure) {
  const error = patches.generationErrorFromSubmitFailure(failure);
  assertObserved(`submitFailure/${name}`, {
    error: Object.fromEntries(['name', 'message', 'status', 'body', 'queueKind', 'limitScope']
      .map(key => [key, Reflect.get(error, key)])),
    description: patches.describeGenerationError(error, errorTranslate, fallback),
  });
  assertObserved(`submitFailure/${name}`, {
    description: patches.describeGenerationSubmitFailure(failure, errorTranslate, fallback),
  });
}
describe('submit failure reconstruction literals', () => {
  it.each(submitFailureFixtures)('$name', fixture => {
    const failure: GenerationSubmitFailure = fixture.status === 200
      ? { kind: 'envelope', body: fixture.body }
      : { kind: 'http', status: fixture.status, statusText: fixture.statusText ?? '', method: 'POST', url,
        ...(fixture.body === undefined ? {} : { body: fixture.body }) };
    assertFailure(fixture.name, failure);
  });
  it('network failure from fetch TypeError', () => {
    assertFailure('network failure from fetch TypeError', {
      kind: 'thrown', name: 'NetworkError', message: `Request failed due to a network error: POST ${url}`,
    });
  });
  it('timeout from a pending fetch', () => {
    assertFailure('timeout from a pending fetch', {
      kind: 'thrown', name: 'TimeoutError', message: `Request timed out: POST ${url}`,
    });
  });
});

afterAll(() => assertCaptureCoverage(['result', 'settle', 'submitError', 'submitFailure']));
