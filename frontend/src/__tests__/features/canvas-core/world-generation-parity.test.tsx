// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import path from 'node:path';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../../public/locales/en/translation.json';
import zh from '../../../../public/locales/zh/translation.json';
import { apiCall, apiClient } from '@/api/client';
import { awaitTaskCompletion, TaskPollTimeoutError } from '@/api/tasks';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { dispatchNodeAction } from '@/features/canvas/application/nodeActionResult';
import { bindWorkflowProductOperation, clearWorkflowProductOperation } from '@/features/canvas/application/workflowExecutionActivity';
import {
  buildWorldGenerationRequest, worldGenerationStartPatch, worldGenerationAcceptedPatch,
  worldGenerationSuccessPatch, worldGenerationFailureOutcome, worldGenerationActionResult,
  type WorldGenerationRequestContext,
} from '@/features/canvas/application/generationRequests';
import { CANVAS_NODE_TYPES, isThreeDWorldNode, type CanvasNode, type ThreeDWorldNodeData } from '@/features/canvas/domain/canvasNodes';
import type { DirectorWorldSource } from '@/features/viewer-kit/three-d/directorManifest';
import { ThreeDWorldNode } from '@/features/canvas/nodes/ThreeDWorldNode';
import { useCanvasStore } from '@/stores/canvasStore';
import { collectImportGraph } from './importGraph';

const scope = vi.hoisted(() => ({ project: 'world/project', canvas: undefined as string | undefined, blocked: false }));
vi.mock('@/lib/url-params', async original => ({ ...(await original<typeof import('@/lib/url-params')>()), readUrl: () => scope }));
vi.mock('@/lib/model-task-access', async original => ({ ...(await original<typeof import('@/lib/model-task-access')>()), useModelTaskAccess: () => ({ blocked: scope.blocked }) }));
vi.mock('@/lib/queries/generation-credit-cost', async original => ({ ...(await original<typeof import('@/lib/queries/generation-credit-cost')>()), useGenerationCreditCost: () => ({}) }));
vi.mock('@/api/client', async original => ({ ...(await original<typeof import('@/api/client')>()), apiCall: vi.fn(), apiClient: vi.fn(() => { throw new Error('Unexpected transport'); }) }));
vi.mock('@/api/tasks', async original => ({ ...(await original<typeof import('@/api/tasks')>()), awaitTaskCompletion: vi.fn() }));
// Use bundled resources through a real translator; never load locale files over HTTP.
vi.mock('@/i18n', async () => ({ default: (await import('i18next')).default }));

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
const originalUpdate = useCanvasStore.getState().updateNodeData;
function currentData() {
  const node = useCanvasStore.getState().nodes.find(candidate => candidate.id === id);
  if (!isThreeDWorldNode(node)) throw new Error('Missing world');
  return node.data;
}
function Target() {
  const data = useCanvasStore(state => state.nodes.find(candidate => candidate.id === id)?.data);
  const node = useCanvasStore.getState().nodes.find(candidate => candidate.id === id);
  if (!data || !isThreeDWorldNode(node)) throw new Error('Missing world');
  return <ThreeDWorldNode id={id} type={node.type} data={node.data} selected={false} dragging={false} draggable selectable deletable zIndex={0} isConnectable positionAbsoluteX={0} positionAbsoluteY={0} />;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected fetch'); }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); clearWorkflowProductOperation(id); useCanvasStore.setState({ updateNodeData: originalUpdate }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each(['en', 'zh'])('world action parity (%s)', locale => {
  it.each(fixtures)('$name', async fixture => {
    const translator = createInstance();
    await translator.init({ lng: locale, fallbackLng: false, resources: { en: { translation: en }, zh: { translation: zh } }, interpolation: { escapeValue: false } });
    const translate = (key: string, options?: Record<string, unknown>) => translator.t(key, options);
    scope.project = fixture.project ?? 'world/project'; scope.canvas = fixture.canvas; scope.blocked = fixture.blocked ?? false;
    const source: CanvasNode = fixture.upstream === 'text'
      ? { id: 'source', type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 0, y: 0 }, data: { content: 'An open field.' } }
      : { id: 'source', type: CANVAS_NODE_TYPES.imageGen, position: { x: 0, y: 0 }, data: { imageUrl: sourceUrl, displayName: 'Source', ...fixture.source } };
    const world: CanvasNode = { id, type: CANVAS_NODE_TYPES.threeDWorld, position: { x: 300, y: 0 }, data: {
      displayName: 'World', sources: [oldSource], plyUrl: 'https://media.example.test/previous.sog', panoUrl: oldSource.url,
      generationStartedAt: 10, errorMessage: 'Previous error', ...fixture.data,
    } };
    useCanvasStore.getState().setCanvasData([world, source], fixture.upstream === 'none' ? [] : [{ id: 'edge', source: source.id, target: id }]);
    if (fixture.operation) bindWorkflowProductOperation(id, fixture.operation);
    const result = fixture.result ?? { ply_url: worldUrl };
    const thrown = fixture.fault === 'timeout' ? new TaskPollTimeoutError(ref.task_key, 100)
      : fixture.fault === 'non_error' ? 'Raw failure' : new Error('World unavailable');
    vi.mocked(apiCall).mockImplementation(async route => {
      if (route.endsWith('/freezone/image-to-3gs')) { if (fixture.fault === 'submit') throw thrown; return ref; }
      if (route.includes('generation-history')) return [];
      throw new Error(`Unexpected API route: ${route}`);
    });
    let sourcesAtCompletion: DirectorWorldSource[] = [];
    vi.mocked(awaitTaskCompletion).mockImplementation(async () => {
      vi.mocked(Date.now).mockReturnValue(completedAt);
      if (fixture.changeSources) originalUpdate(id, { sources: [changedSource] });
      sourcesAtCompletion = structuredClone(currentData().sources ?? []);
      if (fixture.fault && fixture.fault !== 'submit') throw thrown;
      return { ...ref, username: 'test', project: scope.project, episode: 0, status: 'completed', result };
    });
    const writes: Record<string, unknown>[] = [];
    useCanvasStore.setState({ updateNodeData: (nodeId, patch) => {
      writes.push(structuredClone(patch)); originalUpdate(nodeId, patch);
      if ('plyUrl' in patch && fixture.latest) originalUpdate(nodeId, fixture.latest);
    } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<I18nextProvider i18n={translator}><QueryClientProvider client={client}><ReactFlowProvider><Target /></ReactFlowProvider></QueryClientProvider></I18nextProvider>);
    const initial = structuredClone(currentData());
    const ctx: WorldGenerationRequestContext = { nodeId: id, projectId: scope.project, canvasId: scope.canvas ?? 'default',
      data: initial, blocked: scope.blocked, isGenerating: initial.isGenerating === true,
      upstream: fixture.upstream === 'none' ? null : { kind: fixture.upstream === 'text' ? 'text' : 'image', nodeId: source.id },
      sourceNode: fixture.upstream === 'text' ? null : source, productOperation: fixture.operation ?? null, translate };
    const snapshot = structuredClone({ ...ctx, translate: undefined });
    const decision = buildWorldGenerationRequest(ctx);
    writes.length = 0;
    const events: unknown[] = []; const accepted: unknown[] = [];
    const off = canvasEventBus.subscribe('freezone/node-action-result', event => events.push(event));
    const offAccepted = canvasEventBus.subscribe('freezone/node-action-accepted', event => accepted.push(event));
    try {
      act(() => { dispatchNodeAction({ nodeId: id, action: 'generate_3gs_world', requestId: fixture.name }); });
      await waitFor(() => expect(events).toHaveLength(1));
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
            sourceKind: decision.sourceKind, rawPanoSource: decision.rawPanoSource, currentSources: sourcesAtCompletion,
            labels: { pano3dgs: translate('node.threeDWorld.pano3dgsLabel'), image3dgs: translate('node.threeDWorld.image3dgsLabel'), worldUrlMissing: translate('node.threeDWorld.worldUrlMissing') } });
          if (completed.kind === 'missing_world_url') {
            failure = completed.message;
            patches.push(...worldGenerationFailureOutcome({ kind: 'failed', message: failure }, translate).patches);
          } else { patches.push(completed.patch); output = completed.output; }
        }
      }
      expect(writes).toStrictEqual(patches);
      const expectedData = Object.assign({}, initial,
        ...patches.slice(0, fixture.changeSources ? 2 : patches.length),
        ...(fixture.changeSources ? [{ sources: [changedSource] }, ...patches.slice(2)] : []), fixture.latest ?? {});
      expect(currentData()).toStrictEqual(expectedData);
      expect(events).toStrictEqual([{ requestId: fixture.name, nodeId: id, action: 'generate_3gs_world',
        ...worldGenerationActionResult(failure === undefined ? { output, latestNode: useCanvasStore.getState().nodes.find(node => node.id === id) } : { error: failure }) }]);
      expect(accepted).toStrictEqual([{ requestId: fixture.name, nodeId: id, action: 'generate_3gs_world' }]);
      expect(vi.mocked(apiCall).mock.calls.filter(([, options]) => options?.method === 'POST').map(([path, options]) => ({ method: options?.method, path, body: options?.json })))
        .toStrictEqual(decision.ok ? [decision.request] : []);
      expect(vi.mocked(awaitTaskCompletion).mock.calls).toStrictEqual(decision.ok && fixture.fault !== 'submit' ? [[ref.task_key, scope.project, { taskType: ref.task_type }]] : []);
      expect({ ...ctx, translate: undefined }).toStrictEqual(snapshot);
      expect(apiClient).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    } finally { off(); offAccepted(); client.clear(); }
  });
});

describe('pure boundaries not reachable from a stable upstream projection', () => {
  const base: WorldGenerationRequestContext = { nodeId: id, projectId: 'project', canvasId: 'default', data: {},
    blocked: false, isGenerating: false, upstream: { nodeId: 'source', kind: 'image' }, sourceNode: null,
    productOperation: null, translate: key => key };
  it.each([
    { name: 'missing source node', node: null, code: 'missing_source_node' },
    { name: 'missing source URL', node: { id: 'source', type: CANVAS_NODE_TYPES.imageGen, position: { x: 0, y: 0 }, data: {} } satisfies CanvasNode, code: 'missing_source_url' },
    { name: 'inline source differs from browser forwarding', node: { id: 'source', type: CANVAS_NODE_TYPES.imageGen, position: { x: 0, y: 0 }, data: { imageUrl: 'data:image/png;base64,AAAA' } } satisfies CanvasNode, code: 'inline_media_reference' },
    { name: 'uppercase inline source', node: { id: 'source', type: CANVAS_NODE_TYPES.imageGen, position: { x: 0, y: 0 }, data: { imageUrl: 'DATA:image/png;base64,AAAA' } } satisfies CanvasNode, code: 'inline_media_reference' },
    { name: 'whitespace prefixed inline source', node: { id: 'source', type: CANVAS_NODE_TYPES.imageGen, position: { x: 0, y: 0 }, data: { imageUrl: ' \tdata:image/png;base64,AAAA' } } satisfies CanvasNode, code: 'inline_media_reference' },
  ])('$name', ({ node, code }) => {
    const decision = buildWorldGenerationRequest({ ...base, sourceNode: node });
    expect(decision).toStrictEqual({ ok: false, code, patches: [] });
  });
  it.each(['audioTranslateRequest', 'worldGenerationRequest', 'worldGenerationResult'])('%s runtime imports stay pure', name => {
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
