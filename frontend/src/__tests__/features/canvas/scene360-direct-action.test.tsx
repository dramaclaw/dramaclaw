// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiCall, apiCallEnvelope, apiClient } from '@/api/client';
import { fetchFreezoneJobResult } from '@/api/ops';
import type { FreezoneJobRef } from '@/api/ops';
import { awaitTaskCompletion, TaskPollTimeoutError } from '@/api/tasks';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { dispatchNodeAction } from '@/features/canvas/application/nodeActionResult';
import type { CanvasEventMap } from '@/features/canvas/application/ports';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { DEFAULT_SHARED_MODEL_ID } from '@/features/canvas/domain/defaultModelIds';
import { DEFAULT_UPSCALE_MODEL_ID } from '@/features/canvas/domain/modelOptions';
import type { ModelOption } from '@/features/canvas/domain/modelOptions';
import { SelectedNodeOverlay } from '@/features/canvas/ui/SelectedNodeOverlay';
import { useCanvasStore } from '@/stores/canvasStore';
import captured from '../canvas-core/imageToolExpected.json';

const catalog = vi.hoisted(() => ({ models: [] as ModelOption[] }));
// Keep the subscriber, store, URL parsing, source resolver and ops serializers real.
// Translation and the model source are deterministic; all HTTP exits are sealed.
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => `translated:${key}`, i18n: { language: 'en' } }),
}));
vi.mock('@/features/canvas/hooks/useFreezoneImageModels', async (original) => ({
  ...(await original<typeof import('@/features/canvas/hooks/useFreezoneImageModels')>()),
  getFreezoneImageModelsSnapshot: () => ({ models: catalog.models, isLoading: false, isFallback: false, error: null }),
  useFreezoneImageModels: () => ({ models: catalog.models, isLoading: false, isFallback: false, error: null }),
}));
vi.mock('@/api/client', async (original) => ({
  ...(await original<typeof import('@/api/client')>()),
  apiCall: vi.fn(() => { throw new Error('Unexpected apiCall'); }),
  apiCallEnvelope: vi.fn(() => { throw new Error('Unexpected apiCallEnvelope'); }),
  apiClient: vi.fn(() => { throw new Error('Unexpected apiClient'); }),
}));
vi.mock('@/api/ops', async (original) => ({
  ...(await original<typeof import('@/api/ops')>()), fetchFreezoneJobResult: vi.fn(),
}));
vi.mock('@/api/tasks', async (original) => ({
  ...(await original<typeof import('@/api/tasks')>()), awaitTaskCompletion: vi.fn(),
}));

const nowMs = 1234567890000;
const projectId = 'image tools / parity';
const sourceUrl = 'https://media.example.test/source.png?version=7&size=large';
const outputUrl = 'https://media.example.test/result.png';
const model = (id: string, apiModel: string): ModelOption => ({ id, apiModel, providerId: 'newapi', label: id });
const defaultModels = [
  model('first', 'first-api'), model(DEFAULT_SHARED_MODEL_ID, 'default-api'),
  ...(DEFAULT_UPSCALE_MODEL_ID === DEFAULT_SHARED_MODEL_ID ? [] : [model(DEFAULT_UPSCALE_MODEL_ID, 'upscale-api')]),
];
function sourceNode(data: Record<string, unknown> = {}): CanvasNode {
  return { id: 'source', type: CANVAS_NODE_TYPES.imageEdit, position: { x: 30, y: 60 }, data: {
    imageUrl: sourceUrl, aspectRatio: '16:9', projection_key: 'projection',
    committed_slot_url: 'https://media.example.test/slot.png',
    slot_target: { kind: 'scene_master', scene_id: 'scene-1' },
    mainline_context: [{ kind: 'scene', projectId, sceneId: 'scene-1', label: 'Scene' }],
    preset_managed: true, ...data,
  } } as CanvasNode;
}
type Fixture = {
  action: 'run_scene360_tool';
  result?: { output_url?: string | null } | null;
  fallbackUrl?: string;
  fault?: 'submit' | 'wait' | 'fetch';
  thrown?: unknown;
  nodes?: CanvasNode[];
  project?: string;
};
const original = {
  addNode: useCanvasStore.getState().addNode, addEdge: useCanvasStore.getState().addEdge,
  updateNodeData: useCanvasStore.getState().updateNodeData,
  findNodePosition: useCanvasStore.getState().findNodePosition,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(nowMs);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected fetch'); }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => {
  cleanup(); useCanvasStore.setState(original);
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

async function compareBrowser(fixture: Fixture) {
  const task: FreezoneJobRef = { task_key: 'image-tool-task', job_id: 'image-tool-job',
    task_type: 'freezone_scene_360' };
  const project = fixture.project ?? projectId;
  window.history.replaceState(null, '', project ? `/projects/${encodeURIComponent(project)}/freezone` : '/');
  catalog.models = defaultModels;
  const nodes = fixture.nodes ?? [sourceNode()];
  useCanvasStore.getState().setCanvasData([], []);
  // Seed the live snapshot, without hydration renaming projection ids or normalizing ratios.
  useCanvasStore.setState({ nodes, edges: [], selectedNodeId: null, activeOverlayNodeId: 'parity-overlay' });
  const trace: string[] = [];
  const children: { id: string; type: string; data: unknown; position: unknown }[] = [];
  const edges: { source: string; target: string }[] = [];
  const patches: { id: string; patch: Record<string, unknown> }[] = [];
  const layouts: { anchorNodeId: string; width: number | undefined; height: number | undefined; position: unknown }[] = [];
  useCanvasStore.setState({
    addNode: (...args) => {
      const id = original.addNode(...args);
      children.push({ id, type: args[0], data: structuredClone(args[2]), position: args[1] });
      trace.push('node'); return id;
    },
    addEdge: (source, target, ...rest) => {
      edges.push({ source, target }); trace.push('edge'); return original.addEdge(source, target, ...rest);
    },
    updateNodeData: (id, patch) => {
      patches.push({ id, patch: structuredClone(patch) }); trace.push('patch'); original.updateNodeData(id, patch);
    },
    findNodePosition: (anchorNodeId, width, height) => {
      const position = original.findNodePosition(anchorNodeId, width, height);
      layouts.push({ anchorNodeId, width, height, position }); return position;
    },
  });
  const submitted: { route: string; body: unknown }[] = [];
  const thrown = fixture.thrown ?? new Error('Tool failed');
  vi.mocked(apiCall).mockImplementation(async (route, options) => {
    // The mounted upscale settings panel can request a price; no transport runs.
    if (!route.includes('/freezone/')) return {};
    submitted.push({ route, body: options?.json }); trace.push('submit');
    if (fixture.fault === 'submit') throw thrown;
    return task;
  });
  vi.mocked(awaitTaskCompletion).mockImplementation(async () => {
    if (fixture.fault === 'wait') throw thrown;
    return { task_type: task.task_type, task_key: task.task_key, username: '', project,
      episode: 1, status: 'completed', result: fixture.result === undefined ? { output_url: outputUrl } : fixture.result };
  });
  vi.mocked(fetchFreezoneJobResult).mockImplementation(async () => {
    if (fixture.fault === 'fetch') throw thrown;
    return { url: fixture.fallbackUrl ?? outputUrl, size: 1 };
  });
  const envelope = { requestId: 'image-tool-request', nodeId: 'source', action: fixture.action };
  const accepted: CanvasEventMap['freezone/node-action-accepted'][] = [];
  const results: CanvasEventMap['freezone/node-action-result'][] = [];
  const offAccepted = canvasEventBus.subscribe('freezone/node-action-accepted', event => { accepted.push(event); trace.push('accepted'); });
  const offResult = canvasEventBus.subscribe('freezone/node-action-result', event => { results.push(event); trace.push('result'); });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    render(<QueryClientProvider client={queryClient}><ReactFlowProvider><SelectedNodeOverlay /></ReactFlowProvider></QueryClientProvider>);
    // Flush pending-action replay before dispatch; every action carries ignored overrides.
    await act(async () => {});
    act(() => { dispatchNodeAction({ ...envelope, parameters: {
      prompt: 'ignored override', model: 'ignored-model', scaleFactor: 6,
      aspectRatio: '9:16', imageSize: '4K', numImages: 4,
    } }); });
    await waitFor(() => expect(results).toHaveLength(1));
    const normalize = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, item) =>
      typeof item === 'string' && item === children[0]?.id ? 'child'
        : typeof item === 'string' && item === children[1]?.id ? 'viewer' : item));
    const name = expect.getState().currentTestName!.split(' > ').slice(-1)[0];
    expect(normalize({
      submitted, accepted, children: children.map(({ type, data }) => ({ type, data })),
      layouts: layouts.map(({ anchorNodeId, width, height }) => ({ anchorNodeId, width, height })),
      edges, patches: patches.map(({ patch }) => patch), result: results[0], trace,
    })).toStrictEqual(captured[name as keyof typeof captured]);
  } finally {
    offAccepted(); offResult(); cleanup(); queryClient.clear();
    expect(fetch).not.toHaveBeenCalled(); expect(apiClient).not.toHaveBeenCalled();
    expect(apiCallEnvelope).not.toHaveBeenCalled();
  }
}

describe('direct image tools against the real node-action subscriber', () => {
  for (const action of ['run_scene360_tool'] as const) {
    it.each([
      { name: 'direct output', result: { output_url: outputUrl } },
      { name: 'missing output fallback', result: {} },
      { name: 'null result fallback', result: null },
      { name: 'empty direct output', result: { output_url: '' } },
      { name: 'null output fallback', result: { output_url: null } },
      { name: 'empty fetched output', result: {}, fallbackUrl: '' },
    ])(`${action}: $name`, async fixture => { await compareBrowser({ action, ...fixture }); });
    it.each(['submit', 'wait', 'fetch'] as const)(`${action}: %s failure`, async fault => {
      await compareBrowser({ action, fault, result: {} });
    });
    it.each([
      { name: 'missing source', nodes: [sourceNode({ imageUrl: null })] },
      { name: 'missing node', nodes: [] },
      { name: 'missing project', project: '' },
    ])(`${action}: $name refusal`, async fixture => { await compareBrowser({ action, ...fixture }); });
  }
  it.each([
    { name: 'empty Error message', thrown: new Error('') },
    { name: 'non-Error rejection', thrown: 'Raw failure' },
    { name: 'poll timeout', thrown: new TaskPollTimeoutError('image-tool-task', 1000) },
  ])('$name is an ordinary tool failure', async ({ thrown }) => {
    await compareBrowser({ action: 'run_scene360_tool', fault: 'wait', thrown });
  });
});

