// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type {
  FreezoneWorkflowRun,
  WorkflowRunActionPhase,
  WorkflowRunActionStatus,
  WorkflowRunStatus,
} from "@/api/canvas";

export const WORKFLOW_EXECUTION_ACTIVITY_EVENT = "freezone/workflow-execution-activity";
export const WORKFLOW_RUN_UPDATED_EVENT = "freezone/workflow-run-updated";

export interface WorkflowExecutionActivityDetail {
  nodeId: string;
  phase: WorkflowRunActionPhase;
}

export interface WorkflowRunActionUpdate {
  node_id: string;
  action: string;
  status: WorkflowRunActionStatus;
  phase?: WorkflowRunActionPhase | null;
  error?: string | null;
  task_key?: string | null;
  task_type?: string | null;
  job_id?: string | null;
  retry_count?: number;
}

export interface WorkflowRunUpdatedDetail {
  projectId: string;
  canvasId: string;
  runId: string;
  status?: WorkflowRunStatus;
  run?: FreezoneWorkflowRun;
  actionUpdates?: WorkflowRunActionUpdate[];
}

export interface WorkflowProductOperationContext {
  projectId: string;
  operationId: string;
}

const workflowProductOperations = new Map<string, WorkflowProductOperationContext>();

export function bindWorkflowProductOperation(
  nodeId: string,
  context: WorkflowProductOperationContext,
): void {
  if (!nodeId.trim() || !context.projectId.trim() || !context.operationId.trim()) return;
  workflowProductOperations.set(nodeId, context);
}

export function workflowProductOperation(
  nodeId: string | null | undefined,
): WorkflowProductOperationContext | undefined {
  return nodeId ? workflowProductOperations.get(nodeId) : undefined;
}

export function clearWorkflowProductOperation(nodeId: string): void {
  workflowProductOperations.delete(nodeId);
}

export function reportWorkflowExecutionActivity(
  nodeId: string | null | undefined,
  phase: WorkflowRunActionPhase,
): void {
  const checkedNodeId = nodeId?.trim();
  if (!checkedNodeId || typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<WorkflowExecutionActivityDetail>(
    WORKFLOW_EXECUTION_ACTIVITY_EVENT,
    { detail: { nodeId: checkedNodeId, phase } },
  ));
}
