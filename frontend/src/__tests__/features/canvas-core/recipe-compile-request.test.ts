// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';
import {
  recipeCompilePlan, recipeCompileRequestBody, recipeCompileResult,
} from '@/features/canvas/application/generationRequests/recipeCompileRequest';
import { serveRecipeCompileRequest, serveRecipeCompileResult } from '@/features/canvas/server/recipeCompile';
import { InvalidRequest } from '@/features/canvas/server/requestPayload';

const compileInput = {
  nodeKind: 'image' as const, nodePrompt: 'A scene', upstreamText: 'A story',
  fallbackPrompt: 'Fallback', referenceMedia: [{ kind: 'image' as const, label: 'Reference' }],
};
const nodeData = { workflowCatalog: { recipeId: 'scene', userGoal: 'Make a scene' } };
const body = {
  recipe_id: 'scene', recipe_version: '', skill_id: '', skill_version: '',
  confirmed_inputs: {}, node_kind: 'image', prompt_strategy: 'llm_refine',
  node_prompt: 'A scene', user_goal: 'Make a scene', upstream_text: 'A story',
  reference_media: [{ kind: 'image', label: 'Reference' }],
};
const input = { nodeData, compileInput, executionSource: 'workflow' as const, productOperation: null };
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe('pure recipe compilation', () => {
  it('skips nodes without a recipe using the fallback', () => {
    expect(recipeCompilePlan({ ...input, nodeData: {} })).toEqual({ kind: 'skip', prompt: 'Fallback' });
  });
  it('builds the literal workflow HTTP body', () => {
    const plan = recipeCompilePlan(input);
    expect(plan.kind).toBe('compile');
    if (plan.kind !== 'compile') throw new Error('Expected compilation');
    expect(recipeCompileRequestBody(plan.payload)).toEqual(body);
  });
  it('reuses compiled prompts and edited prompts for manual execution', () => {
    const manual = { ...input, executionSource: 'manual' as const,
      nodeData: { ...nodeData, workflowRecipeCompiledPrompt: 'Compiled' } };
    expect(recipeCompilePlan({ ...manual, compileInput: { ...compileInput, nodePrompt: '' } }))
      .toEqual({ kind: 'skip', prompt: 'Compiled' });
    expect(recipeCompilePlan(manual)).toEqual({ kind: 'skip', prompt: 'A scene' });
    expect(recipeCompilePlan({ ...manual, nodeData: { ...nodeData, imageUrl: 'out.png' } }))
      .toEqual({ kind: 'skip', prompt: 'A scene' });
  });
  it('omits upstream text for background music', () => {
    const plan = recipeCompilePlan({ ...input,
      nodeData: { workflowCatalog: { recipeId: 'drama-background-music' } },
      compileInput: { ...compileInput, nodeKind: 'audio' },
    });
    if (plan.kind !== 'compile') throw new Error('Expected compilation');
    expect(recipeCompileRequestBody(plan.payload).upstream_text).toBe('');
  });
  it('preserves operation, pipeline, skill, goal and selected upstream context', () => {
    const plan = recipeCompilePlan({ ...input, productOperation: { projectId: 'p', operationId: 'op' },
      nodeData: { workflowCatalog: { recipeId: 'scene', recipeVersion: '2',
        recipePipeline: [{ id: 'finish', version: '3' }], skillId: 'story', skillVersion: '4',
        confirmedInputs: { style: 'ink' }, promptStrategy: 'previous_output',
        promptBuilder: { userGoal: 'Draw', inputStrategy: { type: 'none' } } } },
    });
    if (plan.kind !== 'compile') throw new Error('Expected compilation');
    expect(recipeCompileRequestBody(plan.payload)).toEqual({ ...body,
      project_id: 'p', product_operation_id: 'op', recipe_version: '2',
      recipe_pipeline: [{ id: 'finish', version: '3' }], skill_id: 'story', skill_version: '4',
      confirmed_inputs: { style: 'ink' }, prompt_strategy: 'previous_output',
      user_goal: 'Draw', upstream_text: '',
    });
  });
  it('normalizes response metadata and derives defaults from the request body', () => {
    const requestBody = { ...body, recipe_pipeline: [{ id: 'finish' }, { id: '' }] };
    expect(recipeCompileResult(requestBody, { prompt: 'P' })).toEqual({
      prompt: 'P', metadata: { mode: 'model', prompt: 'P', recipeIds: ['scene', 'finish'] },
    });
    expect(recipeCompileResult(requestBody, { prompt: 'P', compile_mode: 'deterministic', recipe_ids: ['a', '', 3] }))
      .toEqual({ prompt: 'P', metadata: { mode: 'deterministic', prompt: 'P', recipeIds: ['a'] } });
  });
});

describe('recipe worker operations over JSON', () => {
  const payload = { node_id: 'image', node_data: nodeData, compile_input: compileInput,
    env: { executionSource: 'workflow', locale: 'en' } };
  it('builds a request, a skip and the result with fallback metadata', async () => {
    expect(await serveRecipeCompileRequest(wire(payload))).toEqual({ kind: 'request',
      request: { method: 'POST', path: 'freezone/recipes/compile', body } });
    expect(await serveRecipeCompileRequest(wire({ ...payload, node_data: {} })))
      .toEqual({ kind: 'skip', prompt: 'Fallback' });
    expect(await serveRecipeCompileResult(wire({ request_body: { ...body, recipe_pipeline: [{ id: 'finish' }] }, data: { prompt: 'P' } })))
      .toEqual({ prompt: 'P', metadata: { mode: 'model', prompt: 'P', recipeIds: ['scene', 'finish'] } });
    expect(await serveRecipeCompileResult(wire({ request_body: body,
      data: { prompt: 'P', compile_mode: 'deterministic', recipe_ids: ['a', '', 3] } })))
      .toEqual({ prompt: 'P', metadata: { mode: 'deterministic', prompt: 'P', recipeIds: ['a'] } });
  });
  it.each([null, {}, { ...payload, node_id: 3 }, { ...payload, node_data: [] },
    { ...payload, compile_input: { ...compileInput, nodeKind: 'invalid' } },
    { ...payload, compile_input: { ...compileInput, upstreamContents: [{}] } },
    { ...payload, compile_input: { ...compileInput, referenceMedia: [{ kind: 'text' }] } },
    { ...payload, env: { executionSource: 'invalid' } },
    { ...payload, env: { executionSource: 'workflow', locale: 3 } },
    { ...payload, env: { executionSource: 'workflow', productOperation: { projectId: 3 } } },
  ])('rejects malformed request %#', async (value) => {
    await expect(serveRecipeCompileRequest(wire(value))).rejects.toBeInstanceOf(InvalidRequest);
  });
  it.each([null, {}, { request_body: {}, data: { prompt: 'P' } },
    { request_body: body, data: {} }, { request_body: body, data: { prompt: 3 } },
    { request_body: body, data: { prompt: 'P', compile_mode: 'invalid' } },
    { request_body: { ...body, recipe_pipeline: [{ id: 3 }] }, data: { prompt: 'P' } },
  ])('rejects malformed result %#', async (value) => {
    await expect(serveRecipeCompileResult(wire(value))).rejects.toBeInstanceOf(InvalidRequest);
  });
});
