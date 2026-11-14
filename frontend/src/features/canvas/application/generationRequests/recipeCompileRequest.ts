// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type {
  FreezoneRecipeCompilePayload, FreezoneRecipeCompileMetadata, FreezoneRecipeCompileMode,
} from '@/api/ops';
import type { ImagePromptCompileInput } from './imageGenerationRequest';
import {
  asRecord, readCatalog, text, recipePipeline, skillRuntimeContext, promptStrategy,
  selectWorkflowUpstreamText,
} from '../workflowRecipeCatalog';

type RecipeCompilePayload = Omit<FreezoneRecipeCompilePayload, 'onCompileMetadata'>;
type RecipeCompilePlan =
  | { kind: 'skip'; prompt: string }
  | { kind: 'compile'; payload: RecipeCompilePayload };

export function recipeCompilePlan(input: {
  nodeId?: string;
  nodeData: unknown;
  compileInput: ImagePromptCompileInput;
  executionSource?: 'manual' | 'workflow';
  productOperation: { projectId: string; operationId: string } | null;
}): RecipeCompilePlan {
  const catalog = readCatalog(input.nodeData);
  const recipeId = text(catalog?.recipeId);
  if (!recipeId) return { kind: 'skip', prompt: input.compileInput.fallbackPrompt };
  const productOperation = input.productOperation;
  const nodeData = asRecord(input.nodeData);
  const previouslyCompiledPrompt = text(nodeData?.workflowRecipeCompiledPrompt);
  const hasPriorGeneratedOutput = [
    nodeData?.imageUrl,
    nodeData?.videoUrl,
    nodeData?.resultVideoUrl,
    nodeData?.audioUrl,
  ].some((value) => text(value).length > 0);

  // Manual retries reuse the final prompt; workflow runs compile fresh upstream context.
  if (
    input.executionSource === 'manual'
    && (previouslyCompiledPrompt || hasPriorGeneratedOutput)
  ) {
    return {
      kind: 'skip',
      prompt: text(input.compileInput.nodePrompt) || previouslyCompiledPrompt || input.compileInput.fallbackPrompt,
    };
  }
  const isMusicRecipe = input.compileInput.nodeKind === 'audio' && recipeId === 'drama-background-music';
  const upstreamText = isMusicRecipe
    ? ''
    : selectWorkflowUpstreamText(
      input.nodeData,
      input.compileInput.upstreamContents,
      input.compileInput.upstreamText ?? '',
    );
  const pipeline = recipePipeline(catalog?.recipePipeline);

  return {
    kind: 'compile',
    payload: {
      ...(productOperation
        ? {
            projectId: productOperation.projectId,
            productOperationId: productOperation.operationId,
          }
        : {}),
      recipeId,
      recipeVersion: text(catalog?.recipeVersion),
      ...(pipeline.length > 0 ? { recipePipeline: pipeline } : {}),
      ...skillRuntimeContext(catalog),
      nodeKind: input.compileInput.nodeKind,
      promptStrategy: promptStrategy(catalog?.promptStrategy),
      nodePrompt: input.compileInput.nodePrompt,
      upstreamText,
      userGoal: text(catalog?.userGoal) || text(catalog?.promptBuilder?.userGoal),
      referenceMedia: input.compileInput.referenceMedia,
    },
  };
}

export function recipeCompileRequestBody(payload: RecipeCompilePayload) {
  return {
    ...(payload.projectId ? { project_id: payload.projectId } : {}),
    ...(payload.productOperationId
      ? { product_operation_id: payload.productOperationId }
      : {}),
    recipe_id: payload.recipeId,
    recipe_version: payload.recipeVersion ?? '',
    ...(payload.recipePipeline?.length
      ? { recipe_pipeline: payload.recipePipeline }
      : {}),
    skill_id: payload.skillId ?? '',
    skill_version: payload.skillVersion ?? '',
    confirmed_inputs: payload.confirmedInputs ?? {},
    node_kind: payload.nodeKind,
    prompt_strategy: payload.promptStrategy ?? 'llm_refine',
    node_prompt: payload.nodePrompt ?? '',
    user_goal: payload.userGoal ?? '',
    upstream_text: payload.upstreamText ?? '',
    reference_media: payload.referenceMedia ?? [],
  };
}

export function recipeCompileResult(
  body: Pick<ReturnType<typeof recipeCompileRequestBody>, 'recipe_id' | 'recipe_pipeline'>,
  data: { prompt: string; compile_mode?: FreezoneRecipeCompileMode; recipe_ids?: unknown },
): { prompt: string; metadata: FreezoneRecipeCompileMetadata } {
  const ids = Array.isArray(data.recipe_ids)
    ? data.recipe_ids
    : [body.recipe_id, ...(body.recipe_pipeline ?? []).map(item => item.id)];
  return {
    prompt: data.prompt,
    metadata: {
      mode: data.compile_mode ?? 'model',
      prompt: data.prompt,
      recipeIds: ids.filter((item): item is string => typeof item === 'string' && item.length > 0),
    },
  };
}
