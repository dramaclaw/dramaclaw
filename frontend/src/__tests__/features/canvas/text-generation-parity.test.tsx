// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import path from 'node:path';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { apiCall } from '@/api/client';
import {
  buildTextGenerationRequest, textGenerationStartPatch, textGenerationOutcomePatch,
  type TextGenerationRequestContext,
} from '@/features/canvas/application/generationRequests';
import {
  describeGenerationSubmitFailure, generationErrorFromSubmitFailure,
  type GenerationSubmitFailure,
} from '@/features/canvas/application/generationRequests/generationSubmitError';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { dispatchNodeAction } from '@/features/canvas/application/nodeActionResult';
import type { CanvasEventMap } from '@/features/canvas/application/ports';
import { bindWorkflowProductOperation, clearWorkflowProductOperation } from '@/features/canvas/application/workflowExecutionActivity';
import {
  CANVAS_NODE_TYPES, isTextAnnotationNode,
  type CanvasNode, type TextAnnotationNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { TextAnnotationNode } from '@/features/canvas/nodes/TextAnnotationNode';
import { useCanvasStore } from '@/stores/canvasStore';
import { collectImportGraph } from '../canvas-core/importGraph';

const access = vi.hoisted(() => ({ blocked: false }));
// Deterministic language and URL inputs; preserve the translation setup plugin.
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/url-params', async (original) => ({
  ...(await original<typeof import('@/lib/url-params')>()),
  readUrl: () => ({ project: 'url-project', canvas: 'url-canvas' }),
}));
// These hooks otherwise fetch access and price data unrelated to recipe requests.
vi.mock('@/lib/model-task-access', async (original) => ({
  ...(await original<typeof import('@/lib/model-task-access')>()),
  useModelTaskAccess: () => ({ blocked: access.blocked, message: 'Access blocked', denialReason: null }),
}));
vi.mock('@/lib/queries/generation-credit-cost', async (original) => ({
  ...(await original<typeof import('@/lib/queries/generation-credit-cost')>()),
  useGenerationCreditCost: () => ({ data: undefined, error: null }),
}));
// Only the transport is replaced; the node, runtime and ops serializer stay real.
vi.mock('@/api/client', async (original) => ({
  ...(await original<typeof import('@/api/client')>()), apiCall: vi.fn(),
}));

function textNode(id: string, data: TextAnnotationNodeData): CanvasNode {
  return { id, type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 0, y: 0 }, data };
}
type Fixture = TextGenerationRequestContext & {
  name: string;
  expected?: Record<string, unknown>;
  response?: string;
  failure?: GenerationSubmitFailure;
  thrown?: { value: unknown };
  sameTurnPatch?: Partial<TextAnnotationNodeData>;
  inFlightPatch?: Partial<TextAnnotationNodeData>;
  blocked?: boolean;
};
function fixture(name: string, catalog: Record<string, unknown> = { recipeId: 'story' },
  extra: Partial<Fixture> = {}): Fixture {
  const nodeData: TextAnnotationNodeData = {
    content: '  Node prompt\n', instruction: 'Do not submit this instruction',
    workflowCatalog: catalog, generationError: 'old error', generationErrorDetails: 'old details',
    generationErrorRequestId: 'old-request', generationTaskKey: 'old-task',
    generationTaskType: 'old-type', generationTaskJobId: 'old-job', workflowResultStale: true,
  };
  return { name, nodeData, nodes: [textNode('target', nodeData)], edges: [], nodeId: 'target',
    productOperation: null, ...extra };
}
const upstream = [textNode('first', { content: ' First body ', workflowCatalog: { stepId: 'step-1' } }),
  textNode('second', { content: ' Second body ', workflowCatalog: { stepId: 'step-2' } }),
  textNode('dependency', { content: 'Excluded dependency' }),
  textNode('ancestor', { content: 'Excluded ancestor' })];
const edges = [
  { id: 'second', source: 'second', target: 'target' },
  { id: 'dependency', source: 'dependency', target: 'target', data: { link_type: 'dependency_for' } },
  { id: 'first', source: 'first', target: 'target' },
  { id: 'ancestor', source: 'ancestor', target: 'first' },
];
function graphFixture(name: string, catalog: Record<string, unknown>, expected: Record<string, unknown>): Fixture {
  const ctx = fixture(name, catalog, { expected });
  return { ...ctx, nodes: [...ctx.nodes, ...upstream], edges };
}
const http = { kind: 'http', method: 'POST', url: 'https://example.com/api/v1/freezone/recipes/generate-text' } as const;
const fixtures: Fixture[] = [
  fixture('recipe only and no product operation'),
  fixture('recipe version and mixed pipeline', { recipeId: ' story ', recipeVersion: ' v2 ',
    recipePipeline: [' intro ', { id: 'main', version: ' v3 ' }, '', '  ', { id: ' ' }, { id: 'outro' }] },
  { expected: { recipe_id: 'story', recipe_version: 'v2', recipe_pipeline: [{ id: 'intro' }, { id: 'main', version: 'v3' }, { id: 'outro' }] } }),
  fixture('blank pipeline omitted', { recipeId: 'story', recipePipeline: ['', { id: ' ' }] }),
  fixture('skill version and confirmed inputs', { recipeId: 'story', skillId: ' writer ', skillVersion: ' 4 ',
    confirmedInputs: { tone: 'gentle', count: 0 } },
  { expected: { skill_id: 'writer', skill_version: '4', confirmed_inputs: { tone: 'gentle', count: 0 } } }),
  fixture('skill fields ignored without skill id', { recipeId: 'story', skillVersion: '4', confirmedInputs: { tone: 'gentle' } }),
  fixture('user goal from catalog wins', { recipeId: 'story', userGoal: ' Catalog goal ', promptBuilder: { userGoal: 'Builder goal' } },
    { expected: { user_goal: 'Catalog goal' } }),
  fixture('user goal from prompt builder', { recipeId: 'story', userGoal: ' ', promptBuilder: { userGoal: ' Builder goal ' } },
    { expected: { user_goal: 'Builder goal' } }),
  graphFixture('input strategy none', { recipeId: 'story', inputStrategy: { type: 'none' } }, { upstream_text: '' }),
  graphFixture('input strategy user assets', { recipeId: 'story', inputStrategy: { type: 'user_assets' } }, { upstream_text: '' }),
  graphFixture('input strategy user message', { recipeId: 'story', inputStrategy: { type: 'user_message' } }, { upstream_text: '' }),
  graphFixture('step ids select workflow steps', { recipeId: 'story', inputStrategy: { type: 'steps', stepIds: ['step-1'] } }, { upstream_text: 'First body' }),
  graphFixture('single step id takes precedence', { recipeId: 'story', inputStrategy: { type: 'steps', stepId: 'step-2', stepIds: ['step-1'] } }, { upstream_text: 'Second body' }),
  graphFixture('builder input strategy snake case', { recipeId: 'story', promptBuilder: { inputStrategy: { type: 'steps', step_ids: ['step-1'] } } }, { upstream_text: 'First body' }),
  graphFixture('catalog strategy wins over builder', { recipeId: 'story', inputStrategy: { type: 'none' }, promptBuilder: { inputStrategy: { type: 'steps', stepId: 'step-1' } } }, { upstream_text: '' }),
  graphFixture('unmatched step ids give empty text', { recipeId: 'story', inputStrategy: { type: 'steps', step_id: 'absent' } }, { upstream_text: '' }),
  graphFixture('empty step ids retain all text', { recipeId: 'story', inputStrategy: { type: 'steps', stepIds: [] } }, { upstream_text: 'Second body\n\nFirst body' }),
  graphFixture('edge order ignores dependency and ancestor', { recipeId: 'story' }, { upstream_text: 'Second body\n\nFirst body' }),
  fixture('step selection without workflow ids uses fallback', { recipeId: 'story', inputStrategy: { type: 'steps', stepIds: ['absent'] } }, {
    nodes: [textNode('target', { content: 'ignored graph data' }), textNode('plain', { content: ' Plain body ' })],
    edges: [{ id: 'plain', source: 'plain', target: 'target' }], expected: { upstream_text: 'Plain body' },
  }),
  fixture('product operation with attempt', undefined, { productOperation: { projectId: 'bound-project', operationId: 'op-1', generationAttemptId: 'attempt-1' }, expected: { project_id: 'bound-project', product_operation_id: 'op-1' } }),
  fixture('product operation without attempt', undefined, { productOperation: { projectId: 'bound-project', operationId: 'op-1' }, expected: { project_id: 'bound-project', product_operation_id: 'op-1' } }),
  fixture('empty content', undefined, { nodeData: { content: '', workflowCatalog: { recipeId: 'story' } }, expected: { node_prompt: '' } }),
  fixture('missing recipe', {}),
  fixture('blank recipe', { recipeId: ' ' }),
  fixture('rendered props precede same turn store edits', undefined, { sameTurnPatch: { content: 'Latest store prompt', workflowCatalog: { recipeId: 'latest-recipe' } } }),
  fixture('completion overwrites in flight edits without arbitration', undefined, { inFlightPatch: { content: 'Edited while pending', generationTaskKey: 'new-task', generationError: 'later error' } }),
  fixture('agent bypasses busy and access guards', undefined, { blocked: true,
    nodeData: { content: '  Node prompt\n', isGenerating: true, workflowCatalog: { recipeId: 'story' } } }),
  fixture('API returns blank content', undefined, { response: '' }),
  fixture('API returns whitespace content as is', undefined, { response: ' \n ' }),
  fixture('insufficient credits raw message', undefined, { failure: { ...http, status: 402, statusText: 'Payment Required', body: { error: 'Raw credit failure', request_id: 'credit-request' } } }),
  fixture('plain backend error message', undefined, { failure: { ...http, status: 500, statusText: 'Server Error', body: { error: 'Raw backend failure' } } }),
  fixture('envelope failure message', undefined, { failure: { kind: 'envelope', body: { ok: false, error: 'Raw envelope failure' } } }),
  fixture('network failure message', undefined, { failure: { kind: 'thrown', name: 'TypeError', message: 'Network unavailable' } }),
  fixture('empty Error message stays empty', undefined, { failure: { kind: 'thrown', name: 'Error', message: '' } }),
  fixture('non Error uses literal node fallback', undefined, { thrown: { value: 'Opaque thrown value' } }),
  fixture('empty non Error publication stays empty', undefined, { thrown: { value: '' } }),
];

function currentData() {
  const node = useCanvasStore.getState().nodes.find((candidate) => candidate.id === 'target');
  if (!isTextAnnotationNode(node)) throw new Error('Missing target');
  return node.data;
}
function TargetNode({ nodeData }: { nodeData: TextAnnotationNodeData }) {
  return <TextAnnotationNode id="target" type={CANVAS_NODE_TYPES.textAnnotation} data={nodeData}
    selected={false} dragging={false} draggable selectable deletable zIndex={0} isConnectable
    positionAbsoluteX={0} positionAbsoluteY={0} />;
}
beforeEach(() => {
  vi.clearAllMocks(); access.blocked = false;
  // jsdom has no layout observer; retain the real header and resize controls.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected fetch'); }));
  vi.spyOn(toast, 'error');
});
afterEach(() => {
  cleanup(); clearWorkflowProductOperation('target'); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('TextAnnotationNode agent recipe parity', () => {
  it.each(fixtures)('$name', async (ctx) => {
    access.blocked = ctx.blocked ?? false;
    // Props may differ from the graph node; runRecipeText captures the rendered data.
    const nodes = ctx.nodes.map((node) => node.id === ctx.nodeId ? { ...node, data: ctx.nodeData } : node);
    useCanvasStore.getState().setCanvasData(structuredClone(nodes), structuredClone(ctx.edges));
    if (ctx.productOperation) bindWorkflowProductOperation(ctx.nodeId, ctx.productOperation);
    let resolveResponse: ((value: { content: string }) => void) | undefined;
    let rejectResponse: ((error: unknown) => void) | undefined;
    vi.mocked(apiCall).mockImplementation((route) => {
      if (route !== 'freezone/recipes/generate-text') throw new Error(`Unexpected API call: ${route}`);
      return new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><ReactFlowProvider><TargetNode nodeData={ctx.nodeData} /></ReactFlowProvider></QueryClientProvider>);
    let result: CanvasEventMap['freezone/node-action-result'] | undefined;
    const accepted: CanvasEventMap['freezone/node-action-accepted'][] = [];
    const unsubscribe = canvasEventBus.subscribe('freezone/node-action-result', (event) => { result = event; });
    const unsubscribeAccepted = canvasEventBus.subscribe('freezone/node-action-accepted', (event) => { accepted.push(event); });
    const startedAtMs = 1800000000000;
    vi.spyOn(Date, 'now').mockReturnValue(startedAtMs);
    const before = { ...currentData(), ...ctx.sameTurnPatch };
    try {
      act(() => {
        if (ctx.sameTurnPatch) useCanvasStore.getState().updateNodeData(ctx.nodeId, ctx.sameTurnPatch);
        dispatchNodeAction({ nodeId: ctx.nodeId, action: 'generate_text', requestId: ctx.name,
          executionMode: 'single', parameters: { content: 'Ignored action parameter' } });
      });
      expect(currentData()).toStrictEqual({ ...before, ...textGenerationStartPatch(startedAtMs) });
      expect(accepted).toStrictEqual([{ requestId: ctx.name, nodeId: ctx.nodeId, action: 'generate_text' }]);
      const decision = buildTextGenerationRequest({ ...ctx, nodes: useCanvasStore.getState().nodes });
      const wire = vi.mocked(apiCall).mock.calls.map(([route, options]) => ({
        method: options?.method, path: route, body: JSON.parse(JSON.stringify(options?.json)),
      }));
      let thrown: unknown;
      if (!decision.ok) {
        expect(ctx.name).toMatch(/^(missing|blank) recipe$/);
        expect(decision).toStrictEqual({ ok: false, code: 'missing_recipe', message: '文本节点缺少 Recipe' }); // i18n-exempt -- exact browser failure
        expect(wire).toStrictEqual([]);
        thrown = new Error(decision.message);
      } else {
        expect(wire).toStrictEqual(decision.requests);
        const expected = {
          recipe_id: 'story', recipe_version: '', skill_id: '', skill_version: '', confirmed_inputs: {},
          node_kind: 'text', node_prompt: '  Node prompt\n', user_goal: '', upstream_text: '', reference_media: [],
          ...ctx.expected,
        };
        expect(wire).toStrictEqual([{ method: 'POST', path: 'freezone/recipes/generate-text', body: expected }]);
        expect(vi.mocked(apiCall).mock.calls[0][1]?.timeout).toBe(600000);
        expect(resolveResponse).toBeTypeOf('function');
        const inFlightPatch = ctx.inFlightPatch;
        if (inFlightPatch) act(() => useCanvasStore.getState().updateNodeData(ctx.nodeId, inFlightPatch));
        if (ctx.failure) {
          thrown = generationErrorFromSubmitFailure(ctx.failure);
          const info = describeGenerationSubmitFailure(ctx.failure, (key) => key, 'Fallback');
          expect(info.message).toBe(thrown instanceof Error ? thrown.message : undefined);
        } else if (ctx.thrown) thrown = ctx.thrown.value;
        act(() => {
          if (ctx.failure || ctx.thrown) rejectResponse?.(thrown);
          else resolveResponse?.({ content: ctx.response ?? 'Generated body' });
        });
      }
      await waitFor(() => expect(result).toBeDefined());
      const failed = !decision.ok || ctx.failure !== undefined || ctx.thrown !== undefined;
      const outcome = textGenerationOutcomePatch({ outcome: failed
        ? { kind: 'failed', message: thrown instanceof Error ? thrown.message : String(thrown), isError: thrown instanceof Error }
        : { kind: 'completed', content: ctx.response ?? 'Generated body' } });
      expect(currentData()).toStrictEqual({ ...before, ...textGenerationStartPatch(startedAtMs), ...ctx.inFlightPatch, ...outcome.patch });
      expect(result).toStrictEqual({ requestId: ctx.name, nodeId: ctx.nodeId, action: 'generate_text',
        ...('output' in outcome ? { status: 'success', output: outcome.output } : { status: 'error', error: outcome.error.message }) });
      expect(toast.error).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally { unsubscribe(); unsubscribeAccepted(); client.clear(); }
  });

  it('loads pure request and result imports without browser dependencies', () => {
    const srcRoot = path.resolve(__dirname, '../../..');
    const graph = collectImportGraph(['textGenerationRequest.ts', 'textGenerationResult.ts'].map((file) =>
      path.join(srcRoot, 'features/canvas/application/generationRequests', file)), srcRoot);
    expect([...graph.files].map((file) => path.relative(srcRoot, file)).filter((file) =>
      file.endsWith('.tsx') || /^(api|lib|stores|hooks|components|routes)\//.test(file))).toStrictEqual([]);
    expect([...graph.packages.keys()].filter((name) => !['i18next', 'uuid', 'zustand/vanilla'].includes(name))).toStrictEqual([]);
  });
});
