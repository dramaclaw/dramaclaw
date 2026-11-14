// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import path from 'node:path';
import { createInstance } from 'i18next';
import { describe, expect, it } from 'vitest';
import en from '../../../../public/locales/en/translation.json';
import zh from '../../../../public/locales/zh/translation.json';
import {
  worldVisibleSourceKind, buildWorldGenerationRequest, worldGenerationStartPatch, worldGenerationAcceptedPatch,
  worldGenerationSuccessPatch, worldGenerationFailureOutcome, worldGenerationActionResult,
  type WorldGenerationRequestContext,
} from '@/features/canvas/application/generationRequests';
import { CANVAS_NODE_TYPES, type CanvasNode, type ThreeDWorldNodeData } from '@/features/canvas/domain/canvasNodes';
import type { DirectorWorldSource } from '@/features/viewer-kit/three-d/directorManifest';
import { collectImportGraph } from './importGraph';
import captured from './worldGenerationExpected.json';
const expected: Record<string, { request: { body: unknown } | null }> = captured;
const id = 'world';
const now = 1700000000000;
const completedAt = now + 5000;
const ref = { task_key: 'world-task', task_type: 'freezone_image_to_3gs', job_id: 'world-job' };
const sourceUrl = 'https://media.example.test/source.png?version=1';
const worldUrl = 'https://media.example.test/world.ply';
const oldSource: DirectorWorldSource = { id: 'old', source_type: 'pano360', source_kind: 'pano', url: 'https://media.example.test/old.jpg' };
const changedSource: DirectorWorldSource = { id: 'changed', source_type: 'sog', source_kind: 'custom', ply_url: 'https://media.example.test/changed.sog' };
interface Fixture {
  name: string;
  source?: Record<string, unknown>;
  data?: Partial<ThreeDWorldNodeData>;
  upstream?: 'none' | 'text';
  project?: string;
  canvas?: string;
  blocked?: boolean;
  fault?: 'submit' | 'timeout' | 'wait' | 'non_error';
  result?: Record<string, unknown>;
  changeSources?: boolean;
  latest?: Record<string, unknown>;
  operation?: { projectId: string; operationId: string; generationAttemptId?: string };
}
const fixtures: Fixture[] = [
  { name: 'master ply_url default canvas' },
  { name: 'master without existing pano source', data: { sources: [], panoUrl: null } },
  { name: 'pano without existing pano source', source: { aspectRatio: '2:1' }, data: { sources: [], panoUrl: null } },
  { name: 'master url explicit canvas', result: { url: worldUrl }, canvas: 'canvas/2' },
  { name: 'empty canvas omitted', canvas: '' },
  { name: 'preview URL wins over displayed reference', source: { imageUrl: undefined, previewImageUrl: 'https://media.example.test/preview.png', referenceImageUrl: 'https://media.example.test/reference.png' } },
  { name: 'reference URL fallback', source: { imageUrl: undefined, referenceImageUrl: 'https://media.example.test/reference.png' } },
  { name: 'reverse output role', source: { output_role: 'scene_reverse_master' } },
  { name: 'reverse source role', source: { __freezone_source: { role: 'scene_reverse_master' } } },
  { name: 'stored reverse is inferred again', data: { plyKind: 'reverse' } },
  { name: 'pano inferred role', source: { output_role: 'scene_360' } },
  { name: 'pano inferred media kind', source: { media_kind: 'pano360' } },
  { name: 'pano inferred aspect ratio', source: { aspectRatio: '2:1' } },
  { name: 'pano merges existing raw source', source: { aspectRatio: '2:1' }, data: { sources: [{ ...oldSource, id: 'keep-raw-id', url: sourceUrl, pano_url: sourceUrl }] } },
  { name: 'forced pano fallback source and translated label', data: { plyKind: 'pano' } },
  { name: 'forced master ignores pano classification', source: { aspectRatio: '2:1' }, data: { plyKind: 'master' } },
  { name: 'generated URL merge keeps existing source id', data: { sources: [{ id: 'keep-world-id', source_type: 'sog', source_kind: 'master', ply_url: worldUrl }] } },
  { name: 'master merges sources changed while waiting', changeSources: true },
  { name: 'pano merges sources changed while waiting', source: { aspectRatio: '2:1' }, changeSources: true },
  { name: 'latest urls override returned urls', latest: { plyUrl: 'https://media.example.test/latest.sog', panoUrl: 'https://media.example.test/latest.jpg' } },
  { name: 'empty and nonstring latest urls retain returned urls', latest: { plyUrl: '', panoUrl: 7 } },
  { name: 'missing world URL', result: {} },
  { name: 'poll timeout', fault: 'timeout' },
  { name: 'ordinary task failure', fault: 'wait' },
  { name: 'submit failure', fault: 'submit' },
  { name: 'non Error failure', fault: 'non_error' },
  { name: 'blocked before missing project', blocked: true, project: '', upstream: 'text' },
  { name: 'missing project', project: '' },
  { name: 'no upstream', upstream: 'none' },
  { name: 'busy image', data: { isGenerating: true } },
  { name: 'busy before unsupported text', upstream: 'text', data: { isGenerating: true } },
  { name: 'unsupported text', upstream: 'text' },
  { name: 'operation with attempt', operation: { projectId: 'world/project', operationId: 'operation', generationAttemptId: 'attempt' } },
  { name: 'operation without attempt omitted', operation: { projectId: 'world/project', operationId: 'operation' } },
];

describe.each(['en', 'zh'])('world request (%s)', locale => {
  it.each(fixtures)('$name', async fixture => {
    const translator = createInstance();
    await translator.init({ lng: locale, fallbackLng: false, resources: { en: { translation: en }, zh: { translation: zh } }, interpolation: { escapeValue: false } });
    const translate = (key: string, options?: Record<string, unknown>) => translator.t(key, options);
    const source: CanvasNode = fixture.upstream === 'text'
      ? { id: 'source', type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 0, y: 0 }, data: { content: 'An open field.' } }
      : { id: 'source', type: CANVAS_NODE_TYPES.imageGen, position: { x: 0, y: 0 }, data: { imageUrl: sourceUrl, displayName: 'Source', ...fixture.source } };
    const world: CanvasNode = { id, type: CANVAS_NODE_TYPES.threeDWorld, position: { x: 300, y: 0 }, data: {
      displayName: 'World', sources: [oldSource], plyUrl: 'https://media.example.test/previous.sog', panoUrl: oldSource.url,
      generationStartedAt: 10, errorMessage: 'Previous error', ...fixture.data,
    } };
    // setCanvasData supplied these defaults and cleared handle-free loading before capture.
    const initial: ThreeDWorldNodeData = { model: 'marble-1.1', prompt: '', generationDurationMs: 90000,
      taskKey: null, sourceNodeId: null, sourceKind: null, ...structuredClone(world.data), isGenerating: false,
      ...(fixture.data?.isGenerating ? { generationStartedAt: null } : {}) };
    const result = fixture.result ?? { ply_url: worldUrl };
    const thrown = fixture.fault === 'non_error' ? 'Raw failure' : new Error('World unavailable');
    const ctx: WorldGenerationRequestContext = { nodeId: id, projectId: fixture.project ?? 'world/project', canvasId: fixture.canvas ?? 'default',
      data: initial, blocked: fixture.blocked ?? false, isGenerating: initial.isGenerating === true,
      upstream: fixture.upstream === 'none' ? null : { kind: fixture.upstream === 'text' ? 'text' : 'image', nodeId: source.id },
      sourceNode: fixture.upstream === 'text' ? null : source, productOperation: fixture.operation ?? null, translate };
    const snapshot = structuredClone({ ...ctx, translate: undefined });
    const decision = buildWorldGenerationRequest(ctx);
    const patches: Record<string, unknown>[] = [];
    let output = {}; let failure: string | undefined;
    if (!decision.ok) patches.push(...decision.patches);
    else {
      patches.push(worldGenerationStartPatch({ request: decision, data: initial, startedAtMs: now }));
      if (fixture.fault !== 'submit') patches.push(worldGenerationAcceptedPatch(ref));
      if (fixture.fault) {
        const outcome = worldGenerationFailureOutcome(fixture.fault === 'timeout' ? { kind: 'poll_timeout' }
          : { kind: 'failed', message: thrown instanceof Error ? thrown.message : String(thrown) }, translate);
        patches.push(...outcome.patches);
        expect(outcome.notice).toStrictEqual(fixture.fault === 'timeout' ? 'still_running' : null);
        if (fixture.fault !== 'timeout') failure = thrown instanceof Error ? thrown.message : String(thrown);
      } else {
        const completed = worldGenerationSuccessPatch({ result, generatedId: `generated-sog:${decision.sourceKind}:${completedAt}`,
          sourceKind: decision.sourceKind, rawPanoSource: decision.rawPanoSource, currentSources: fixture.changeSources ? [changedSource] : Object.assign({}, initial, ...patches).sources ?? [],
          labels: { pano3dgs: translate('node.threeDWorld.pano3dgsLabel'), image3dgs: translate('node.threeDWorld.image3dgsLabel'), worldUrlMissing: translate('node.threeDWorld.worldUrlMissing') } });
        if (completed.kind === 'missing_world_url') {
          failure = completed.message;
          patches.push(...worldGenerationFailureOutcome({ kind: 'failed', message: failure }, translate).patches);
        } else { patches.push(completed.patch); output = completed.output; }
      }
    }
    const expectedData = Object.assign({}, initial,
      ...patches.slice(0, fixture.changeSources ? 2 : patches.length),
      ...(fixture.changeSources ? [{ sources: [changedSource] }, ...patches.slice(2)] : []), fixture.latest ?? {});
    const trace = {
      request: decision.ok ? decision.request : null, writes: patches, finalData: expectedData,
      event: { requestId: fixture.name, nodeId: id, action: 'generate_3gs_world',
        ...worldGenerationActionResult(failure === undefined
          ? { output, latestNode: { ...world, data: expectedData } } : { error: failure }) },
    };
    expect({ ...ctx, translate: undefined }).toStrictEqual(snapshot);
    const literal = expected[`WG:${locale}:${fixture.name}`];
    expect(JSON.parse(JSON.stringify(trace))).toStrictEqual(expected[`WG:${locale}:${fixture.name}`]);
    expect(JSON.stringify(trace.request?.body)).toBe(JSON.stringify(literal.request?.body));
  });
});
describe('pure boundaries not reachable from a stable upstream projection', () => {
  const base: WorldGenerationRequestContext = { nodeId: id, projectId: 'project', canvasId: 'default', data: {},
    blocked: false, isGenerating: false, upstream: { nodeId: 'source', kind: 'image' }, sourceNode: null,
    productOperation: null, translate: key => key };
  it('refuses an active generation before checking text support', () => {
    expect(buildWorldGenerationRequest({ ...base, isGenerating: true, upstream: { nodeId: 'text', kind: 'text' } }))
      .toStrictEqual({ ok: false, code: 'generation_in_progress', patches: [] });
  });
  it.each([
    { name: 'missing source node', node: null, code: 'missing_source_node' },
    { name: 'missing source URL', node: { id: 'source', type: CANVAS_NODE_TYPES.imageGen, position: { x: 0, y: 0 }, data: {} } satisfies CanvasNode, code: 'missing_source_url' },
  ])('$name', ({ node, code }) => {
    const decision = buildWorldGenerationRequest({ ...base, sourceNode: node });
    expect(decision).toStrictEqual({ ok: false, code, patches: [] });
  });
  it.each(['audioTranslateRequest', 'worldGenerationRequest', 'worldGenerationResult', 'worldGenerationUpstream', 'nodeContextWire'])('%s runtime imports stay pure', name => {
    const root = path.resolve(__dirname, '../../..');
    const graph = collectImportGraph([path.join(root, `features/canvas/application/generationRequests/${name}.ts`)], root);
    expect([...graph.files].map(file => path.relative(root, file)).filter(file => file.endsWith('.tsx') || /^(api|lib|stores|hooks|components|routes)\//.test(file))).toStrictEqual([]);
    expect([...graph.packages.keys()].filter(name => !['i18next', 'uuid', 'zustand/vanilla'].includes(name))).toStrictEqual([]);
  });
  it('publication with a missing or wrong node retains returned urls', () => {
    expect(worldGenerationActionResult({ output: { plyUrl: worldUrl }, latestNode: undefined })).toStrictEqual({ status: 'success', output: { plyUrl: worldUrl } });
    expect(worldGenerationActionResult({ output: {}, latestNode: { id: 'other', type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 0, y: 0 }, data: { plyUrl: worldUrl } } })).toStrictEqual({ status: 'success', output: {} });
  });
});

it.each([
  ['inline capture 0', 'data:image/png;base64,AAAA'],
  ['inline capture 1', 'DATA:image/png;base64,AAAA'],
  ['inline capture 2', ' \tdata:image/png;base64,AAAA'],
])('%s forwards the browser request', (name, imageUrl) => {
  const decision = buildWorldGenerationRequest({ nodeId: id, projectId: 'world/project', canvasId: 'default',
    data: {}, blocked: false, isGenerating: false, upstream: { nodeId: 'source', kind: 'image' },
    sourceNode: { id: 'source', type: CANVAS_NODE_TYPES.imageGen, position: { x: 0, y: 0 }, data: { imageUrl } },
    productOperation: null, translate: key => key });
  const literal = expected[`WG:en:${name}`];
  expect(decision.ok ? decision.request : null).toStrictEqual(literal.request);
  expect(JSON.stringify(decision.ok ? decision.request.body : null)).toBe(JSON.stringify(literal.request?.body));
});

it.each<{ name: string; data: ThreeDWorldNodeData; source: Record<string, unknown> | null; expected: string }>([
  { name: 'stored pano', data: { plyKind: 'pano' }, source: {}, expected: 'pano' },
  { name: 'stored master', data: { plyKind: 'master' }, source: { aspectRatio: '2:1' }, expected: 'master' },
  { name: 'stored reverse inferred again', data: { plyKind: 'reverse' }, source: {}, expected: 'master' },
  { name: 'pano classified source', data: {}, source: { aspectRatio: '2:1' }, expected: 'pano' },
  { name: 'null source', data: {}, source: null, expected: 'master' },
])('visible source: $name', ({ data, source, expected }) => {
  expect(worldVisibleSourceKind(data, source === null ? null : {
    id: 'source', type: CANVAS_NODE_TYPES.imageGen, position: { x: 0, y: 0 }, data: source,
  })).toBe(expected);
});
