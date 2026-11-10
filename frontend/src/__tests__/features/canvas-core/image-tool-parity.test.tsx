// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import path from 'node:path';
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
import { buildImageToolRequest, GRID_RUN_ACTIONS } from '@/features/canvas/application/generationRequests/imageToolRequest';
import type { ImageToolAction, ImageToolRequestContext } from '@/features/canvas/application/generationRequests/imageToolRequest';
import {
  imageToolAcceptedPatch, imageToolOutputResolution, imageToolSuccessPatch,
  imageToolFailurePatch, imageToolViewerPlan, imageToolActionResult,
} from '@/features/canvas/application/generationRequests/imageToolResult';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { DEFAULT_SHARED_MODEL_ID } from '@/features/canvas/domain/defaultModelIds';
import { DEFAULT_UPSCALE_MODEL_ID } from '@/features/canvas/domain/modelOptions';
import type { ModelOption } from '@/features/canvas/domain/modelOptions';
import { SelectedNodeOverlay } from '@/features/canvas/ui/SelectedNodeOverlay';
import { useCanvasStore } from '@/stores/canvasStore';
import { collectImportGraph } from './importGraph';

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
const translate = (key: string) => `translated:${key}`;
// Independent action inventory: removing a mapping cannot silently remove coverage.
const actions = [
  'run_outpaint_tool', 'run_upscale_tool', 'run_scene360_tool',
  'run_grid_multi_camera', 'run_grid_plot_four', 'run_grid_face_three_view',
  'run_grid_product_three_view', 'run_grid_serial_storyboard_25',
  'run_grid_cinematic_light_correction', 'run_grid_character_three_view',
  'run_grid_scene_setting_sheet', 'run_grid_frame_projection_3s_later',
  'run_grid_frame_projection_5s_earlier',
] as const satisfies readonly ImageToolAction[];
const model = (id: string, apiModel: string): ModelOption => ({ id, apiModel, providerId: 'newapi', label: id });
const catalogs = [
  { name: 'defaults after first', models: [model('first', 'first-api'), model(DEFAULT_SHARED_MODEL_ID, 'default-api'),
    ...(DEFAULT_UPSCALE_MODEL_ID === DEFAULT_SHARED_MODEL_ID ? [] : [model(DEFAULT_UPSCALE_MODEL_ID, 'upscale-api')])] },
  { name: 'without defaults', models: [model('first', 'first-api'), model('second', 'second-api')] },
  { name: 'empty', models: [] },
  { name: 'empty api model', models: [model('first', '')] },
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
  action: ImageToolAction;
  models?: ModelOption[];
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
    task_type: fixture.action === 'run_outpaint_tool' ? 'freezone_outpaint'
      : fixture.action === 'run_upscale_tool' ? 'freezone_upscale'
        : fixture.action === 'run_scene360_tool' ? 'freezone_scene_360' : 'freezone_template_edit' };
  const project = fixture.project ?? projectId;
  window.history.replaceState(null, '', project ? `/projects/${encodeURIComponent(project)}/freezone` : '/');
  catalog.models = fixture.models ?? catalogs[0].models;
  const nodes = fixture.nodes ?? [sourceNode()];
  useCanvasStore.getState().setCanvasData([], []);
  // Seed the live snapshot, without hydration renaming projection ids or normalizing ratios.
  useCanvasStore.setState({ nodes, edges: [], selectedNodeId: null, activeOverlayNodeId: 'parity-overlay' });
  const ctx: ImageToolRequestContext = {
    action: fixture.action, nodes: structuredClone(nodes), nodeId: 'source',
    projectId: project, imageModels: catalog.models, translate, nowMs,
  };
  const before = structuredClone(ctx.nodes);
  const request = buildImageToolRequest(ctx);
  expect(ctx.nodes).toStrictEqual(before);
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
    return { task_type: task.task_type, task_key: task.task_key, username: 'test-user', project,
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
    if (!request.ok) {
      expect(results).toStrictEqual([{ ...envelope, ...imageToolActionResult({ message: request.message }) }]);
      expect(accepted).toStrictEqual([]); expect(children).toStrictEqual([]);
      expect(edges).toStrictEqual([]); expect(patches).toStrictEqual([]); expect(layouts).toStrictEqual([]);
      expect(submitted).toStrictEqual([]);
      expect(awaitTaskCompletion).not.toHaveBeenCalled(); expect(fetchFreezoneJobResult).not.toHaveBeenCalled();
      return request;
    }
    expect(accepted).toStrictEqual([envelope]);
    expect(submitted).toStrictEqual([{ route: request.route, body: request.body }]);
    const child = children[0];
    expect({ type: child.type, data: child.data }).toStrictEqual({ type: request.child.type, data: request.child.data });
    expect(layouts[0]).toStrictEqual({ ...request.child.layout, position: child.position });
    expect(edges[0]).toStrictEqual({ source: request.edge.source, target: child.id });
    const failure = fixture.fault !== undefined;
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    const expectedPatches: Record<string, unknown>[] = fixture.fault === 'submit' ? [] : [imageToolAcceptedPatch(task)];
    let url = '';
    if (failure) expectedPatches.push(imageToolFailurePatch(message));
    else {
      const resolution = imageToolOutputResolution({ result: fixture.result === undefined ? { output_url: outputUrl } : fixture.result, task });
      if (resolution.kind === 'fetch_job_result') {
        expect(resolution).toStrictEqual({ kind: 'fetch_job_result', task_type: task.task_type, job_id: task.job_id });
        url = fixture.fallbackUrl ?? outputUrl;
      } else url = resolution.url;
      expectedPatches.push(imageToolSuccessPatch({ action: fixture.action, url }));
    }
    expect(patches).toStrictEqual(expectedPatches.map(patch => ({ id: child.id, patch })));
    const viewer = imageToolViewerPlan({ action: fixture.action, childNodeId: child.id });
    const hasViewer = !failure && viewer !== null;
    expect(children).toHaveLength(hasViewer ? 2 : 1);
    expect(edges).toHaveLength(hasViewer ? 2 : 1); expect(layouts).toHaveLength(hasViewer ? 2 : 1);
    if (hasViewer) {
      expect({ type: children[1].type, data: children[1].data }).toStrictEqual({ type: viewer.node.type, data: undefined });
      expect(layouts[1]).toStrictEqual({ ...viewer.node.layout, position: children[1].position });
      expect(edges[1]).toStrictEqual({ source: viewer.edge.source, target: children[1].id });
    }
    const actionResult = failure ? imageToolActionResult({ message })
      : fixture.action === 'run_scene360_tool'
        ? imageToolActionResult({ action: fixture.action, childNodeId: child.id, viewerNodeId: children[1].id, url, task })
        : imageToolActionResult({ action: fixture.action, childNodeId: child.id, url, task });
    expect(results).toStrictEqual([{ ...envelope, ...actionResult }]);
    expect(trace).toStrictEqual(['accepted', 'node', 'edge', 'submit',
      ...(fixture.fault === 'submit' ? [] : ['patch']), 'patch', ...(hasViewer ? ['node', 'edge'] : []), 'result']);
    expect(vi.mocked(awaitTaskCompletion).mock.calls).toStrictEqual(fixture.fault === 'submit' ? [] : [[task.task_key, project]]);
    const needsFallback = fixture.fault !== 'submit' && fixture.fault !== 'wait'
      && fixture.result !== undefined && fixture.result?.output_url == null;
    expect(vi.mocked(fetchFreezoneJobResult).mock.calls).toStrictEqual(needsFallback ? [[project, task.task_type, task.job_id]] : []);
    expect(useCanvasStore.getState().edges.map(({ source, target }) => ({ source, target }))).toStrictEqual(edges);
    const finalData: Record<string, unknown> = { ...useCanvasStore.getState().nodes.find(node => node.id === child.id)?.data };
    for (const [key, value] of Object.entries(Object.assign({}, request.child.data, ...expectedPatches))) {
      expect(finalData[key]).toStrictEqual(value);
    }
    return request;
  } finally {
    offAccepted(); offResult(); cleanup(); queryClient.clear();
    expect(fetch).not.toHaveBeenCalled(); expect(apiClient).not.toHaveBeenCalled();
    expect(apiCallEnvelope).not.toHaveBeenCalled();
  }
}

describe('direct image tools against the real node-action subscriber', () => {
  for (const action of actions) {
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
  for (const action of ['run_outpaint_tool', 'run_upscale_tool'] as const) {
    it.each(catalogs)(`${action}: $name catalog`, async ({ models }) => { await compareBrowser({ action, models }); });
  }
  it.each([
    { name: 'image reference fallback', node: { ...sourceNode(), type: CANVAS_NODE_TYPES.imageGen,
      data: { referenceImageUrl: sourceUrl } } },
    { name: 'upload preview fallback and numeric ratio', node: { ...sourceNode(), type: CANVAS_NODE_TYPES.upload,
      data: { previewImageUrl: sourceUrl, aspectRatio: 2 } } },
    { name: 'export image and empty ratio', node: { ...sourceNode(), type: CANVAS_NODE_TYPES.exportImage,
      data: { imageUrl: sourceUrl, aspectRatio: '' } } },
  ])('$name', async ({ node }) => { await compareBrowser({ action: 'run_outpaint_tool', nodes: [node as CanvasNode] }); });
  it.each([
    { name: 'empty Error message', thrown: new Error('') },
    { name: 'non-Error rejection', thrown: 'Raw failure' },
    { name: 'poll timeout', thrown: new TaskPollTimeoutError('image-tool-task', 1000) },
  ])('$name is an ordinary tool failure', async ({ thrown }) => {
    await compareBrowser({ action: 'run_scene360_tool', fault: 'wait', thrown });
  });
});

describe('pure image-tool boundary', () => {
  it('exports the complete grid action mapping', () => {
    expect(Object.keys(GRID_RUN_ACTIONS)).toStrictEqual(actions.slice(3));
  });
  it.each(actions.flatMap(action => ['data:image/png;base64,AA==', 'blob:https://media.example.test/image'].map(imageUrl => ({ action, imageUrl }))))(
    'refuses inline source: $action $imageUrl', ({ action, imageUrl }) => {
      const result = buildImageToolRequest({ action, nodes: [sourceNode({ imageUrl })], nodeId: 'source',
        projectId, imageModels: catalogs[0].models, translate, nowMs });
      expect(result).toStrictEqual({ ok: false, message: 'Inline image sources must be prepared before building an image tool request.' });
      expect(JSON.stringify(result)).not.toContain(imageUrl);
    },
  );
  it('loads the barrel without browser dependencies', () => {
    const srcRoot = path.resolve(__dirname, '../../..');
    const graph = collectImportGraph([path.join(srcRoot, 'features/canvas/application/generationRequests/index.ts')], srcRoot);
    expect([...graph.files].filter(file => /^(api|lib|stores|hooks|components|routes)\//.test(path.relative(srcRoot, file))
      || file.endsWith('.tsx'))).toStrictEqual([]);
    expect([...graph.packages.keys()].filter(name => !['i18next', 'uuid', 'zustand/vanilla'].includes(name))).toStrictEqual([]);
  });
});
