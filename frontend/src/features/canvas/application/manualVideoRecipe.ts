// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { workflowProductOperation } from './workflowExecutionActivity';

export type VideoExecutionSource = 'manual' | 'workflow';

const pending = new Map<string, Promise<void>>();

/** First use needs the existing executor's admission, media claim and settlement. */
export function runManualVideoRecipe(input: {
  nodeId: string;
  projectId: string;
  canvasId: string;
  nodeData: unknown;
  executionSource: VideoExecutionSource;
}): Promise<void> | null {
  const data = input.nodeData as Record<string, unknown> | null;
  const catalog = data?.workflowCatalog as Record<string, unknown> | undefined;
  const hasText = (value: unknown) => typeof value === 'string' && Boolean(value.trim());
  if (
    input.executionSource !== 'manual'
    || !hasText(catalog?.recipeId)
    || hasText(data?.workflowRecipeCompiledPrompt)
    || hasText(data?.videoUrl)
    || hasText(data?.resultVideoUrl)
  ) return null;

  const key = JSON.stringify([input.projectId, input.canvasId, input.nodeId]);
  const existing = pending.get(key);
  if (existing) return existing;
  if (workflowProductOperation(input.nodeId)) return null;
  const run = (async () => {
    // Load lazily: the executor also dispatches actions back to VideoNode.
    const { applyCanvasChatCommandsAsync } = await import('@/features/freezone/canvasChatCommands');
    const result = await applyCanvasChatCommandsAsync([{
      schema_version: 'canvas_chat_commands.v1',
      project_id: input.projectId,
      canvas_id: input.canvasId,
      commands: [{ type: 'run_workflow', node_ids: [input.nodeId], direction: 'node' }],
    }], { projectId: input.projectId, canvasId: input.canvasId });
    if (result.errors.length) throw new Error(result.errors.join('\n'));
  })().finally(() => pending.delete(key));
  pending.set(key, run);
  return run;
}
