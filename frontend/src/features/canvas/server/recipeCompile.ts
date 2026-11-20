// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  recipeCompilePlan, recipeCompileRequestBody, recipeCompileResult,
} from '../application/generationRequests/recipeCompileRequest';
import type { ImagePromptCompileInput } from '../application/generationRequests/imageGenerationRequest';
import type { UpstreamContent } from '../application/ports';
import { CANVAS_NODE_TYPES } from '../domain/canvasNodes';
import * as p from './generationPayload';

function referenceMedia(value: unknown) {
  const input = p.fields(value, ['kind', 'label']);
  return { kind: p.choice(input.kind, ['image', 'video', 'audio']),
    label: p.optional(input.label, p.string) };
}

function upstreamContent(value: unknown): UpstreamContent {
  const input = p.fields(value, ['nodeId', 'nodeType', 'displayName', 'workflowStepId',
    'text', 'imageUrl', 'videoUrl', 'audioUrl']);
  return {
    nodeId: p.string(input.nodeId), nodeType: p.choice(input.nodeType, Object.values(CANVAS_NODE_TYPES)),
    displayName: p.optional(input.displayName, p.string),
    workflowStepId: p.optional(input.workflowStepId, p.string),
    text: p.optional(input.text, p.string), imageUrl: p.optional(input.imageUrl, p.string),
    videoUrl: p.optional(input.videoUrl, p.string), audioUrl: p.optional(input.audioUrl, p.string),
  };
}

function compileInput(value: unknown): ImagePromptCompileInput {
  const input = p.fields(value, ['nodeKind', 'nodePrompt', 'upstreamText', 'upstreamContents',
    'fallbackPrompt', 'referenceMedia']);
  return {
    nodeKind: p.choice(input.nodeKind, ['image', 'video', 'audio', 'text']),
    nodePrompt: p.string(input.nodePrompt), fallbackPrompt: p.string(input.fallbackPrompt),
    upstreamText: p.optional(input.upstreamText, p.string),
    upstreamContents: p.optional(input.upstreamContents, value => p.array(value, upstreamContent)),
    referenceMedia: p.optional(input.referenceMedia, value => p.array(value, referenceMedia)),
  };
}

export async function serveRecipeCompileRequest(payload: unknown) {
  const input = p.fields(payload, ['node_id', 'node_data', 'compile_input', 'env']);
  const env = p.fields(input.env, ['executionSource', 'productOperation', 'locale']);
  p.optional(env.locale, p.string);
  const plan = recipeCompilePlan({
    nodeId: p.string(input.node_id), nodeData: p.record(input.node_data),
    compileInput: compileInput(input.compile_input),
    executionSource: p.choice(env.executionSource, ['workflow', 'manual']),
    productOperation: p.productOperation(env.productOperation),
  });
  if (plan.kind === 'skip') return plan;
  return { kind: 'request', request: {
    method: 'POST', path: 'freezone/recipes/compile', body: recipeCompileRequestBody(plan.payload),
  } };
}

function requestBody(value: unknown): ReturnType<typeof recipeCompileRequestBody> {
  const input = p.fields(value, ['project_id', 'product_operation_id', 'recipe_id', 'recipe_version',
    'recipe_pipeline', 'skill_id', 'skill_version', 'confirmed_inputs', 'node_kind',
    'prompt_strategy', 'node_prompt', 'user_goal', 'upstream_text', 'reference_media']);
  return {
    project_id: p.optional(input.project_id, p.string),
    product_operation_id: p.optional(input.product_operation_id, p.string),
    recipe_id: p.string(input.recipe_id), recipe_version: p.string(input.recipe_version),
    recipe_pipeline: p.optional(input.recipe_pipeline, value => p.array(value, item => {
      const entry = p.fields(item, ['id', 'version']);
      return { id: p.string(entry.id), version: p.optional(entry.version, p.string) };
    })),
    skill_id: p.string(input.skill_id), skill_version: p.string(input.skill_version),
    confirmed_inputs: p.record(input.confirmed_inputs),
    node_kind: p.choice(input.node_kind, ['image', 'video', 'audio', 'text']),
    prompt_strategy: p.choice(input.prompt_strategy, ['template', 'user_message', 'previous_output', 'llm_refine']),
    node_prompt: p.string(input.node_prompt), user_goal: p.string(input.user_goal),
    upstream_text: p.string(input.upstream_text), reference_media: p.array(input.reference_media, referenceMedia),
  };
}

export async function serveRecipeCompileResult(payload: unknown) {
  const input = p.fields(payload, ['request_body', 'data']);
  const body = requestBody(input.request_body);
  const data = p.record(input.data);
  return recipeCompileResult(body, {
    prompt: p.string(data.prompt), recipe_ids: data.recipe_ids,
    compile_mode: p.optional(data.compile_mode, value => p.choice(value,
      ['deterministic', 'memory_cache', 'persistent_cache', 'model', 'timeout_fallback'])),
  });
}
