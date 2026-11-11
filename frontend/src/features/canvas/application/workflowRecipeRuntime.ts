// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  compileFreezoneRecipePrompt,
  generateFreezoneRecipeText,
  type FreezoneRecipeCompileMetadata,
  type FreezoneRecipeNodeKind,
} from '@/api/ops';
import {
  readCatalog, text, recipePipeline, skillRuntimeContext,
  selectWorkflowUpstreamText,
} from './workflowRecipeCatalog';
export { selectWorkflowUpstreamText } from './workflowRecipeCatalog';
import type { UpstreamContent } from './ports';
import { recipeCompilePlan } from './generationRequests/recipeCompileRequest';
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
  const plan = recipeCompilePlan({
    nodeId: input.nodeId,
    nodeData: input.nodeData,
    compileInput: input,
    executionSource: input.executionSource,
    productOperation: workflowProductOperation(input.nodeId) ?? null,
  });
  if (plan.kind === 'skip') return plan.prompt;
  reportWorkflowExecutionActivity(input.nodeId, 'compiling_recipe');
  try {
    return await compileFreezoneRecipePrompt({
      ...plan.payload,
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
