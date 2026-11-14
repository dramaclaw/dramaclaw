// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildRecipeTextRequest, buildTextGenerationRequest, textGenerationStartPatch,
  textGenerationOutcomePatch, type TextGenerationRequestContext,
} from '@/features/canvas/application/generationRequests';
import type { GenerationSubmitFailure } from '@/features/canvas/application/generationRequests/generationSubmitError';
import { CANVAS_NODE_TYPES, type CanvasNode, type TextAnnotationNodeData } from '@/features/canvas/domain/canvasNodes';
import { collectImportGraph } from '../canvas-core/importGraph';

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

describe('recipe text requests', () => {
  it.each(fixtures)('$name', (ctx) => {
    const decision = buildTextGenerationRequest(ctx);
    if (/^(missing|blank) recipe$/.test(ctx.name)) {
      expect(decision).toStrictEqual({ ok: false, code: 'missing_recipe', message: '文本节点缺少 Recipe' });
    } else {
      const expected = { ok: true, requests: [{
        method: 'POST', path: 'freezone/recipes/generate-text', body: {
          ...(ctx.expected?.project_id ? { project_id: ctx.expected.project_id } : {}),
          ...(ctx.expected?.product_operation_id ? { product_operation_id: ctx.expected.product_operation_id } : {}),
          recipe_id: 'story', recipe_version: '',
          ...(ctx.expected?.recipe_pipeline ? { recipe_pipeline: ctx.expected.recipe_pipeline } : {}),
          skill_id: '', skill_version: '', confirmed_inputs: {},
          node_kind: 'text', node_prompt: '  Node prompt\n', user_goal: '', upstream_text: '', reference_media: [],
          ...ctx.expected,
        },
      }] };
      expect(decision).toStrictEqual(expected);
      expect(JSON.stringify(decision)).toBe(JSON.stringify(expected));
    }
  });
  it.each([
    { upstreamText: 'Connected text', expected: 'Required output\n\nConnected text' },
    { upstreamText: '', expected: 'Required output' },
  ])('prefixes required output context with upstream "$upstreamText"', ({ upstreamText, expected }) => {
    expect(buildRecipeTextRequest({ nodeData: { workflowCatalog: { recipeId: 'story' } },
      nodePrompt: '', upstreamText, requiredOutputContext: 'Required output', productOperation: null,
    })).toStrictEqual({ ok: true, requests: [{ method: 'POST', path: 'freezone/recipes/generate-text', body: {
      recipe_id: 'story', recipe_version: '', skill_id: '', skill_version: '', confirmed_inputs: {},
      node_kind: 'text', node_prompt: '', user_goal: '', upstream_text: expected, reference_media: [],
    } }] });
  });
  it('starts recipe text generation', () => {
    expect(textGenerationStartPatch(1800000000000)).toStrictEqual({
      isGenerating: true, generationStartedAt: 1800000000000, generationError: null,
    });
  });
  it.each([
    { name: 'recipe only and no product operation',
      outcome: { kind: 'completed', content: 'Generated body' },
      expected: { patch: { isGenerating: false, generationStartedAt: null, content: 'Generated body', workflowTextGenerated: true },
        output: { content: 'Generated body'} }  },
    { name: 'API returns blank content',
      outcome: { kind: 'completed', content: '' },
      expected: { patch: { isGenerating: false, generationStartedAt: null, content: '', workflowTextGenerated: true },
        output: { content: ''} }  },
    { name: 'API returns whitespace content as is',
      outcome: { kind: 'completed', content: ' \n ' },
      expected: { patch: { isGenerating: false, generationStartedAt: null, content: ' \n ', workflowTextGenerated: true },
        output: { content: ' \n '} }  },
    { name: 'insufficient credits raw message',
      outcome: { kind: 'failed', message: 'Raw credit failure', isError: true },
      expected: { patch: { isGenerating: false, generationStartedAt: null, generationError: 'Raw credit failure' },
        error: { message: 'Raw credit failure', isError: true} }  },
    { name: 'plain backend error message',
      outcome: { kind: 'failed', message: 'Raw backend failure', isError: true },
      expected: { patch: { isGenerating: false, generationStartedAt: null, generationError: 'Raw backend failure' },
        error: { message: 'Raw backend failure', isError: true} }  },
    { name: 'envelope failure message',
      outcome: { kind: 'failed', message: 'Raw envelope failure', isError: true },
      expected: { patch: { isGenerating: false, generationStartedAt: null, generationError: 'Raw envelope failure' },
        error: { message: 'Raw envelope failure', isError: true} }  },
    { name: 'network failure message',
      outcome: { kind: 'failed', message: 'Network unavailable', isError: true },
      expected: { patch: { isGenerating: false, generationStartedAt: null, generationError: 'Network unavailable' },
        error: { message: 'Network unavailable', isError: true} }  },
    { name: 'empty Error message stays empty',
      outcome: { kind: 'failed', message: '', isError: true },
      expected: { patch: { isGenerating: false, generationStartedAt: null, generationError: '' },
        error: { message: '', isError: true} }  },
    { name: 'non Error uses literal node fallback',
      outcome: { kind: 'failed', message: 'Opaque thrown value', isError: false },
      expected: { patch: { isGenerating: false, generationStartedAt: null, generationError: '文本生成失败' },
        error: { message: 'Opaque thrown value', isError: false} }  },
    { name: 'empty non Error publication stays empty',
      outcome: { kind: 'failed', message: '', isError: false },
      expected: { patch: { isGenerating: false, generationStartedAt: null, generationError: '文本生成失败' },
        error: { message: '', isError: false} }  },
  ] as const)('$name outcome', ({ outcome, expected }) => {
    expect(textGenerationOutcomePatch({ outcome })).toStrictEqual(expected);
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
