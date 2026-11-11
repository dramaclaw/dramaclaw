// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FreezoneRecipeCompileMetadata } from '@/api/ops';
import { CANVAS_NODE_TYPES, type AudioNodeData, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  audioPromptCompileInput, audioPromptCompileMetadataPatch,
  buildAudioGenerationRequest, type AudioGenerationRequestContext,
} from '@/features/canvas/application/generationRequests/audioGenerationRequest';
import {
  audioGenerationStartPatch, audioGenerationAcceptedPatch, audioGenerationOutcomePatch,
  audioGenerationActionResult, audioGenerationHookError, isAudioVoicePrerequisiteFailure,
  type AudioGenerationHookOutput, type AudioGenerationHookError,
} from '@/features/canvas/application/generationRequests/audioGenerationResult';
import { collectImportGraph } from './importGraph';
import expected from './audioGenerationExpected.json';
import { TaskCompletionError, TaskPollTimeoutError } from '@/api/tasks';
import { describeGenerationError, generationErrorFromSubmitFailure, type GenerationSubmitFailure } from '@/features/canvas/application/generationRequests/generationSubmitError';
import { isVoicePrerequisiteError } from '@/features/canvas/nodes/audioVoicePrerequisite';

const translate = (key: string) => key;
const ISO = '2009-02-13T23:31:30.000Z';
function exact(actual: unknown, captured: unknown) {
  expect(actual).toStrictEqual(captured);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(captured));
}
const startedAt = 1234567890000;
const metadata: FreezoneRecipeCompileMetadata = {
  mode: 'model', prompt: 'A quiet morning.', recipeIds: ['general-audio'],
};
const voice = { voicePolicyConfirmed: true, voiceAvailable: true,
  voiceRef: { scope: 'character_default', characterName: 'Alex', identityId: 'character-1' } };
type Fault = { kind: 'submit'; failure: GenerationSubmitFailure }
  | { kind: 'task' | 'result' | 'compile'; error: unknown };
interface Fixture {
  name: string;
  data?: Record<string, unknown>;
  url?: string;
  fault?: Fault;
  voicePrerequisite?: boolean;
  latestUrl?: string | null | number;
  skip?: boolean;
}
const httpFailure = (status: number, body: unknown): GenerationSubmitFailure => ({
  kind: 'http', status, statusText: 'Rejected', method: 'POST',
  url: 'https://example.test/api/audio', body,
});
const fixtures: Fixture[] = [
  { name: 'speech success' },
  { name: 'music success', data: { audioKind: 'music', musicLengthMs: 30000 } },
  { name: 'direct voice success without compile metadata', data: { workflowCatalog: { recipeId: 'drama-shot-voice' } } },
  { name: 'empty URL', url: '' },
  { name: 'store audioUrl changed before publish', latestUrl: '/static/newer.mp3' },
  { name: 'empty store audioUrl retains hook URL', latestUrl: '' },
  { name: 'nonstring store audioUrl retains hook URL', latestUrl: 7 },
  { name: 'submit rejected insufficient credits', fault: { kind: 'submit', failure: httpFailure(402, { error: 'Balance too low', data: { request_id: 'req-1' } }) } },
  { name: 'submit rejected plain backend error', fault: { kind: 'submit', failure: httpFailure(400, { error: 'Raw backend message', data: { request_id: 'req-2' } }) } },
  { name: 'submit rejected envelope failure', fault: { kind: 'submit', failure: { kind: 'envelope', body: { ok: false, error: 'Envelope rejected' } } } },
  { name: 'task failed', fault: { kind: 'task', error: new TaskCompletionError('Task failed raw', 'failed', 'audio-task') } },
  { name: 'task cancelled', fault: { kind: 'task', error: new TaskCompletionError('Cancelled raw', 'cancelled', 'audio-task') } },
  { name: 'poll timeout', fault: { kind: 'task', error: new TaskPollTimeoutError('audio-task', 100) } },
  { name: 'job-result call rejects', fault: { kind: 'result', error: new Error('Result unavailable') } },
  { name: 'error with empty message', fault: { kind: 'result', error: new Error('') } },
  // Unclassified transport values are rethrown unchanged.
  { name: 'non-Error thrown', fault: { kind: 'result', error: 'Raw thrown value' } },
  { name: 'non-Error voice prerequisite', fault: { kind: 'result', error: '缺少可用声线' }, voicePrerequisite: true }, // i18n-exempt -- exact matcher input
  { name: 'voice prerequisite failure', fault: { kind: 'submit', failure: httpFailure(400, { error: '声线未配置' }) }, voicePrerequisite: true }, // i18n-exempt -- backend error matching contract
  { name: 'voice prerequisite task failure', fault: { kind: 'task', error: new TaskCompletionError('缺少可用声线', 'failed', 'audio-task') }, voicePrerequisite: true }, // i18n-exempt -- backend error matching contract
  { name: 'voice prerequisite envelope failure', fault: { kind: 'submit', failure: { kind: 'envelope', body: { ok: false, error: '请先配置或选择声线' } } }, voicePrerequisite: true }, // i18n-exempt -- backend error matching contract
  { name: 'voice prerequisite job-result failure', fault: { kind: 'result', error: new Error('上传或录制参考音频') }, voicePrerequisite: true }, // i18n-exempt -- backend error matching contract
  { name: 'compile failure', fault: { kind: 'compile', error: new Error('Compile unavailable') } },
  { name: 'missing custom voice skip published as success', data: { voiceAvailable: false }, skip: true },
];

function audioNode(data: Record<string, unknown> = {}): CanvasNode {
  return { id: 'audio-1', type: CANVAS_NODE_TYPES.audio, position: { x: 0, y: 0 }, data: {
    text: 'A quiet morning.', audioUrl: '/static/previous.mp3', durationMs: 1000,
    generationError: 'Previous error', generationErrorDetails: 'Keep details', generationErrorRequestId: 'keep-request',
    workflowResultStale: true, ...voice, ...data,
  } };
}
describe('audio result capture', () => {
  it.each(fixtures)('$name', fixture => {
    const E = expected[`result/${fixture.name}` as keyof typeof expected];
    if (!('finalData' in E)) throw new Error('Expected result capture');
    const ctx: AudioGenerationRequestContext = { nodes: [{ ...audioNode(fixture.data), data: E.data }],
      edges: [], nodeId: 'audio-1', projectId: `audio-result/${fixture.name}`, canvasId: 'canvas-7',
      productOperation: null, translate };
    const decision = audioPromptCompileInput(ctx);
    const fault = fixture.fault;
    exact(decision.kind === 'compile' ? decision.input : null, E.compileInput);
    const thrown = fault?.kind === 'submit' ? generationErrorFromSubmitFailure(fault.failure) : fault?.error;
    const writes: Partial<AudioNodeData>[] = [];
    const requests: unknown[] = [];
    let hookOutput: AudioGenerationHookOutput = {};
    let hookError: AudioGenerationHookError | undefined;
    if (fixture.skip) {
      if (decision.kind !== 'skip') throw new Error('Expected skip');
      writes.push(decision.patch); hookOutput = decision.output;
    } else {
      writes.push(audioGenerationStartPatch(startedAt));
      if (decision.kind !== 'compile' && decision.kind !== 'literal') throw new Error('Expected prompt');
      if (decision.kind === 'compile' && fault?.kind !== 'compile') {
        writes.push(audioPromptCompileMetadataPatch(ctx, metadata, ISO));
      }
      if (fault?.kind !== 'compile') {
        const build = buildAudioGenerationRequest({ ...ctx,
          prompt: decision.kind === 'literal' ? decision.prompt : metadata.prompt,
          compileMode: decision.kind === 'compile' ? metadata.mode : null,
          recipeIds: decision.kind === 'compile' ? metadata.recipeIds : [] });
        if (!build.ok) throw new Error(build.message);
        requests.push(...build.requests);
      }
      if (fault?.kind !== 'submit' && fault?.kind !== 'compile') {
        writes.push(audioGenerationAcceptedPatch({ task_key: 'audio-task', job_id: 'audio-job',
          task_type: fixture.data?.audioKind === 'music' ? 'freezone_audio_eleven_music' : 'freezone_audio_speech' }));
      }
      if (fault) hookError = audioGenerationHookError(thrown);
      const outcome = audioGenerationOutcomePatch({ outcome: hookError
        ? { kind: 'failed', ...hookError } : { kind: 'completed', url: fixture.url ?? '/static/audio.mp3' }, translate });
      writes.push(...outcome.patches);
      if ('hookOutput' in outcome) hookOutput = outcome.hookOutput;
    }
    exact(writes, E.writes); exact(requests, E.requests);
    const finalData = Object.assign({}, E.data, ...writes,
      fixture.latestUrl !== undefined ? { audioUrl: fixture.latestUrl } : {});
    exact(finalData, E.finalData);
    const result = audioGenerationActionResult({ ...(hookError ? { hookError } : { hookOutput }), latestNodeData: finalData });
    exact({ requestId: fixture.name, nodeId: 'audio-1', action: 'generate_audio', ...result }, E.result);
  });
});
describe('pure audio result boundaries', () => {
  it.each([
    { name: 'unconfigured substring', message: 'prefix 声线未配置 suffix', matches: true }, // i18n-exempt -- exact matcher input
    { name: 'missing voice substring', message: '缺少默认声线', matches: true }, // i18n-exempt -- exact matcher input
    { name: 'configure or select phrase', message: '请先配置或选择声线', matches: true }, // i18n-exempt -- exact matcher input
    { name: 'upload or record phrase', message: '上传或录制参考音频', matches: true }, // i18n-exempt -- exact matcher input
    { name: 'missing voice cannot cross newline', message: '缺少\n声线', matches: false }, // i18n-exempt -- exact matcher input
    { name: 'upload audio cannot cross newline', message: '上传或录制\n音频', matches: false }, // i18n-exempt -- exact matcher input
    { name: 'similar voice wording is not matched', message: '请选择声线', matches: false }, // i18n-exempt -- exact matcher input
    { name: 'English wording is not matched', message: 'Voice not configured', matches: false },
    { name: 'empty message is not matched', message: '', matches: false },
  ])('$name', ({ message, matches }) => {
    // Contradictory display/diagnostics prove only the raw message participates.
    const info = { ...describeGenerationError(new Error(message), translate, 'Fallback'),
      display: '声线未配置', details: '声线未配置', requestId: 'req-test', status: 400 }; // i18n-exempt -- matcher must ignore translated display and diagnostics
    expect(isAudioVoicePrerequisiteFailure(info)).toBe(matches);
    expect(isVoicePrerequisiteError(new Error(message))).toBe(matches);
    expect(isVoicePrerequisiteError(message)).toBe(matches);
  });
  it('transitive runtime imports stay inside pure canvas modules', () => {
    const root = path.resolve(__dirname, '../../..');
    const graph = collectImportGraph([path.join(root, 'features/canvas/application/generationRequests/audioGenerationResult.ts')], root);
    expect([...graph.files].map((file) => path.relative(root, file)).filter((file) =>
      file.endsWith('.tsx') || /^(api|lib|stores|hooks|components|routes)\//.test(file))).toStrictEqual([]);
    expect([...graph.packages.keys()].filter((name) => !['i18next', 'uuid', 'zustand/vanilla'].includes(name))).toStrictEqual([]);
  });
  it('missing node with empty hook output publishes empty success', () => {
    expect(audioGenerationActionResult({ hookOutput: {}, latestNodeData: undefined }))
      .toStrictEqual({ status: 'success', output: {} });
  });
  it('does not mutate outcome, output or latest data', () => {
    const outcome = { kind: 'completed' as const, url: '/audio.mp3' };
    const before = structuredClone(outcome);
    const result = audioGenerationOutcomePatch({ outcome, translate });
    expect(outcome).toStrictEqual(before);
    if (!('hookOutput' in result)) throw new Error('Expected output');
    const latestNodeData = { audioUrl: '/latest.mp3' };
    const input = { hookOutput: result.hookOutput, latestNodeData };
    const previous = structuredClone(input);
    audioGenerationActionResult(input);
    expect(input).toStrictEqual(previous);
  });
});

