// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  compileFreezoneRecipePrompt,
  generateFreezoneRecipeText,
  type FreezoneRecipeCompileMetadata,
  type FreezoneRecipeNodeKind,
} from '@/api/ops';
import { joinUpstreamText } from './graphContentResolver';
import type { UpstreamContent } from './ports';
import { reportWorkflowExecutionActivity } from './workflowExecutionActivity';

interface WorkflowCatalogRuntime {
  skillId?: unknown;
  skillVersion?: unknown;
  confirmedInputs?: unknown;
  recipeId?: unknown;
  recipeVersion?: unknown;
  recipePipeline?: unknown;
  userGoal?: unknown;
  promptStrategy?: unknown;
  inputStrategy?: unknown;
  promptBuilder?: { userGoal?: unknown; inputStrategy?: unknown };
}

type RecipePromptStrategy = 'template' | 'user_message' | 'previous_output' | 'llm_refine';

export interface CompileWorkflowNodePromptInput {
  nodeId?: string;
  nodeData: unknown;
  nodeKind: FreezoneRecipeNodeKind;
  nodePrompt: string;
  upstreamText?: string;
  upstreamContents?: UpstreamContent[];
  fallbackPrompt: string;
  referenceMedia?: Array<{
    kind: 'image' | 'video' | 'audio';
    label?: string;
  }>;
  onCompileMetadata?: (metadata: FreezoneRecipeCompileMetadata) => void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readCatalog(nodeData: unknown): WorkflowCatalogRuntime | null {
  const data = asRecord(nodeData);
  return asRecord(data?.workflowCatalog) as WorkflowCatalogRuntime | null;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function confirmedInputs(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}

function recipePipeline(value: unknown): Array<{ id: string; version?: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const id = text(record?.id ?? item);
    if (!id) return [];
    const version = text(record?.version);
    return [{ id, ...(version ? { version } : {}) }];
  });
}

function skillRuntimeContext(catalog: WorkflowCatalogRuntime | null) {
  const skillId = text(catalog?.skillId);
  if (!skillId) return {};
  return {
    skillId,
    skillVersion: text(catalog?.skillVersion),
    confirmedInputs: confirmedInputs(catalog?.confirmedInputs),
  };
}

function promptStrategy(value: unknown): RecipePromptStrategy {
  if (value === 'template' || value === 'user_message' || value === 'previous_output') {
    return value;
  }
  return 'llm_refine';
}

function strategyStepIds(strategy: Record<string, unknown>): string[] {
  const single = text(strategy.stepId) || text(strategy.step_id);
  if (single) return [single];
  const multiple = Array.isArray(strategy.stepIds)
    ? strategy.stepIds
    : Array.isArray(strategy.step_ids)
      ? strategy.step_ids
      : [];
  return multiple.map(text).filter(Boolean);
}

export function selectWorkflowUpstreamText(
  nodeData: unknown,
  upstreamContents: UpstreamContent[] | undefined,
  fallbackText: string,
): string {
  const catalog = readCatalog(nodeData);
  const builder = asRecord(catalog?.promptBuilder);
  const strategy = asRecord(catalog?.inputStrategy) ?? asRecord(builder?.inputStrategy);
  if (!strategy) return fallbackText;
  const type = text(strategy.type);
  if (type === 'none' || type === 'user_assets' || type === 'user_message') return '';
  if (!upstreamContents) return fallbackText;
  const stepIds = strategyStepIds(strategy);
  if (stepIds.length === 0) return fallbackText;
  if (!upstreamContents.some((content) => Boolean(content.workflowStepId))) return fallbackText;
  const wanted = new Set(stepIds);
  return joinUpstreamText(
    upstreamContents.filter((content) => content.workflowStepId && wanted.has(content.workflowStepId)),
  );
}

/** Compile only catalog-backed nodes; legacy/manual nodes keep their exact prompt behavior. */
export async function compileWorkflowNodePrompt(
  input: CompileWorkflowNodePromptInput,
): Promise<string> {
  const catalog = readCatalog(input.nodeData);
  const recipeId = text(catalog?.recipeId);
  if (!recipeId) return input.fallbackPrompt;
  const upstreamText = selectWorkflowUpstreamText(
    input.nodeData,
    input.upstreamContents,
    input.upstreamText ?? '',
  );
  const pipeline = recipePipeline(catalog?.recipePipeline);

  reportWorkflowExecutionActivity(input.nodeId, 'compiling_recipe');
  try {
    return await compileFreezoneRecipePrompt({
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
}): Promise<string> {
  const catalog = readCatalog(input.nodeData);
  const recipeId = text(catalog?.recipeId);
  if (!recipeId) throw new Error('文本节点缺少 Recipe');
  const upstreamText = selectWorkflowUpstreamText(
    input.nodeData,
    input.upstreamContents,
    input.upstreamText ?? '',
  );
  const pipeline = recipePipeline(catalog?.recipePipeline);
  reportWorkflowExecutionActivity(input.nodeId, 'generating');
  return await generateFreezoneRecipeText({
    recipeId,
    recipeVersion: text(catalog?.recipeVersion),
    ...(pipeline.length > 0 ? { recipePipeline: pipeline } : {}),
    ...skillRuntimeContext(catalog),
    nodePrompt: input.nodePrompt,
    upstreamText,
    userGoal: text(catalog?.userGoal) || text(catalog?.promptBuilder?.userGoal),
  });
}
