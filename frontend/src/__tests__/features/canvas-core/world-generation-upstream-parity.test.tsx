// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import en from '../../../../public/locales/en/translation.json';
import { apiCall, apiClient } from '@/api/client';
import { awaitTaskCompletion } from '@/api/tasks';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { dispatchNodeAction } from '@/features/canvas/application/nodeActionResult';
import {
  selectWorldGenerationUpstream, buildWorldGenerationRequest, worldGenerationStartPatch,
  worldGenerationAcceptedPatch, worldGenerationSuccessPatch, worldGenerationActionResult,
} from '@/features/canvas/application/generationRequests';
import { isThreeDWorldNode } from '@/features/canvas/domain/canvasNodes';
import { ThreeDWorldNode } from '@/features/canvas/nodes/ThreeDWorldNode';
import { useCanvasStore } from '@/stores/canvasStore';
import { worldUpstreamFixtures, worldId } from './worldUpstreamFixtures';

vi.mock('@/lib/url-params', async original => ({ ...(await original<typeof import('@/lib/url-params')>()), readUrl: () => ({ project: 'world/project' }) }));
vi.mock('@/lib/model-task-access', async original => ({ ...(await original<typeof import('@/lib/model-task-access')>()), useModelTaskAccess: () => ({ blocked: false }) }));
vi.mock('@/lib/queries/generation-credit-cost', async original => ({ ...(await original<typeof import('@/lib/queries/generation-credit-cost')>()), useGenerationCreditCost: () => ({}) }));
vi.mock('@/api/client', async original => ({ ...(await original<typeof import('@/api/client')>()), apiCall: vi.fn(), apiClient: vi.fn(() => { throw new Error('Unexpected transport'); }) }));
vi.mock('@/api/tasks', async original => ({ ...(await original<typeof import('@/api/tasks')>()), awaitTaskCompletion: vi.fn() }));
vi.mock('@/i18n', async () => ({ default: (await import('i18next')).default }));

const now = 1700000000000;
const ref = { task_key: 'world-task', task_type: 'freezone_image_to_3gs', job_id: 'world-job' };
const result = { ply_url: 'https://media.example.test/world.ply' };
const originalUpdate = useCanvasStore.getState().updateNodeData;
function currentWorld() {
  const node = useCanvasStore.getState().nodes.find(n => n.id === worldId);
  if (!isThreeDWorldNode(node)) throw new Error('Missing world');
  return node;
}
function Target() {
  useCanvasStore(state => state.nodes.find(n => n.id === worldId)?.data);
  const node = currentWorld();
  return <ThreeDWorldNode id={worldId} type={node.type} data={node.data} selected={false} dragging={false} draggable selectable deletable zIndex={0} isConnectable positionAbsoluteX={0} positionAbsoluteY={0} />;
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
afterEach(() => {
  cleanup();
  useCanvasStore.setState({ updateNodeData: originalUpdate });
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it.each(worldUpstreamFixtures)('real world action matches pure selection: $name', async fixture => {
  const translator = createInstance();
  await translator.init({ lng: 'en', fallbackLng: false, resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
  const translate = (key: string, options?: Record<string, unknown>) => translator.t(key, options);
  const canvas = structuredClone(fixture.canvas);
  const snapshot = structuredClone(canvas);
  // Preserve the graph exactly, including dangling edges and absent positions.
  useCanvasStore.setState({ nodes: canvas.nodes, edges: canvas.edges, selectedNodeId: null });
  vi.mocked(apiCall).mockImplementation(async route => {
    if (route.endsWith('/freezone/image-to-3gs')) return ref;
    if (route.includes('generation-history')) return [];
    throw new Error(`Unexpected API route: ${route}`);
  });
  vi.mocked(awaitTaskCompletion).mockResolvedValue({ ...ref, username: 'test', project: 'world/project', episode: 0, status: 'completed', result });
  const writes: { nodeId: string; patch: Record<string, unknown> }[] = [];
  useCanvasStore.setState({ updateNodeData: (nodeId, patch) => {
    writes.push({ nodeId, patch: structuredClone(patch) }); originalUpdate(nodeId, patch);
  } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const events: unknown[] = [], accepted: unknown[] = [];
  const off = canvasEventBus.subscribe('freezone/node-action-result', event => events.push(event));
  const offAccepted = canvasEventBus.subscribe('freezone/node-action-accepted', event => accepted.push(event));
  try {
    render(<I18nextProvider i18n={translator}><QueryClientProvider client={client}><ReactFlowProvider><Target /></ReactFlowProvider></QueryClientProvider></I18nextProvider>);
    const initial = structuredClone(currentWorld().data);
    const selection = selectWorldGenerationUpstream({ ...canvas, nodeId: worldId });
    expect(selection).toStrictEqual({ upstream: fixture.expected,
      sourceNode: fixture.expected?.kind === 'image' ? canvas.nodes.find(n => n.id === fixture.expected?.nodeId) : null });
    const decision = buildWorldGenerationRequest({ nodeId: worldId, projectId: 'world/project', canvasId: 'default',
      data: initial, blocked: false, isGenerating: false, ...selection, productOperation: null, translate });
    expect(canvas).toStrictEqual(snapshot);
    writes.length = 0;
    act(() => { dispatchNodeAction({ nodeId: worldId, action: 'generate_3gs_world', requestId: fixture.name }); });
    await waitFor(() => expect(events).toHaveLength(1));
    const patches: Record<string, unknown>[] = [];
    let output = {};
    if (!decision.ok) patches.push(...decision.patches);
    else {
      patches.push(worldGenerationStartPatch({ request: decision, data: initial, startedAtMs: now }), worldGenerationAcceptedPatch(ref));
      const success = worldGenerationSuccessPatch({ result, generatedId: `generated-sog:${decision.sourceKind}:${now}`,
        sourceKind: decision.sourceKind, rawPanoSource: decision.rawPanoSource, currentSources: initial.sources ?? [],
        labels: { pano3dgs: translate('node.threeDWorld.pano3dgsLabel'), image3dgs: translate('node.threeDWorld.image3dgsLabel'), worldUrlMissing: translate('node.threeDWorld.worldUrlMissing') } });
      if (success.kind !== 'completed') throw new Error('Expected successful world result');
      patches.push(success.patch); output = success.output;
    }
    expect(writes).toStrictEqual(patches.map(patch => ({ nodeId: worldId, patch })));
    expect(currentWorld().data).toStrictEqual(Object.assign({}, initial, ...patches));
    expect(events).toStrictEqual([{ requestId: fixture.name, nodeId: worldId, action: 'generate_3gs_world',
      ...worldGenerationActionResult({ output, latestNode: currentWorld() }) }]);
    expect(accepted).toStrictEqual([{ requestId: fixture.name, nodeId: worldId, action: 'generate_3gs_world' }]);
    expect(vi.mocked(apiCall).mock.calls.filter(([, options]) => options?.method === 'POST').map(([path, options]) => ({ method: options?.method, path, body: options?.json })))
      .toStrictEqual(decision.ok ? [decision.request] : []);
    expect(vi.mocked(awaitTaskCompletion).mock.calls).toStrictEqual(decision.ok ? [[ref.task_key, 'world/project', { taskType: ref.task_type }]] : []);
    expect(apiClient).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  } finally { off(); offAccepted(); client.clear(); }
});
