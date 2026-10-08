// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/** Every visible Director parameter has one typed API field and one server-side hash. */
import { apiCall } from './client';

export type DirectorMediaKind = 'characters' | 'scenes' | 'props';
export type DirectorMediaSource = { workRevision: number; documentVersion: number; kind: DirectorMediaKind; style: string; assets: Array<{ id: string; name: string; text: string }> };
export type DirectorMediaIntent = { id: string; workId: string; status: 'prepared' | 'submitting' | 'accepted' | 'unknown' | 'cancelled'; createdAt: number;
  request: { batchId?: string; source: { kind: DirectorMediaKind; documentVersion: number; asset: { id: string; name: string; text: string } }; modelLabel: string; actual: Record<string, unknown> };
  result: { task_key?: string; task_type?: string; job_id?: string } };
export type DirectorMediaPrepare = { intent_id: string; work_revision: number; document_version: number; kind: DirectorMediaKind; asset_id: string; prompt: string; model_id: string; aspect_ratio: string; image_size: string; quality: string; model_params: Record<string, unknown> };
const mediaPath = (project: string, work: string) => `projects/${encodeURIComponent(project)}/director/works/${encodeURIComponent(work)}/media`;
export const getDirectorMediaSource = (project: string, work: string, kind: DirectorMediaKind) => apiCall<DirectorMediaSource>(`${mediaPath(project, work)}/source/${kind}`);
export const listDirectorMedia = (project: string, work: string) => apiCall<DirectorMediaIntent[]>(mediaPath(project, work));
export const prepareDirectorMedia = (project: string, work: string, body: DirectorMediaPrepare) => apiCall<DirectorMediaIntent>(`${mediaPath(project, work)}/prepare`, { method: 'POST', json: body });
export const confirmDirectorMedia = (project: string, work: string, id: string) => apiCall<DirectorMediaIntent>(`${mediaPath(project, work)}/${encodeURIComponent(id)}/confirm`, { method: 'POST', json: { approved: true, acknowledge_unknown_cost: true } });
export type DirectorMediaNode = { id: string; batch_id: string; ordinal: number; x: number; y: number; version: number; intent: DirectorMediaIntent };
export type DirectorMediaBatch = { id: string; status: 'planned' | 'approved' | 'cancelled'; selectedIds: string[]; nodes: DirectorMediaNode[] };
export type DirectorBatchPrepare = Omit<DirectorMediaPrepare, 'intent_id' | 'asset_id' | 'prompt'> & { id: string; prompts: Record<string, string> };
export const listDirectorBatches = (project: string, work: string) => apiCall<DirectorMediaBatch[]>(`${mediaPath(project, work)}/batches`);
export const prepareDirectorBatch = (project: string, work: string, body: DirectorBatchPrepare) => apiCall<DirectorMediaBatch>(`${mediaPath(project, work)}/batches`, { method: 'POST', json: body });
export const approveDirectorBatch = (project: string, work: string, id: string, selectedIds: string[]) => apiCall<DirectorMediaBatch>(`${mediaPath(project, work)}/batches/${id}/approve`, { method: 'POST', json: { selected_ids: selectedIds, acknowledge_unknown_cost: true } });
export const cancelDirectorBatch = (project: string, work: string, id: string) => apiCall<DirectorMediaBatch>(`${mediaPath(project, work)}/batches/${id}/cancel`, { method: 'POST' });
export const moveDirectorMediaNode = (project: string, work: string, node: DirectorMediaNode, x: number, y: number) => apiCall<Omit<DirectorMediaNode, 'intent'>>(`${mediaPath(project, work)}/nodes/${node.id}`, { method: 'PATCH', json: { version: node.version, x, y } });

export type DirectorMode = 'original' | 'adaptation';
export type AdaptDirection = 'condense' | 'expand' | 'conflict' | 'hook';
export type DirectorDocumentKind = 'outline' | 'characters' | 'scenes' | 'props' | 'episode';

export interface DirectorPreset {
  mode: DirectorMode;
  primary_genre: string;
  fusion_genre: string;
  audience: string;
  characters: string;
  era: string;
  highlights: string;
  visual_style: string;
  narrative_tone?: string;
  ending_type?: 'closed' | 'open' | 'reversal' | 'tragic';
  output_language?: string;
  market?: string;
  fidelity?: 'strict' | 'approved_changes';
  locked_facts?: string;
  allowed_additions?: string;
  model_name: string;
  structure: string;
  episode_count: number;
  duration_seconds: number;
  adapt_direction: AdaptDirection | null;
  source_episode_label: string;
  delivery_episode_label: string;
}

export interface DirectorWork {
  id: string;
  title: string;
  mode: DirectorMode;
  preset: DirectorPreset;
  brief: string;
  source_sha256: string;
  source_episode_label: string;
  delivery_episode_label: string;
  current_episode: number;
  status: string;
  revision: number;
  created_at: number;
  updated_at: number;
  source_text?: string;
}

export interface DirectorDocument {
  doc_key: string;
  version: number;
  content: string;
  origin: string;
  created_at: number;
  document_id?: string;
  content_hash?: string;
  semantic_input_hash?: string;
  schema_version?: number;
}

export interface CanonicalDocumentProjection {
  schemaVersion: 1 | 2;
  workRevision: number;
  documents: Array<{
    documentId: string; docKey: string; kind: string; version: number; content: string;
    status: 'empty' | 'draft' | 'accepted' | 'legacy_unverified';
    contentHash?: string; semanticInputHash?: string; unsupportedBlockIds: string[];
  }>;
  episodes: Array<{ id: string; documentId: string; orderKey: number; sourceEpisodeLabel: string | null; deliveryLabel: string; archived: boolean }>;
  artifacts: Array<{ id: string; kind: string; version: number; status: string; bodyHash: string }>;
}

export interface LegacyImportPreview {
  schemaVersion: 2; workId: string; workRevision: number; sourceHash: string; previewHash: string;
  documentMap: Array<{ docKey: string; documentId: string; version: number }>;
  versionCount: number; historicalConfirmationCount: number; warnings: string[]; modelCalls: 0;
}

export async function getCanonicalDocuments(project: string, workId: string): Promise<CanonicalDocumentProjection> {
  return apiCall(`projects/${encodeURIComponent(project)}/director/v2/works/${encodeURIComponent(workId)}/documents`);
}

export async function previewLegacyImport(project: string, workId: string): Promise<LegacyImportPreview> {
  return apiCall(`projects/${encodeURIComponent(project)}/director/v2/works/${encodeURIComponent(workId)}/import-preview`);
}

export function legacyImportCommand(preview: LegacyImportPreview) {
  const intent = crypto.randomUUID();
  return { schemaVersion: 2 as const, commandId: intent, clientRequestId: intent, sessionId: `work-${preview.workId}`,
    workId: preview.workId, expected: { workRevision: preview.workRevision, documentVersions: {} },
    payload: { type: 'import.commitLegacy' as const, previewHash: preview.previewHash } };
}

export async function commitLegacyImport(project: string, command: ReturnType<typeof legacyImportCommand>): Promise<unknown> {
  return apiCall(`projects/${encodeURIComponent(project)}/director/v2/documents/commands`, { method: 'POST', json: command });
}

export interface DirectorChange {
  id: string;
  work_id: string;
  doc_key: string;
  base_version: number;
  content: string;
  reason: string;
  status: 'pending' | 'accepted' | 'rejected';
  created_at: number;
  decided_at: number | null;
  outlinePatch?: OutlinePatch;
}

export interface OutlineBlock {
  id: string; type: string; text: string; attrs: { level: number | null; lineBreak: boolean };
  marks?: Array<{ type: string; start: number; end: number; href?: string | null }>;
}
export interface OutlinePatch {
  contract: 'outline-patch/1.0.0'; revision: number; headVersion: number;
  baseAst: { blocks: OutlineBlock[] };
  groups: Array<{ id: string; hunkIds: string[]; sectionKeys: string[]; requiresGroupIds: string[] }>;
  hunks: Array<{ id: string; sectionKey: string; targetBlockIds: string[]; reason: string;
    renderedBlocks?: OutlineBlock[];
    afterBlocks: Array<{ type: string; text: string; level: number | null; lineBreak: boolean }> }>;
  decisions: Record<string, 'pending' | 'accepted' | 'rejected'>; acceptedGroupIds: string[];
  changeSummary: Array<{ text: string; hunkIds: string[] }>; unresolvedRequests: string[];
  reviews: Array<{ id: string; changeRevision: number; acceptGroupIds: string[]; status: 'reviewed' | 'blocked';
    currentValidator?: boolean;
    units?: Array<{ path: string; findings: Array<{ candidateQuote: string; assertion: string; reason: string;
      verdict: 'supported' | 'violated' | 'uncertain' | 'interpretation';
      sourceEvidence: Array<{ unitId: string; quote: string }> }> }>;
    violatedPaths: string[]; uncertainPaths: string[]; literaryNotes: string[] }>;
}

export function outlineDecisionCommand(work: DirectorWork, document: DirectorDocument, change: DirectorChange,
  groupIds: string[], decision: 'accept' | 'reject', reportId: string | null = null) {
  const intent = crypto.randomUUID();
  return { schemaVersion: 2 as const, commandId: intent, clientRequestId: intent, sessionId: `work-${work.id}`,
    workId: work.id, expected: { workRevision: work.revision, documentVersions: { [document.document_id!]: document.version } },
    payload: { type: 'outline.decideGroups' as const, documentId: document.document_id!, changeId: change.id,
      changeRevision: change.outlinePatch!.revision, groupIds, decision, reportId } };
}

export async function decideOutlineGroups(project: string, command: ReturnType<typeof outlineDecisionCommand>): Promise<unknown> {
  return apiCall(`projects/${encodeURIComponent(project)}/director/v2/documents/commands`, { method: 'POST', json: command });
}

export interface DirectorRun {
  id: string;
  work_id: string;
  action: string;
  input_sha256: string;
  status: 'running' | 'completed' | 'failed';
  error: string;
  change_id: string | null;
  created_at: number;
  finished_at: number | null;
  request: { parameters?: Record<string, string | number | null>; prompt_chars?: number };
  response: { output_sha256?: string; output_chars?: number; change_id?: string };
}

export interface DirectorModelOption {
  id: string;
  label: string;
  providerLabel: string;
  upstreamModel: string;
}

export interface DirectorModelContract {
  model_name: string;
  locked: boolean;
  source?: 'local_catalog';
  options?: DirectorModelOption[];
}

export interface DirectorWorkDetail {
  work: DirectorWork;
  documents: Array<{ doc_key: string; version: number }>;
  changes: DirectorChange[];
  runs: DirectorRun[];
}

export interface RevisionImpact {
  schemaVersion: 2; previewId: string; previewHash: string; workId: string; workRevision: number;
  type: 'settings.preview' | 'episode.reopenPreview'; expiresAt: number; modelCalls: 0;
  changedFields: Array<{ field: string; before: string | number | null; after: string | number | null }>;
  restartEpisode: number | null;
  affectedEpisodes: Array<{ id: string; docKey: string; ordinal: number; label: string; version: number }>;
  archiveEpisodes: RevisionImpact['affectedEpisodes']; restoredEpisodes: RevisionImpact['affectedEpisodes'];
  addedOrdinals: number[]; invalidatedReportIds: string[]; invalidatedFinalizationIds: string[];
}

export interface CommitRevision {
  schemaVersion: 2; commandId: string; clientRequestId: string; workId: string;
  previewId: string; previewHash: string; archiveEpisodeIds: string[]; reason: string;
}

export function settingsRevisionRequest(work: DirectorWork, candidate: { title: string; brief: string; preset: DirectorPreset }) {
  // Compatibility projection only. UI names cannot leak into the strict v2 wire contract.
  const preset = Object.fromEntries(Object.entries(candidate.preset).map(([key, value]) =>
    [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value]));
  return { schemaVersion: 2 as const, workId: work.id, expectedWorkRevision: work.revision,
    payload: { type: 'settings.preview' as const, candidate: { ...candidate, preset } } };
}

export async function previewSettingsRevision(project: string, work: DirectorWork, candidate: { title: string; brief: string; preset: DirectorPreset }): Promise<RevisionImpact> {
  return apiCall(`projects/${encodeURIComponent(project)}/director/v2/revisions/preview`, {
    method: 'POST', json: settingsRevisionRequest(work, candidate),
  });
}

export async function previewEpisodeReopen(project: string, work: DirectorWork, ordinal: number): Promise<RevisionImpact> {
  return apiCall(`projects/${encodeURIComponent(project)}/director/v2/revisions/preview`, {
    method: 'POST', json: { schemaVersion: 2, workId: work.id, expectedWorkRevision: work.revision,
      payload: { type: 'episode.reopenPreview', episodeOrdinal: ordinal } },
  });
}

export async function commitDirectorRevision(project: string, command: CommitRevision): Promise<{ work: DirectorWork }> {
  return apiCall(`projects/${encodeURIComponent(project)}/director/v2/revisions/commands`, { method: 'POST', json: command });
}

export interface DirectorPrivateDraft {
  documentId: string; clientDraftId: string; revision: number; baseVersion: number; text: string;
}

export async function listDirectorDrafts(project: string, workId: string): Promise<DirectorPrivateDraft[]> {
  return apiCall(`projects/${encodeURIComponent(project)}/director/v2/works/${encodeURIComponent(workId)}/drafts`);
}

export function privateDraftCommand(work: DirectorWork, draft: DirectorPrivateDraft) {
  const intent = crypto.randomUUID();
  return { schemaVersion: 2 as const, commandId: intent, clientRequestId: intent, sessionId: `editor-${draft.clientDraftId}`,
    workId: work.id, expected: { workRevision: work.revision, documentVersions: { [draft.documentId]: draft.baseVersion } },
    payload: { type: 'document.saveDraft' as const, documentId: draft.documentId, clientDraftId: draft.clientDraftId,
      draftRevision: draft.revision, baseVersion: draft.baseVersion, text: draft.text } };
}

export async function saveDirectorDraft(project: string, command: ReturnType<typeof privateDraftCommand>): Promise<DirectorPrivateDraft> {
  const reply = await apiCall<{ result: DirectorPrivateDraft }>(`projects/${encodeURIComponent(project)}/director/v2/documents/commands`, { method: 'POST', json: command });
  return reply.result;
}

export function manualDocumentCommand(workId: string, workRevision: number, document: DirectorDocument, text: string) {
  if (!document.document_id) throw new Error('CANONICAL_DOCUMENT_REQUIRED');
  const intent = crypto.randomUUID();
  return { schemaVersion: 2 as const, commandId: intent, clientRequestId: intent, sessionId: `editor-${document.document_id}`,
    workId, expected: { workRevision, documentVersions: { [document.document_id]: document.version } },
    payload: { type: 'document.commitManual' as const, documentId: document.document_id, text } };
}

export async function commitManualDocument(project: string, command: ReturnType<typeof manualDocumentCommand>) {
  const reply = await apiCall<{ workRevision: number; result: { docKey: string; documentId: string; version: number; content: string; contentHash: string; semanticInputHash: string; createdAt: number } }>(
    `projects/${encodeURIComponent(project)}/director/v2/documents/commands`, { method: 'POST', json: command });
  const value = reply.result;
  return { workRevision: reply.workRevision, document: { doc_key: value.docKey, document_id: value.documentId,
    version: value.version, content: value.content, content_hash: value.contentHash, semantic_input_hash: value.semanticInputHash,
    origin: 'user', created_at: value.createdAt, schema_version: 2 } satisfies DirectorDocument };
}

export interface GenerateDirectorDraft {
  kind: DirectorDocumentKind;
  episode_ordinal?: number;
  instruction: string;
  expected_version: number;
  expected_input_sha256?: string;
  acknowledge_model_cost?: boolean;
}

export interface DirectorGenerationPreview {
  input_sha256: string;
  parameters: Record<string, string | number | null>;
  doc_key: string;
  model_cost: 'provider_configured_unknown';
}

export interface DirectorReviewCheck {
  id: string; status: 'PASS' | 'FAIL' | 'UNKNOWN'; explanation: string; suggestion: string;
  validationErrorCode?: string;
  evidence: Array<{ inputId: string; quote: string; start: number; end: number; quoteHash: string }>;
}

export type EpisodeFactAudit = { status: 'FAIL' | 'UNAVAILABLE' | 'REVIEWED'; version: string;
  coverage: { expected: number; valid: number; semanticCompletenessVerified: false };
  issues: Array<{ code: string; unitId?: string }>;
  units: Array<{ id: string; inputId: string; text: string; disposition: string; explanation: string; valid: boolean; requiresHumanCheck: boolean;
    facts: Array<{ subject: string; relation: string; value: string; before: string; after: string; layer: string; status: string; explanation: string; evidence: Array<{ inputId: string; quote: string; start: number; end: number }> }> }> };
export interface DirectorQualityReport {
  doc_key: string;
  version: number;
  blockers: string[];
  warnings: string[];
  ready_for_human_review: boolean;
  schemaVersion: 2;
  contentHash: string;
  productionReady: false;
  requiredHumanChecks: string[];
  review: null | { id: string; reportHash: string; status: 'PASS' | 'FAIL' | 'UNAVAILABLE'; reviewerRunId: string;
    checks: DirectorReviewCheck[]; episodeFacts?: EpisodeFactAudit | null };
  retainedValidation?: null | { status: 'PASS' | 'FAIL' | 'UNAVAILABLE'; sourceReportId: string; checks: DirectorReviewCheck[] };
}

export interface OutlineQualityReport {
  docKey: 'outline'; documentVersion: number; contentHash: string;
  requiresHumanReview: true; productionReady: false;
  review: null | {
    id: string; reportHash: string; reviewerRunId: string;
    status: 'FAIL' | 'UNAVAILABLE' | 'UNKNOWN' | 'REVIEWED';
    checks: Array<Omit<DirectorReviewCheck, 'status'> & { status: 'FULFILLED' | 'VIOLATED' | 'UNKNOWN' }>;
    obligations: Array<{ id: string; text: string; sourceRefs: Array<{ inputId: string; start: number; end: number }> }>;
    coverage: { expected: number; valid: number; semanticCompletenessVerified: false };
  };
}

export const getOutlineQualityReport = (project: string, workId: string) =>
  apiCall<OutlineQualityReport>(`projects/${encodeURIComponent(project)}/director/v2/works/${encodeURIComponent(workId)}/outline-quality`);

export interface FinalizeDirectorCommand {
  schemaVersion: 2; commandId: string; clientRequestId: string; workId: string; episodeOrdinal: number;
  expectedWorkRevision: number; documentVersion: number; contentHash: string; reportId: string; reportHash: string;
  humanChecks: Array<{ checkId: string; conclusion: 'verified' | 'literary_only'; evidence: string }>;
}

export async function finalizeDirectorV2(project: string, command: FinalizeDirectorCommand): Promise<{ work: DirectorWork; finalizationId: string }> {
  return apiCall(`projects/${encodeURIComponent(project)}/director/v2/episodes/commands`, { method: 'POST', json: command });
}

const workPath = (project: string, workId: string) =>
  `projects/${encodeURIComponent(project)}/director/works/${encodeURIComponent(workId)}`;

export const directorDocumentKey = (kind: DirectorDocumentKind, ordinal: number) =>
  kind === 'episode' ? `episode-${String(ordinal).padStart(3, '0')}` : kind;

export async function listDirectorWorks(project: string, archived = false): Promise<DirectorWork[]> {
  return apiCall(`projects/${encodeURIComponent(project)}/director/works${archived ? '?archived=true' : ''}`);
}

export interface DirectorHistoryCommand { command_id: string; expected_revision: number; action: 'rename' | 'archive' | 'restore'; title?: string }
export async function updateDirectorHistory(project: string, workId: string, command: DirectorHistoryCommand): Promise<DirectorWork> {
  return apiCall(`${workPath(project, workId)}/history`, { method: 'POST', json: command });
}

export async function getDirectorModelContract(project: string): Promise<DirectorModelContract> {
  return apiCall(`projects/${encodeURIComponent(project)}/director/model`);
}

export async function createDirectorWork(
  project: string,
  input: { title: string; brief: string; source_text: string; preset: DirectorPreset },
): Promise<DirectorWork> {
  return apiCall(`projects/${encodeURIComponent(project)}/director/works`, { method: 'POST', json: input });
}

export async function updateDirectorWork(
  project: string, workId: string,
  input: { title: string; brief: string; source_text: string; preset: DirectorPreset; expected_revision: number },
): Promise<DirectorWork> {
  return apiCall(workPath(project, workId), { method: 'PATCH', json: input });
}

export async function getDirectorWork(project: string, workId: string): Promise<DirectorWorkDetail> {
  return apiCall(workPath(project, workId));
}

export async function getDirectorDocument(
  project: string, workId: string, docKey: string,
): Promise<DirectorDocument> {
  return apiCall(`${workPath(project, workId)}/documents/${encodeURIComponent(docKey)}`);
}

export async function putDirectorDocument(
  project: string, workId: string, docKey: string, content: string, expectedVersion: number,
): Promise<DirectorDocument> {
  return apiCall(`${workPath(project, workId)}/documents/${encodeURIComponent(docKey)}`, {
    method: 'PUT', json: { content, expected_version: expectedVersion },
  });
}

export async function proposeDirectorChange(
  project: string, workId: string, docKey: string, content: string,
  expectedVersion: number, reason: string,
): Promise<DirectorChange> {
  return apiCall(`${workPath(project, workId)}/changes`, {
    method: 'POST', json: { doc_key: docKey, content, expected_version: expectedVersion, reason },
  });
}

export async function decideDirectorChange(
  project: string, workId: string, changeId: string, accept: boolean,
): Promise<{ change: DirectorChange; document: DirectorDocument | null }> {
  return apiCall(`${workPath(project, workId)}/changes/${encodeURIComponent(changeId)}/decision`, {
    method: 'POST', json: { accept },
  });
}

export async function finalizeDirectorEpisode(
  project: string, workId: string, ordinal: number, expectedVersion: number,
  qualityAcknowledged: boolean,
): Promise<DirectorWork> {
  return apiCall(`${workPath(project, workId)}/finalize`, {
    method: 'POST',
    json: { episode_ordinal: ordinal, expected_version: expectedVersion, quality_acknowledged: qualityAcknowledged },
  });
}

export async function getDirectorQualityReport(
  project: string, workId: string, ordinal: number,
): Promise<DirectorQualityReport> {
  return apiCall(`projects/${encodeURIComponent(project)}/director/v2/works/${encodeURIComponent(workId)}/quality/${ordinal}`);
}

export async function previewDirectorGeneration(
  project: string, workId: string, command: GenerateDirectorDraft,
): Promise<DirectorGenerationPreview> {
  return apiCall(`${workPath(project, workId)}/generate/preview`, { method: 'POST', json: command });
}

export async function generateDirectorDraft(
  project: string, workId: string, command: GenerateDirectorDraft,
): Promise<{ run_id: string; change: DirectorChange }> {
  return apiCall(`${workPath(project, workId)}/generate`, {
    method: 'POST', json: command, timeout: 5 * 60_000,
  });
}
