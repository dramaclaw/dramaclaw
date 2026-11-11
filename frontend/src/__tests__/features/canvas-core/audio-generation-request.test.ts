// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FreezoneRecipeCompileMetadata } from '@/api/ops';
import { CANVAS_NODE_TYPES, isAudioNode, type AudioNodeData, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  audioNodeRepairPatch, audioMusicKindRepairPatch, audioMusicLengthRepairPatch,
  audioSpeechInstructionRepairPatch, audioPromptCompileInput, audioPromptCompileMetadataPatch,
  buildAudioGenerationRequest, type AudioGenerationRequestContext,
} from '@/features/canvas/application/generationRequests/audioGenerationRequest';
import {
  audioGenerationStartPatch, audioGenerationAcceptedPatch, audioGenerationOutcomePatch,
  audioGenerationActionResult, audioGenerationHookError,
  type AudioGenerationHookOutput, type AudioGenerationHookError,
} from '@/features/canvas/application/generationRequests/audioGenerationResult';
import { collectImportGraph } from './importGraph';
import expected from './audioGenerationExpected.json';
import { DEFAULT_NODE_DISPLAY_NAME } from '@/features/canvas/domain/nodeDisplay';
const translate = (key: string) => key;
const ISO = '2009-02-13T23:31:30.000Z';
function exact(actual: unknown, captured: unknown) {
  expect(actual).toStrictEqual(captured);
  expect(JSON.stringify(actual)).toBe(JSON.stringify(captured));
}
function audioNode(data: Record<string, unknown> = {}): CanvasNode {
  return { id: 'audio-1', type: CANVAS_NODE_TYPES.audio, position: { x: 0, y: 0 },
    data: { audioUrl: null, text: 'A quiet morning.', ...data } };
}
function source(id: string, content: string, stepId?: string): CanvasNode {
  return { id, type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 0, y: 0 },
    data: { content, ...(stepId ? { workflowCatalog: { stepId } } : {}) } };
}
type Fixture = AudioGenerationRequestContext & {
  name: string; repairKeys?: string[]; runtimePatch?: Partial<AudioNodeData>; metadata?: FreezoneRecipeCompileMetadata; compiledPrompt?: string;
  refusal?: string; skip?: true; failure?: true; blocked?: true; expected?: Record<string, unknown>;
};
function fixture(name: string, data: Record<string, unknown> = {}, extra: Partial<Fixture> = {}): Fixture {
  return { name, nodes: [audioNode(data)], edges: [], nodeId: 'audio-1', projectId: `audio-parity/${name}`,
    canvasId: 'canvas-7', productOperation: null, translate, ...extra };
}
const voice = { voicePolicyConfirmed: true, voiceAvailable: true,
  voiceRef: { scope: 'character_default', characterName: 'Alex', identityId: 'character-1', slot: 'dialogue' } };
const generalAudio = { recipeId: 'general-audio' };
const invalidationKeys = ['audioUrl', 'durationMs', 'generationError', 'workflowResultStale', 'workflowInvalidatedAt', 'workflowInvalidationReason'];
const musicRepairKeys = ['audioKind', 'model', ...invalidationKeys];
const fixtures: Fixture[] = [
  fixture('legacy speech default narrator', {}, { expected: { text: 'A quiet morning.', speech_mode: 'clone', preset_model: 'edge-tts', preset_voice: 'Serena', emotion_prompt: '', voice_ref: { scope: 'project_narrator', character_name: '', identity_id: '', slot: '', voice_id: '' } } }),
  fixture('legacy preset model and voice', { speechMode: 'preset', presetModel: 'preset-model', presetVoice: 'voice-2', voiceAvailable: false }, { expected: { speech_mode: 'preset', preset_model: 'preset-model', preset_voice: 'voice-2' } }),
  fixture('new policy available character voice', { ...voice, speechMode: 'preset' }, { expected: { speech_mode: 'clone', preset_model: 'edge-tts', preset_voice: 'Serena', voice_ref: { scope: 'character_default', character_name: 'Alex', identity_id: 'character-1', slot: 'dialogue', voice_id: '' } } }),
  fixture('custom voice id', { ...voice, voiceRef: { scope: 'user_custom', voiceId: 'custom-1' } }, { expected: { voice_ref: { scope: 'user_custom', character_name: '', identity_id: '', slot: '', voice_id: 'custom-1' } } }),
  fixture('same turn custom voice selection', { ...voice, voiceAvailable: false, voiceRef: { scope: 'user_custom', voiceId: '' } }, { runtimePatch: { voiceAvailable: true, voiceRef: { scope: 'user_custom', voiceId: 'new-voice' } }, expected: { voice_ref: { scope: 'user_custom', voice_id: 'new-voice' } } }),
  fixture('same turn legacy default narrator', {}, { runtimePatch: { voiceRef: null, voiceAvailable: undefined }, expected: { voice_ref: { scope: 'project_narrator', character_name: '', identity_id: '', slot: '', voice_id: '' } } }),
  fixture('missing custom voice skip', { ...voice, voiceRef: { scope: 'user_custom', voiceId: ' ' } }, { skip: true }),
  fixture('new policy unavailable voice skip', { ...voice, voiceAvailable: false }, { skip: true }),
  fixture('emotion trimmed', { emotionPrompt: '  softly  ' }, { expected: { emotion_prompt: 'softly' } }),
  fixture('emotion blank', { emotionPrompt: '  ' }, { expected: { emotion_prompt: '' } }),
  fixture('legacy text segments', { text: undefined, segments: [{ type: 'text', value: 'Hello ' }, { type: 'pause', durationSec: 0.1 }, { type: 'text', value: 'world.' }] }, { expected: { text: 'Hello world.' } }),
  fixture('upstream edge order dependency ignored', { text: '' }, {
    nodes: [audioNode({ text: '' }), source('first', 'First.'), source('second', 'Second.'), source('dep', 'Ignored.')],
    edges: [{ id: '2', source: 'second', target: 'audio-1' }, { id: 'dep', source: 'dep', target: 'audio-1', data: { link_type: 'dependency_for' } }, { id: '1', source: 'first', target: 'audio-1' }],
    expected: { text: 'Second.\n\nFirst.' },
  }),
  fixture('explicit speech label own text', { text: 'Narration: Spoken words.' }, { expected: { text: 'Spoken words.' } }),
  fixture('explicit speech label upstream', {}, {
    nodes: [audioNode({ text: '' }), source('text', 'Narration: Upstream words.')], edges: [{ id: 'text', source: 'text', target: 'audio-1' }], expected: { text: 'Upstream words.' },
  }),
  fixture('workflow upstream step selection', {}, {
    nodes: [audioNode({ ...voice, text: '', workflowCatalog: { recipeId: 'general-audio', inputStrategy: { step_ids: ['step-2'] } } }), source('first', 'First.', 'step-1'), source('second', 'Narration: Selected.', 'step-2')],
    edges: [{ id: '1', source: 'first', target: 'audio-1' }, { id: '2', source: 'second', target: 'audio-1' }], expected: { text: 'Selected.' },
  }),
  fixture('workflow upstream none', {}, {
    nodes: [audioNode({ ...voice, workflowCatalog: { inputStrategy: { type: 'none' } } }), source('text', 'Ignored.')],
    edges: [{ id: 'text', source: 'text', target: 'audio-1' }], expected: { text: 'A quiet morning.' },
  }),
  fixture('drama shot voice literal bypass', { ...voice, workflowCatalog: { recipeId: 'drama-shot-voice' }, text: 'Narration: Literal words.' }, { expected: { text: 'Literal words.' } }),
  fixture('recipe compiled speech safe metadata', { ...voice, workflowCatalog: generalAudio }, { metadata: { mode: 'model', prompt: '<speech_text>Safe compiled words.</speech_text>\nLanguage: English', recipeIds: ['general-audio'] }, expected: { text: 'Safe compiled words.' } }),
  fixture('recipe unlabelled speech falls back', { ...voice, workflowCatalog: generalAudio }, { metadata: { mode: 'model', prompt: 'Compiler instructions only', recipeIds: ['general-audio'] }, expected: { text: 'A quiet morning.' } }),
  fixture('timeout speech uses safe fallback', { ...voice, workflowCatalog: generalAudio }, { metadata: { mode: 'timeout_fallback', prompt: 'Narration: Do not submit this.', recipeIds: ['general-audio'] }, expected: { text: 'A quiet morning.' } }),
  fixture('compiled speech no speakable text', { text: '3 seconds' }, { compiledPrompt: '3 seconds', failure: true }),
  fixture('recipe explicit speech without receipt', {}, { compiledPrompt: 'Narration: Explicit compiled words.', expected: { text: 'Explicit compiled words.' } }),
  fixture('compiled speech empty metadata failure', { ...voice, text: '3 seconds', workflowCatalog: generalAudio }, { metadata: { mode: 'model', prompt: '<speech_text></speech_text>', recipeIds: ['general-audio'] }, failure: true }),
  fixture('music explicit kind', { audioKind: 'music', text: ' Gentle strings ' }, { expected: { input: 'Gentle strings', force_instrumental: true, respect_sections_durations: true } }),
  fixture('music intent title repair', { audioKind: 'speech', title: 'Background music', text: ' Gentle strings ' }, { repairKeys: musicRepairKeys, expected: { input: 'Gentle strings' } }),
  fixture('music intent retains existing audio', { displayName: 'Background music', audioUrl: '/static/existing.mp3', musicLengthMs: 2000 }, { repairKeys: ['audioKind', 'model', 'musicLengthMs'], expected: { music_length_ms: 3000 } }),
  fixture('music explicit kind keeps stored model', { audioKind: 'music', model: 'stored-model' }),
  fixture('music explicit rounded length', { audioKind: 'music', musicLengthMs: 4321.6 }, { repairKeys: ['musicLengthMs'], expected: { music_length_ms: 4322 } }),
  fixture('music length lower clamp', { audioKind: 'music', musicLengthMs: 1 }, { repairKeys: ['musicLengthMs'], expected: { music_length_ms: 3000 } }),
  fixture('music length upper clamp', { audioKind: 'music', musicLengthMs: 999999 }, { repairKeys: ['musicLengthMs'], expected: { music_length_ms: 600000 } }),
  fixture('music length derived from text', { audioKind: 'music', text: 'Strings for 12 seconds' }, { repairKeys: ['musicLengthMs'], expected: { music_length_ms: 13000 } }),
  fixture('music length derived from goal', { audioKind: 'music', text: 'Strings for 12 seconds', workflowCatalog: { promptBuilder: { userGoal: '2 minutes' } } }, { repairKeys: ['musicLengthMs'], expected: { music_length_ms: 121000 } }),
  fixture('music flags explicit false', { audioKind: 'music', forceInstrumental: false, respectSectionsDurations: false }, { expected: { force_instrumental: false, respect_sections_durations: false } }),
  fixture('music truncation 4101 code units', { audioKind: 'music' }, { compiledPrompt: `  ${'a'.repeat(4200)}${'z'.repeat(200)}  `, expected: { input: `${'a'.repeat(3900)}\n${'z'.repeat(200)}` } }),
  fixture('music metadata stays raw', { audioKind: 'music' }, { metadata: { mode: 'model', prompt: '  Recipe strings  ', recipeIds: ['music'] }, expected: { input: 'Recipe strings' } }),
  fixture('music ignores upstream in compilation', {}, {
    nodes: [audioNode({ audioKind: 'music', text: 'Strings' }), source('text', 'Long upstream script')], edges: [{ id: 'text', source: 'text', target: 'audio-1' }], expected: { input: 'Long upstream script\n\nStrings' },
  }),
  fixture('product operation with attempt', {}, { productOperation: { projectId: 'p', operationId: 'op-1', generationAttemptId: 'attempt-1' }, expected: { product_operation_id: 'op-1', generation_attempt_id: 'attempt-1' } }),
  fixture('product operation without attempt', {}, { productOperation: { projectId: 'p', operationId: 'op-1' } }),
  fixture('unused model and target fields omitted', { modelParams: { seed: 4 }, targetEpisode: 2, targetBeat: 3 }),
  fixture('canvas default', {}, { canvasId: 'default' }),
  fixture('empty prompt refusal', { text: ' ' }, { refusal: 'no_effective_prompt' }),
  fixture('busy refusal before missing voice', { ...voice, voiceAvailable: false, isGenerating: true, generationJobId: 'running' }, { refusal: 'generation_in_progress' }),
  fixture('missing project refusal', { ...voice }, { projectId: '', refusal: 'no_project' }),
  fixture('access before missing voice', { ...voice, voiceAvailable: false }, { blocked: true }),
  fixture('invalid speech instruction repair', { text: '\u6839\u636e\u811a\u672c\u751f\u6210\u65c1\u767d\u914d\u97f3', audioUrl: '/static/old.mp3' }, { repairKeys: invalidationKeys, failure: true }),
];

describe('audio request capture', () => {
  it('capture contains exactly the request and result fixtures', () => {
    expect(Object.keys(expected).sort()).toStrictEqual([
      ...fixtures.map(({ name }) => `request/${name}`),
      ...["speech success", "music success", "direct voice success without compile metadata", "empty URL", "store audioUrl changed before publish", "empty store audioUrl retains hook URL", "nonstring store audioUrl retains hook URL", "submit rejected insufficient credits", "submit rejected plain backend error", "submit rejected envelope failure", "task failed", "task cancelled", "poll timeout", "job-result call rejects", "error with empty message", "non-Error thrown", "non-Error voice prerequisite", "voice prerequisite failure", "voice prerequisite task failure", "voice prerequisite envelope failure", "voice prerequisite job-result failure", "compile failure", "missing custom voice skip published as success"].map(name => `result/${name}`),
    ].sort());
  });
  it.each(fixtures)('$name', fixture => {
    const E = expected[`request/${fixture.name}` as keyof typeof expected];
    if (!('mountData' in E)) throw new Error('Expected request capture');
    // JSON imports widen the captured speechMode/voice scope string literals.
    const mountData = E.mountData as AudioNodeData;
    const repairs = [audioMusicKindRepairPatch(mountData, ISO),
      audioMusicLengthRepairPatch(mountData), audioSpeechInstructionRepairPatch(mountData, ISO)]
      .filter(patch => patch !== null);
    exact(repairs, E.repairWrites);
    const ctx: AudioGenerationRequestContext = { ...fixture,
      // Store hydration supplies default names before the captured compiler call.
      nodes: fixture.nodes.map(node => node.id === 'audio-1' ? { ...node, data: E.data }
        : { ...node, data: { displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.textAnnotation], ...node.data } }),
    };
    const decision = audioPromptCompileInput(ctx);
    const compileInput = decision.kind === 'compile' && !fixture.blocked ? decision.input : null;
    // The browser JSON capture omits undefined optional content fields.
    exact(JSON.parse(JSON.stringify(compileInput)), E.compileInput);
    const writes: Partial<AudioNodeData>[] = [];
    const requests: unknown[] = [];
    let hookOutput: AudioGenerationHookOutput = {};
    let hookError: AudioGenerationHookError | undefined;
    if (decision.kind === 'refuse' && ['generation_in_progress', 'not_audio_node'].includes(decision.code)) {
      // Busy precedes access and all prompt guards.
    } else if (fixture.blocked) {
      writes.push({ generationError: 'Model access unavailable' });
    } else if (decision.kind === 'skip') {
      writes.push(decision.patch); hookOutput = decision.output;
    } else if (decision.kind === 'refuse') {
      if (decision.code === 'no_project') writes.push(decision.patch);
    } else {
      writes.push(audioGenerationStartPatch(1234567890000));
      const metadata = decision.kind === 'compile' ? fixture.metadata : undefined;
      if (metadata) writes.push(audioPromptCompileMetadataPatch(ctx, metadata, ISO));
      const prompt = decision.kind === 'literal' ? decision.prompt
        : metadata?.prompt ?? fixture.compiledPrompt ?? decision.input.fallbackPrompt;
      const build = buildAudioGenerationRequest({ ...ctx, prompt,
        compileMode: metadata?.mode ?? null, recipeIds: metadata?.recipeIds ?? [] });
      if (!build.ok) {
        hookError = audioGenerationHookError(new Error(build.message));
        writes.push(...audioGenerationOutcomePatch({ outcome: { kind: 'failed', ...hookError }, translate }).patches);
      } else {
        requests.push(...build.requests);
        writes.push(audioGenerationAcceptedPatch({ task_key: 'audio-task', job_id: 'audio-job',
          task_type: build.requests[0].path.endsWith('/speech') ? 'freezone_audio_speech' : 'freezone_audio_eleven_music' }));
        const outcome = audioGenerationOutcomePatch({ outcome: { kind: 'completed', url: '/static/audio.mp3' }, translate });
        writes.push(...outcome.patches);
        if (!('hookOutput' in outcome)) throw new Error('Expected completion');
        hookOutput = outcome.hookOutput;
      }
    }
    exact(writes, E.writes); exact(requests, E.requests);
    const result = audioGenerationActionResult({ ...(hookError ? { hookError } : { hookOutput }),
      latestNodeData: Object.assign({}, E.data, ...writes) });
    exact({ requestId: fixture.name, nodeId: 'audio-1', action: 'generate_audio', ...result }, E.result);
  });
});
describe('pure audio boundaries', () => {
  it('wrong node type', () => {
    const ctx = { ...fixtures[0], nodes: [source('audio-1', 'Text')] };
    expect(audioPromptCompileInput(ctx)).toMatchObject({ kind: 'refuse', code: 'not_audio_node' });
    expect(buildAudioGenerationRequest({ ...ctx, prompt: 'Text', compileMode: null, recipeIds: [] })).toMatchObject({ ok: false, code: 'not_audio_node' });
  });
  it('resolved activity refuses even without node busy flag', () => {
    expect(audioPromptCompileInput({ ...fixtures[0], isGenerating: true })).toMatchObject({ kind: 'refuse', code: 'generation_in_progress' });
  });
  it('node busy flag refuses even when resolved activity is false', () => {
    expect(audioPromptCompileInput(fixture('busy', { isGenerating: true }, { isGenerating: false }))).toMatchObject({ kind: 'refuse', code: 'generation_in_progress' });
  });
  it('missing voice precedes empty prompt and missing project', () => {
    expect(audioPromptCompileInput(fixture('skip', { ...voice, voiceAvailable: false, text: '' }, { projectId: '' }))).toMatchObject({ kind: 'skip' });
  });
  it('empty prompt precedes missing project', () => {
    expect(audioPromptCompileInput(fixture('empty', { text: '' }, { projectId: '' }))).toMatchObject({ kind: 'refuse', code: 'no_effective_prompt' });
  });
  it('string text wins over legacy segments even when empty', () => {
    expect(audioPromptCompileInput(fixture('empty', { text: '', segments: [{ type: 'text', value: 'Ignored' }] }))).toMatchObject({ kind: 'refuse', code: 'no_effective_prompt' });
  });
  it('inputs not mutated', () => {
    const ctx = fixtures.find((item) => item.name === 'workflow upstream step selection')!;
    const before = structuredClone({ nodes: ctx.nodes, edges: ctx.edges });
    audioPromptCompileInput(ctx); audioPromptCompileMetadataPatch(ctx, { mode: 'model', prompt: 'Narration: New.', recipeIds: [] }, 'now');
    buildAudioGenerationRequest({ ...ctx, prompt: 'Narration: New.', compileMode: null, recipeIds: [] });
    const node = ctx.nodes[0];
    if (!isAudioNode(node)) throw new Error('Missing audio node');
    audioNodeRepairPatch(node.data, 'now');
    expect({ nodes: ctx.nodes, edges: ctx.edges }).toStrictEqual(before);
  });
  it('no repairs for settled speech', () => {
    const node = audioNode();
    if (!isAudioNode(node)) throw new Error('Missing audio node');
    expect(audioNodeRepairPatch(node.data, 'now')).toBeNull();
  });
  it('transitive runtime imports stay inside the pure canvas modules', () => {
    const root = path.resolve(__dirname, '../../..');
    const graph = collectImportGraph([path.join(root, 'features/canvas/application/generationRequests/audioGenerationRequest.ts')], root);
    expect([...graph.files].map((file) => path.relative(root, file)).filter((file) =>
      file.endsWith('.tsx') || /^(api|lib|stores|hooks|components|routes)\//.test(file))).toStrictEqual([]);
    expect([...graph.packages.keys()].filter((name) => !['i18next', 'uuid', 'zustand/vanilla'].includes(name))).toStrictEqual([]);
  });
});
