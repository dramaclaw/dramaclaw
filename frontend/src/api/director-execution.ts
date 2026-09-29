// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/** A command identifies one user intent; transport retries must reuse this object. */
import { apiCall } from './client';
import type { DirectorDocumentKind, DirectorModelContract } from './director';

export interface ExecutionCapability {
  schemaVersion: 2;
  version: string;
  model: DirectorModelContract;
  methodVersion: string;
  maxAttempts: 1;
  outputTokens: { minimum: number; maximum: number; default: number };
  cost: { estimateMinor: null; currency: null; requiresUnknownCostConsent: true };
  supportsRemoteCancellation: false;
  supportsAutomaticRedispatch: false;
}

export interface ExecutionLimits {
  maxAttempts: number;
  maxOutputTokens: number;
  inputChars: number;
  timeoutSeconds: number;
}

export type ExecutionParameterValue = string | number | boolean | null
  | ExecutionParameterValue[] | { [key: string]: ExecutionParameterValue };

export interface ExecutionQuote {
  quoteId: string;
  requestHash: string;
  inputHash: string;
  docKey: string;
  parameters: Record<string, ExecutionParameterValue>;
  limits: ExecutionLimits;
  estimateMinor: number | null;
  currency: string | null;
  expiresAt: number;
}

export interface ExecutionRun {
  purpose?: 'draft' | 'review' | 'planning';
  id: string;
  workId: string;
  sessionId: string;
  revision: number;
  status: 'queued' | 'dispatching' | 'cancel_requested' | 'unknown' | 'cancelled' | 'failed' | 'succeeded' | 'stale';
  requestHash: string;
  docKey: string;
  parameters: Record<string, ExecutionParameterValue>;
  limits: ExecutionLimits;
  errorCode: string | null;
  changeId: string | null;
  response: { output_sha256?: string; output_chars?: number; change_id?: string;
    validation?: { kind: 'schema' | 'json' | 'contract'; issueCount: number; issues: { path: string; code: string }[] };
    episodeFormat?: { contract: string; missing: string[]; sceneCount: number; qualityVerified: false };
    review?: { id: string; status: 'PASS' | 'FAIL' | 'UNAVAILABLE' | 'UNKNOWN' | 'REVIEWED' };
    usage?: { inputTokens: number; outputTokens: number; requests: number; finishReason: string | null; reportedModel?: string } };
  cost: { status: string; estimateMinor: number | null; reservedMinor: number | null;
    actualMinor: number | null; currency: string | null; maxOutputTokens: number; actualOutputTokens: number | null };
  createdAt: number;
  updatedAt: number;
  canResume: boolean;
  canCancel: boolean;
  requiresReconciliation: boolean;
}

export type ExecutionPayload =
  | { type: 'cost.quote'; kind: DirectorDocumentKind; episodeOrdinal?: number; instruction: string; maxOutputTokens?: number; purpose?: 'draft' | 'review'; reviewTarget?: { changeId: string; changeRevision: number; acceptGroupIds: string[] } }
  | { type: 'approval.grant'; quoteId: string; requestHash: string; unknownCostConsent: boolean }
  | { type: 'run.cancel' | 'run.resume'; runId: string };

export interface ExecutionCommand {
  schemaVersion: 2;
  commandId: string;
  clientRequestId: string;
  sessionId: string;
  workId: string;
  expected: { workRevision: number; documentVersions: Record<string, number>; capabilityVersion: string };
  payload: ExecutionPayload;
}

export const isExecutionActive = (run: ExecutionRun) =>
  ['queued', 'dispatching', 'cancel_requested', 'unknown'].includes(run.status);

export function executionCommand(
  workId: string, workRevision: number, docKey: string, documentVersion: number,
  capabilityVersion: string, payload: ExecutionPayload,
): ExecutionCommand {
  const intent = crypto.randomUUID();
  return {
    schemaVersion: 2, commandId: intent, clientRequestId: intent,
    sessionId: `work-${workId}`, workId,
    expected: { workRevision, documentVersions: { [docKey]: documentVersion }, capabilityVersion }, payload,
  };
}

const base = (project: string) => `projects/${encodeURIComponent(project)}/director/v2`;

export const getExecutionCapability = (project: string) => apiCall<ExecutionCapability>(`${base(project)}/capabilities`);
export const listExecutionRuns = (project: string, workId: string) =>
  apiCall<ExecutionRun[]>(`${base(project)}/works/${encodeURIComponent(workId)}/runs`);

export interface ExecutionEvent {
  seq: number; eventId: string; type: string; sessionId: string; runId: string | null;
  payload: { text?: string; key?: string; version?: string; revision?: string; model?: string; stream?: boolean; references?: string[];
    blockKey?: string; sectionKey?: string; provisional?: boolean };
  createdAt: number;
}
export interface ExecutionEvents { schemaVersion: 2; events: ExecutionEvent[]; nextSeq: number }
export const getExecutionEvents = (project: string, workId: string, afterSeq: number, signal?: AbortSignal) =>
  apiCall<ExecutionEvents>(`${base(project)}/works/${encodeURIComponent(workId)}/events?after_seq=${afterSeq}`, { signal });

export interface RetainedResult {
  runId: string;
  status: ExecutionRun['status'];
  output: string | null;
  outputHash: string | null;
  readOnly: true;
  factAudit?: { passed: boolean; issues: Array<{ code: string; entityId?: string; field?: string; value?: string }> } | null;
}
export const getRetainedResult = (project: string, workId: string, runId: string) =>
  apiCall<RetainedResult>(`${base(project)}/works/${encodeURIComponent(workId)}/runs/${encodeURIComponent(runId)}/result`);

export async function sendExecutionCommand<T extends ExecutionQuote | ExecutionRun>(
  project: string, command: ExecutionCommand,
): Promise<T> {
  const route = 'runId' in command.payload
    ? `runs/${encodeURIComponent(command.payload.runId)}/commands` : 'approvals/commands';
  const result = await apiCall<{ schemaVersion: 2; commandId: string; eventSeq: number; result: T }>(
    `${base(project)}/${route}`, { method: 'POST', json: command },
  );
  return result.result;
}

export interface PlanningDirection {
  id: string; logline: string; goal: string; obstacle: string; stakes: string;
  tone: string; difference: string; productionRisks: string[];
}
export interface PlanningState {
  workId: string; workRevision?: number; revision: number;
  phase: 'NOT_STARTED' | 'WAIT_COST' | 'EXEC' | 'WAIT_DIRECTION' | 'WAIT_OUTLINE' | 'WAIT_INPUT' | 'CANCELLED' | 'FAILED_RECOVERABLE' | 'UNKNOWN' | 'READY';
  errorCode: string | null;
  checkpoint: null | { id: string; kind: string; status: string; resumeToken: string; payloadHash: string;
    payload: { options?: PlanningDirection[]; specQuestions?: { id: string; question: string; choices?: string[] }[];
      confirmedPreset?: { episodeCount: number; durationSeconds: number }; documents?: Record<string, string>;
      quality?: { status: 'reviewed' | 'blocked'; violatedPaths: string[]; uncertainPaths: string[]; literaryNotes: string[] } } };
  artifacts: Record<string, unknown>;
  budgets: { id: string; callsReserved: number; outputTokensReserved: number; status: string; plan: PlanningPlan; expiresAt: number }[];
}
export interface PlanningPlan {
  group: 'direction' | 'outline' | 'preparation' | 'adaptation_direction' | 'adaptation_outline'; stages: string[]; model: string;
  limits: { maxCalls: number; maxOutputTokensPerCall: number; maxTotalOutputTokens: number; maxAttemptsPerStage: number; automaticRevisions: number };
}
export interface PlanningQuote {
  quoteId: string; planHash: string; plan: PlanningPlan; workflowRevision: number; expiresAt: number;
  estimateMinor: null; currency: null;
}
export type PlanningPayload =
  | { type: 'planning.quote'; maxOutputTokens?: number; targetScope?: 'outline' | 'preparation' }
  | { type: 'planning.grant'; quoteId: string; planHash: string; unknownCostConsent: boolean }
  | { type: 'planning.decide'; checkpointId: string; resumeToken: string; payloadHash: string;
    decision: 'select' | 'adopt' | 'skip' | 'return' | 'revise'; optionId?: string | null; freeText?: string; answers?: Record<string, string>;
    episodeCount?: number; durationSeconds?: number }
  | { type: 'planning.cancel' | 'planning.resume' | 'planning.revalidate' };
export interface PlanningCommand {
  schemaVersion: 2; commandId: string; clientRequestId: string; sessionId: string; workId: string;
  expected: { workRevision: number; workflowRevision: number; capabilityVersion: string };
  payload: PlanningPayload;
}
export const getPlanningState = (project: string, workId: string) =>
  apiCall<PlanningState>(`${base(project)}/works/${encodeURIComponent(workId)}/planning`);
export async function sendPlanningCommand(project: string, command: PlanningCommand): Promise<PlanningQuote | PlanningState> {
  const result = await apiCall<{ result: PlanningQuote | PlanningState }>(`${base(project)}/planning/commands`, { method: 'POST', json: command });
  return result.result;
}
