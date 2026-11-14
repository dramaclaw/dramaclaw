// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { WorkflowProductOperationContext } from '../workflowExecutionActivity';

type NodeContextWireInput = {
  canvasId?: string | null;
  nodeId?: string | null;
  modelParams?: Record<string, unknown> | null;
  productOperation: WorkflowProductOperationContext | null;
};

export function nodeContextWireFields(ctx: NodeContextWireInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (ctx.canvasId) out.canvas_id = ctx.canvasId;
  if (ctx.nodeId) out.node_id = ctx.nodeId;
  if (ctx.modelParams) out.model_params = ctx.modelParams;
  if (ctx.productOperation?.generationAttemptId) {
    out.product_operation_id = ctx.productOperation.operationId;
    out.generation_attempt_id = ctx.productOperation.generationAttemptId;
  }
  return out;
}

export function textTranslateWireBody(input: NodeContextWireInput & {
  text: string;
  nodeType?: 'generic' | 'image' | 'video' | 'audio' | 'text';
}): Record<string, unknown> {
  return { text: input.text, node_type: input.nodeType ?? 'generic', ...nodeContextWireFields(input) };
}
