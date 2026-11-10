// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  compileFreezoneRecipePrompt,
  generateFreezoneRecipeText,
  type FreezoneRecipeCompileMetadata,
  type FreezoneRecipeNodeKind,
} from '@/api/ops';
import {
  asRecord, readCatalog, text, recipePipeline, skillRuntimeContext, promptStrategy,
  selectWorkflowUpstreamText,
} from './workflowRecipeCatalog';
export { selectWorkflowUpstreamText } from './workflowRecipeCatalog';
import type { UpstreamContent } from './ports';
import {
  reportWorkflowExecutionActivity,
  workflowProductOperation,
} from './workflowExecutionActivity';

export interface CompileWorkflowNodePromptInput {
  nodeId?: string;
  nodeData: unknown;
  nodeKind: FreezoneRecipeNodeKind;
  nodePrompt: string;
  upstreamText?: string;
  upstreamContents?: UpstreamContent[];
  fallbackPrompt: string;
  /** Omitted callers retain the pre-existing workflow behavior and always recompile. */
  executionSource?: 'manual' | 'workflow';
  referenceMedia?: Array<{
    kind: 'image' | 'video' | 'audio';
    label?: string;
  }>;
  onCompileMetadata?: (metadata: FreezoneRecipeCompileMetadata) => void;
}

/** Compile only catalog-backed nodes; legacy/manual nodes keep their exact prompt behavior. */
export async function compileWorkflowNodePrompt(
  input: CompileWorkflowNodePromptInput,
): Promise<string> {
  const catalog = readCatalog(input.nodeData);
  const recipeId = text(catalog?.recipeId);
  if (!recipeId) return input.fallbackPrompt;
  const productOperation = workflowProductOperation(input.nodeId);
  const nodeData = asRecord(input.nodeData);
  const previouslyCompiledPrompt = text(nodeData?.workflowRecipeCompiledPrompt);
  const hasPriorGeneratedOutput = [
    nodeData?.imageUrl,
    nodeData?.videoUrl,
    nodeData?.resultVideoUrl,
    nodeData?.audioUrl,
  ].some((value) => text(value).length > 0);

  // 虾导工作流首次运行时会绑定已准入的 product operation，并在节点上保存编译
  // 后的最终 prompt。用户随后在画布上手动重发时，不应再次调用计费 Recipe
  // 编译接口（它必然要求新的 product_operation_id）。工作流执行则始终重新编译，
  // 即使 CE 工作流没有 product operation，也要让新的上游内容和 Recipe 策略生效。
  // 未编辑时复用已编译结果；编辑过则把当前输入视为最终 prompt 直接生成。
  if (
    input.executionSource === 'manual'
    && (previouslyCompiledPrompt || hasPriorGeneratedOutput)
  ) {
    return text(input.nodePrompt) || previouslyCompiledPrompt || input.fallbackPrompt;
  }
  const isMusicRecipe = input.nodeKind === 'audio' && recipeId === 'drama-background-music';
  const upstreamText = isMusicRecipe
    ? ''
    : selectWorkflowUpstreamText(
      input.nodeData,
      input.upstreamContents,
      input.upstreamText ?? '',
    );
  const pipeline = recipePipeline(catalog?.recipePipeline);

  reportWorkflowExecutionActivity(input.nodeId, 'compiling_recipe');
  try {
    return await compileFreezoneRecipePrompt({
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
      nodeKind: input.nodeKind,
      promptStrategy: promptStrategy(catalog?.promptStrategy),
      nodePrompt: input.nodePrompt,
      upstreamText,
      userGoal: text(catalog?.userGoal) || text(catalog?.promptBuilder?.userGoal),
      referenceMedia: input.referenceMedia,
      ...(input.onCompileMetadata ? { onCompileMetadata: input.onCompileMetadata } : {}),
    });
  } finally {
    reportWorkflowExecutionActivity(input.nodeId, 'submitting');
  }
}

export async function generateWorkflowText(input: {
  nodeId?: string;
  nodeData: unknown;
  nodePrompt: string;
  upstreamText?: string;
  upstreamContents?: UpstreamContent[];
  requiredOutputContext?: string;
  /** HTML uses every directly connected content input, independent of Recipe step selection. */
  upstreamInputMode?: 'connected';
}): Promise<string> {
  const catalog = readCatalog(input.nodeData);
  const recipeId = text(catalog?.recipeId);
  if (!recipeId) throw new Error('文本节点缺少 Recipe');
  const upstreamText = input.upstreamInputMode === 'connected' ? input.upstreamText ?? '' : selectWorkflowUpstreamText(
    input.nodeData,
    input.upstreamContents,
    input.upstreamText ?? '',
  );
  const pipeline = recipePipeline(catalog?.recipePipeline);
  const productOperation = workflowProductOperation(input.nodeId);
  reportWorkflowExecutionActivity(input.nodeId, 'generating');
  return await generateFreezoneRecipeText({
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
    nodePrompt: input.nodePrompt,
    upstreamText: [input.requiredOutputContext, upstreamText].filter(Boolean).join("\n\n"),
    userGoal: text(catalog?.userGoal) || text(catalog?.promptBuilder?.userGoal),
  });
}
