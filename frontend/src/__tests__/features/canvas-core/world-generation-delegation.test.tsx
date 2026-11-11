// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import en from '../../../../public/locales/en/translation.json';
import { apiCall, apiClient } from '@/api/client';
import { awaitTaskCompletion, TaskPollTimeoutError } from '@/api/tasks';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { dispatchNodeAction } from '@/features/canvas/application/nodeActionResult';
import { bindWorkflowProductOperation, clearWorkflowProductOperation } from '@/features/canvas/application/workflowExecutionActivity';
import {
  selectWorldUpstreamFromNodes, buildWorldGenerationRequest, worldGenerationStartPatch, worldGenerationAcceptedPatch,
  worldGenerationSuccessPatch, worldGenerationFailureOutcome, worldGenerationActionResult,
  type WorldGenerationRequestContext,
} from '@/features/canvas/application/generationRequests';
import { CANVAS_NODE_TYPES, isThreeDWorldNode, type CanvasNode, type ThreeDWorldNodeData } from '@/features/canvas/domain/canvasNodes';
import type { DirectorWorldSource } from '@/features/viewer-kit/three-d/directorManifest';
import { ThreeDWorldNode } from '@/features/canvas/nodes/ThreeDWorldNode';
import { useCanvasStore } from '@/stores/canvasStore';
import { upstreamNodesInEdgeOrder } from '@/features/canvas/nodes/referenceOrdering';

const scope = vi.hoisted(() => ({ project: 'world/project', canvas: undefined as string | undefined, blocked: false, renderedSourceNodeId: undefined as string | undefined, manual: false }));
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
interface Fixture {
  name: string;
  renderedSourceNodeId?: string;
  manual?: boolean;
  source?: Record<string, unknown>;
  data?: Partial<ThreeDWorldNodeData>;
  upstream?: 'text';
  canvas?: string;
  fault?: 'timeout';
  operation?: { projectId: string; operationId: string; generationAttemptId?: string };
}
const fixtures: Fixture[] = [
  { name: 'explicit canvas and operation', canvas: 'canvas/2', operation: { projectId: 'world/project', operationId: 'operation', generationAttemptId: 'attempt' } },
  { name: 'pano source', source: { aspectRatio: '2:1' } },
  { name: 'inline source', source: { imageUrl: 'data:image/png;base64,AAAA' } },
  { name: 'rendered preference wins over graph preference', renderedSourceNodeId: 'later', data: { sourceNodeId: 'source' } },
  { name: 'text upstream refusal', upstream: 'text' },
  { name: 'poll timeout', fault: 'timeout' },
  { name: 'manual generate button', manual: true },
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
  return <ThreeDWorldNode id={id} type={node.type} data={{ ...node.data, ...(scope.renderedSourceNodeId ? { sourceNodeId: scope.renderedSourceNodeId } : {}) }} selected={scope.manual} dragging={false} draggable selectable deletable zIndex={0} isConnectable positionAbsoluteX={0} positionAbsoluteY={0} />;
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

it.each(fixtures)('$name', async fixture => {
  const translator = createInstance();
  await translator.init({ lng: 'en', fallbackLng: false, resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  const translate = (key: string, options?: Record<string, unknown>) => translator.t(key, options);
  scope.canvas = fixture.canvas;
  scope.renderedSourceNodeId = fixture.renderedSourceNodeId; scope.manual = fixture.manual ?? false;
  const source: CanvasNode = fixture.upstream === 'text'
    ? { id: 'source', type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 0, y: 0 }, data: { content: 'An open field.' } }
    : { id: 'source', type: CANVAS_NODE_TYPES.imageGen, position: { x: 0, y: 0 }, data: { imageUrl: sourceUrl, displayName: 'Source', ...fixture.source } };
  const world: CanvasNode = { id, type: CANVAS_NODE_TYPES.threeDWorld, position: { x: 300, y: 0 }, data: {
    displayName: 'World', sources: [oldSource], plyUrl: 'https://media.example.test/previous.sog', panoUrl: oldSource.url,
    generationStartedAt: 10, errorMessage: 'Previous error', ...fixture.data,
  } };
  const later: CanvasNode = { id: 'later', type: CANVAS_NODE_TYPES.imageGen, position: { x: 0, y: 100 }, data: { imageUrl: 'https://media.example.test/later.png' } };
  const sources = fixture.renderedSourceNodeId ? [source, later] : [source];
  useCanvasStore.getState().setCanvasData([world, ...sources], sources.map(node => ({ id: `edge-${node.id}`, source: node.id, target: id })));
  if (fixture.operation) bindWorkflowProductOperation(id, fixture.operation);
  const result = { ply_url: worldUrl };
  vi.mocked(apiCall).mockImplementation(async route => {
    if (route.endsWith('/freezone/image-to-3gs')) return ref;
    if (route.includes('generation-history')) return [];
    throw new Error(`Unexpected API route: ${route}`);
  });
  let sourcesAtCompletion: DirectorWorldSource[] = [];
  vi.mocked(awaitTaskCompletion).mockImplementation(async () => {
    vi.mocked(Date.now).mockReturnValue(completedAt);
    sourcesAtCompletion = structuredClone(currentData().sources ?? []);
    if (fixture.fault === 'timeout') throw new TaskPollTimeoutError(ref.task_key, 100);
    return { ...ref, username: 'test', project: scope.project, episode: 0, status: 'completed', result };
  });
  const writes: Record<string, unknown>[] = [];
  useCanvasStore.setState({ updateNodeData: (nodeId, patch) => {
    writes.push(structuredClone(patch)); originalUpdate(nodeId, patch);
  } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<I18nextProvider i18n={translator}><QueryClientProvider client={client}><ReactFlowProvider><Target /></ReactFlowProvider></QueryClientProvider></I18nextProvider>);
  const initial = { ...structuredClone(currentData()), ...(fixture.renderedSourceNodeId ? { sourceNodeId: fixture.renderedSourceNodeId } : {}) };
  const state = useCanvasStore.getState();
  const selection = selectWorldUpstreamFromNodes({ upstreamNodes: upstreamNodesInEdgeOrder(state.nodes, state.edges, id), sourceNodeId: initial.sourceNodeId });
  const ctx: WorldGenerationRequestContext = { nodeId: id, projectId: scope.project, canvasId: scope.canvas ?? 'default',
    data: initial, blocked: scope.blocked, isGenerating: initial.isGenerating === true,
    ...selection, productOperation: fixture.operation ?? null, translate };
  const snapshot = structuredClone({ ...ctx, translate: undefined });
  const decision = buildWorldGenerationRequest(ctx);
  writes.length = 0;
  const events: unknown[] = []; const accepted: unknown[] = [];
  const off = canvasEventBus.subscribe('freezone/node-action-result', event => events.push(event));
  const offAccepted = canvasEventBus.subscribe('freezone/node-action-accepted', event => accepted.push(event));
  try {
    if (fixture.manual) {
      fireEvent.click(screen.getByTitle(translate('nodeToolbar.generateDirectorWorld')));
      await waitFor(() => expect(currentData().plyUrl).toBe(worldUrl));
    } else {
      act(() => { dispatchNodeAction({ nodeId: id, action: 'generate_3gs_world', requestId: fixture.name }); });
      await waitFor(() => expect(events).toHaveLength(1));
    }
    const patches: Record<string, unknown>[] = [];
    let output = {};
    if (!decision.ok) patches.push(...decision.patches);
    else {
      patches.push(worldGenerationStartPatch({ request: decision, data: initial, startedAtMs: now }));
      patches.push(worldGenerationAcceptedPatch(ref));
      if (fixture.fault) {
        const outcome = worldGenerationFailureOutcome({ kind: 'poll_timeout' }, translate);
        patches.push(...outcome.patches);
        expect(outcome.notice).toBe('still_running');
      } else {
        const completed = worldGenerationSuccessPatch({ result, generatedId: `generated-sog:${decision.sourceKind}:${completedAt}`,
          sourceKind: decision.sourceKind, rawPanoSource: decision.rawPanoSource, currentSources: sourcesAtCompletion,
          labels: { pano3dgs: translate('node.threeDWorld.pano3dgsLabel'), image3dgs: translate('node.threeDWorld.image3dgsLabel'), worldUrlMissing: translate('node.threeDWorld.worldUrlMissing') } });
        if (completed.kind !== 'completed') throw new Error('Expected world completion');
        patches.push(completed.patch); output = completed.output;
      }
    }
    expect(writes).toStrictEqual(patches);
    const expectedData = Object.assign({}, initial, ...patches);
    expect(currentData()).toStrictEqual(expectedData);
    expect(events).toStrictEqual(fixture.manual ? [] : [{ requestId: fixture.name, nodeId: id, action: 'generate_3gs_world',
      ...worldGenerationActionResult({ output, latestNode: useCanvasStore.getState().nodes.find(node => node.id === id) }) }]);
    expect(accepted).toStrictEqual(fixture.manual ? [] : [{ requestId: fixture.name, nodeId: id, action: 'generate_3gs_world' }]);
    expect(vi.mocked(apiCall).mock.calls.filter(([, options]) => options?.method === 'POST').map(([path, options]) => ({ method: options?.method, path, body: options?.json })))
      .toStrictEqual(decision.ok ? [decision.request] : []);

    expect({ ...ctx, translate: undefined }).toStrictEqual(snapshot);
    expect(apiClient).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  } finally { off(); offAccepted(); client.clear(); }
});
