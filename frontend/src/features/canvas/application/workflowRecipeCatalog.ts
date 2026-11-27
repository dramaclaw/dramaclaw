// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { joinUpstreamText } from './graphContentResolver';
import type { UpstreamContent } from './ports';

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

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function readCatalog(nodeData: unknown): WorkflowCatalogRuntime | null {
  const data = asRecord(nodeData);
  return asRecord(data?.workflowCatalog) as WorkflowCatalogRuntime | null;
}

export function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function confirmedInputs(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}

export function recipePipeline(value: unknown): Array<{ id: string; version?: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const id = text(record?.id ?? item);
    if (!id) return [];
    const version = text(record?.version);
    return [{ id, ...(version ? { version } : {}) }];
  });
}

export function skillRuntimeContext(catalog: WorkflowCatalogRuntime | null) {
  const skillId = text(catalog?.skillId);
  if (!skillId) return {};
  return {
    skillId,
    skillVersion: text(catalog?.skillVersion),
    confirmedInputs: confirmedInputs(catalog?.confirmedInputs),
  };
}

export function promptStrategy(value: unknown): RecipePromptStrategy {
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

