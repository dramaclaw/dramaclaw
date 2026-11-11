// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiCall, apiCallEnvelope, apiClient } from '@/api/client';
import { fetchFreezoneJobResult } from '@/api/ops';
import type { FreezoneJobRef } from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { dispatchNodeAction } from '@/features/canvas/application/nodeActionResult';
import type { CanvasEventMap } from '@/features/canvas/application/ports';
import { buildImageToolRequest } from '@/features/canvas/application/generationRequests/imageToolRequest';
import type { ImageToolAction, ImageToolRequestContext } from '@/features/canvas/application/generationRequests/imageToolRequest';
import {
  imageToolAcceptedPatch, imageToolOutputResolution, imageToolSuccessPatch,
  imageToolFailurePatch, imageToolActionResult, imageToolViewerPlan,
} from '@/features/canvas/application/generationRequests/imageToolResult';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { DEFAULT_SHARED_MODEL_ID } from '@/features/canvas/domain/defaultModelIds';
import { DEFAULT_UPSCALE_MODEL_ID } from '@/features/canvas/domain/modelOptions';
import type { ModelOption } from '@/features/canvas/domain/modelOptions';
import { SelectedNodeOverlay } from '@/features/canvas/ui/SelectedNodeOverlay';
import { useCanvasStore } from '@/stores/canvasStore';

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
const gridActions = [
  'run_grid_multi_camera', 'run_grid_plot_four', 'run_grid_face_three_view',
  'run_grid_product_three_view', 'run_grid_serial_storyboard_25',
  'run_grid_cinematic_light_correction', 'run_grid_character_three_view',
  'run_grid_scene_setting_sheet', 'run_grid_frame_projection_3s_later',
  'run_grid_frame_projection_5s_earlier',
] as const satisfies readonly Exclude<ImageToolAction, 'run_scene360_tool'>[];
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
  requestFocusNode: useCanvasStore.getState().requestFocusNode,
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
  catalog.models = fixture.models ?? defaultModels;
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
    requestFocusNode: (id) => {
      expect(useCanvasStore.getState().nodes.filter(node => node.selected).map(node => node.id)).toStrictEqual([id]);
      trace.push('select/focus');
      original.requestFocusNode(id);
    },
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
  const submitted: { method: string | undefined; path: string; body: unknown }[] = [];
  const thrown = fixture.thrown ?? new Error('Tool failed');
  vi.mocked(apiCall).mockImplementation(async (route, options) => {
    // The mounted upscale settings panel can request a price; no transport runs.
    if (!route.includes('/freezone/')) return {};
    submitted.push({ method: options?.method, path: route, body: options?.json }); trace.push('submit');
    if (fixture.fault === 'submit') throw thrown;
    return task;
  });
  vi.mocked(awaitTaskCompletion).mockImplementation(async () => {
    trace.push('wait');
    if (fixture.fault === 'wait') throw thrown;
    return { task_type: task.task_type, task_key: task.task_key, username: '', project,
      episode: 1, status: 'completed', result: fixture.result === undefined ? { output_url: outputUrl } : fixture.result };
  });
  vi.mocked(fetchFreezoneJobResult).mockImplementation(async () => {
    trace.push('fetch');
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
      expect(trace).toStrictEqual(['result']);
      expect(awaitTaskCompletion).not.toHaveBeenCalled(); expect(fetchFreezoneJobResult).not.toHaveBeenCalled();
      return request;
    }
    expect(accepted).toStrictEqual([envelope]);
    expect(submitted).toStrictEqual([{ method: 'POST', path: request.route, body: request.body }]);
    const child = children[0];
    expect({ type: child.type, data: child.data }).toStrictEqual({ type: request.child.type, data: request.child.data });
    expect(JSON.stringify(child.data)).toBe(JSON.stringify(request.child.data));
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
    const viewerPlan = failure ? null : imageToolViewerPlan({ action: fixture.action, childNodeId: child.id });
    if (viewerPlan) {
      const viewer = children[1];
      expect(viewer.type).toBe(viewerPlan.node.type);
      expect(viewer.data).toBeUndefined();
      expect(layouts[1]).toStrictEqual({ ...viewerPlan.node.layout, position: viewer.position });
      expect(edges[1]).toStrictEqual({ source: viewerPlan.edge.source, target: viewer.id });
    }
    expect(children).toHaveLength(viewerPlan ? 2 : 1);
    expect(edges).toHaveLength(viewerPlan ? 2 : 1);
    expect(layouts).toHaveLength(viewerPlan ? 2 : 1);
    const actionResult = failure ? imageToolActionResult({ message })
      : fixture.action === 'run_scene360_tool'
        ? imageToolActionResult({ action: fixture.action, childNodeId: child.id, viewerNodeId: children[1].id, url, task })
        : imageToolActionResult({ action: fixture.action, childNodeId: child.id, url, task });
    expect(results).toStrictEqual([{ ...envelope, ...actionResult }]);
    expect(trace).toStrictEqual(['accepted', 'node', 'edge', 'select/focus', 'submit',
      ...(fixture.fault === 'submit' ? [] : ['patch', 'wait']),
      ...(fixture.fault !== 'submit' && fixture.fault !== 'wait'
        && fixture.result !== undefined && fixture.result?.output_url == null ? ['fetch'] : []),
      'patch', ...(viewerPlan ? ['node', 'edge', 'select/focus'] : []), 'result']);
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

describe('direct image tool delegation', () => {
  it('scene-360 direct-output success', async () => {
    await compareBrowser({ action: 'run_scene360_tool' });
  });
  it('scene-360 missing-output fallback', async () => {
    await compareBrowser({ action: 'run_scene360_tool', result: {} });
  });
  it('scene-360 wait failure', async () => {
    await compareBrowser({ action: 'run_scene360_tool', fault: 'wait' });
  });
  it('scene-360 missing-project refusal', async () => {
    await compareBrowser({ action: 'run_scene360_tool', project: '' });
  });
  it('outpaint success with defaults catalog', async () => {
    await compareBrowser({ action: 'run_outpaint_tool', models: defaultModels });
  });
  it('upscale success with empty catalog', async () => {
    await compareBrowser({ action: 'run_upscale_tool', models: [] });
  });
  it.each(gridActions)('%s success', async action => {
    await compareBrowser({ action });
  });
  it('forwards inline outpaint source', async () => {
    await compareBrowser({ action: 'run_outpaint_tool', nodes: [sourceNode({ imageUrl: 'data:image/png;base64,AA==' })] });
  });
  it('upscale missing-output fallback', async () => {
    await compareBrowser({ action: 'run_upscale_tool', result: {} });
  });
  it('grid submit failure', async () => {
    await compareBrowser({ action: 'run_grid_multi_camera', fault: 'submit' });
  });
  it('missing-project refusal', async () => {
    await compareBrowser({ action: 'run_outpaint_tool', project: '' });
  });
});
