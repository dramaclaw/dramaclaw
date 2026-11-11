// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CanvasNode, CanvasEdge, TextAnnotationNodeData } from '../../domain/canvasNodes';
import { upstreamNodesInEdgeOrder } from '../../nodes/referenceOrdering';
import { extractUpstreamContent, joinUpstreamText } from '../graphContentResolver';
import {
  readCatalog, text, recipePipeline, skillRuntimeContext, selectWorkflowUpstreamText,
} from '../workflowRecipeCatalog';
import type { WorkflowProductOperationContext } from '../workflowExecutionActivity';

export interface TextGenerationRequestContext {
  /** Graph snapshot for the rendered useUpstreamContents projection (direct content edges only). */
  nodes: CanvasNode[];
  /** Connection order is text order; execution dependency edges are ignored. */
  edges: CanvasEdge[];
  nodeId: string;
  /**
   * Rendered props.data captured by runRecipeText, NOT the latest store node data.
   * Supply it separately because same-turn store edits may not have rendered yet.
   * Only string content is the prompt; instruction is never used by this path.
   */
  nodeData: TextAnnotationNodeData;
  /**
   * Module binding from workflowProductOperation(nodeId), captured by the caller.
   * Supplies project/operation even without an attempt; generationAttemptId is ignored.
   * URL project/canvas, model access, pricing and action parameters are not read here.
   */
  productOperation: WorkflowProductOperationContext | null;
}

export interface TextGenerationHttpRequest {
  method: 'POST';
  /** Relative to the API base. */
  path: 'freezone/recipes/generate-text';
  body: Record<string, unknown>;
}
export type TextGenerationRequestResult =
  | { ok: true; requests: [TextGenerationHttpRequest] }
  | { ok: false; code: 'missing_recipe'; message: string };

/**
 * Agent generate_text only: a paid synchronous model call returning { content }.
 * Browser transport uses RECIPE_MODEL_TIMEOUT_MS = 10 * 60 * 1000
 * (600000 ms), rather than the shared client's 30s timeout. Timeout is transport
 * configuration, not a JSON body field. No separate compilation or task handle.
 *
 * Missing recipe is a thrown Error in generateWorkflowText: apply the start patch,
 * then textGenerationOutcomePatch({ outcome: { kind: 'failed', message, isError: true } })
 * and publish failure without an API call. It is not a silent validation refusal.
 */
export function buildTextGenerationRequest(ctx: TextGenerationRequestContext): TextGenerationRequestResult {
  const contents = upstreamNodesInEdgeOrder(ctx.nodes, ctx.edges, ctx.nodeId).map(extractUpstreamContent);
  return buildRecipeTextRequest({
    nodeData: ctx.nodeData,
    nodePrompt: typeof ctx.nodeData.content === 'string' ? ctx.nodeData.content : '',
    upstreamText: selectWorkflowUpstreamText(ctx.nodeData, contents, joinUpstreamText(contents)),
    productOperation: ctx.productOperation,
  });
}

export function buildRecipeTextRequest(ctx: {
  nodeData: unknown;
  nodePrompt: string;
  upstreamText: string;
  requiredOutputContext?: string;
  productOperation: WorkflowProductOperationContext | null;
}): TextGenerationRequestResult {
  const catalog = readCatalog(ctx.nodeData);
  const recipeId = text(catalog?.recipeId);
  if (!recipeId) {
    return { ok: false, code: 'missing_recipe', message: '文本节点缺少 Recipe' }; // i18n-exempt -- exact generateWorkflowText error
  }
  const pipeline = recipePipeline(catalog?.recipePipeline);
  const skill = skillRuntimeContext(catalog);
  return { ok: true, requests: [{ method: 'POST', path: 'freezone/recipes/generate-text', body: {
    ...(ctx.productOperation?.projectId ? { project_id: ctx.productOperation.projectId } : {}),
    ...(ctx.productOperation?.operationId ? { product_operation_id: ctx.productOperation.operationId } : {}),
    recipe_id: recipeId,
    recipe_version: text(catalog?.recipeVersion),
    ...(pipeline.length > 0 ? { recipe_pipeline: pipeline } : {}),
    skill_id: skill.skillId ?? '',
    skill_version: skill.skillVersion ?? '',
    confirmed_inputs: skill.confirmedInputs ?? {},
    node_kind: 'text',
    node_prompt: ctx.nodePrompt,
    user_goal: text(catalog?.userGoal) || text(catalog?.promptBuilder?.userGoal),
    upstream_text: [ctx.requiredOutputContext, ctx.upstreamText].filter(Boolean).join('\n\n'),
    reference_media: [],
  } }] };
}
