import { attachRemixMedia, fetchRemixArtifact, type RemixArtifactRef, type RemixUploadedMedia } from '@/api/remix';
import { apiCall } from '@/api/client';
import { captureFreezoneCanvasScope, flushFreezoneCanvasRuntime } from '@/features/freezone/canvasSyncRuntime';
import type { ReferenceAnalysisRun } from '@/api/referenceAnalysisRuns';
import { timelineSegments, timelineWords, type TranscriptTimeline } from '@/features/canvas/remix/transcriptModel';
import { refreshProductionCanvas } from '@/features/superchat/productionCanvasRefresh';
import { normalizeVideoStoryRows } from './videoStoryNormalizer';
import { CANVAS_NODE_TYPES, VIDEO_STORY_NODE_DEFAULT_SIZE } from '@/features/canvas/domain/canvasNodes';
import { projectMediaPathFromUrl } from '@/features/canvas/remix/remixMediaPath';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';
import { isSourceTranscriptPreparing, startSourceTranscript } from './startSourceTranscript';

const running = new Map<string, Promise<void>>();
const nativeSubmissions = new Map<string, { fingerprint: string; current: () => boolean; promise: Promise<ReferenceAnalysisRun> }>();

/** Executed by the approved canvas command, returning admission rather than completion. */
export async function submitReferenceAnalysisCommand(project: string, canvas: string, sourceId: string, value: unknown): Promise<ReferenceAnalysisRun> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('原片分析参数缺失');
  const parameters = value as Record<string, unknown>;
  if (parameters.project_id !== project || parameters.canvas_id !== canvas || parameters.source_node_id !== sourceId
    || typeof parameters.user_goal !== 'string' || !parameters.user_goal.trim()
    || typeof parameters.idempotency_key !== 'string' || !parameters.idempotency_key.trim()
    || typeof parameters.agent_id !== 'string' || !parameters.agent_id.trim()
    || !parameters.inputs || typeof parameters.inputs !== 'object' || Array.isArray(parameters.inputs)) throw new Error('原片分析范围或参数不匹配');
  const source = useCanvasStore.getState().nodes.find(node => node.id === sourceId);
  if (source?.type !== CANVAS_NODE_TYPES.video || !source.data.videoUrl) throw new Error('原片视频节点不存在');
  const currentScope = captureFreezoneCanvasScope(project, canvas);
  const current = () => currentScope() && nodeData(sourceId)?.videoUrl === source.data.videoUrl;
  if (!current()) throw new Error('当前画布已切换，请返回原画布');
  const fingerprint = JSON.stringify([parameters, source.data.videoUrl]);
  const key = JSON.stringify([project, canvas, parameters.agent_id, parameters.idempotency_key]);
  const previous = nativeSubmissions.get(key);
  if (previous?.current()) {
    if (previous.fingerprint !== fingerprint) throw new Error('原片分析请求已变化，请重新确认');
    return previous.promise;
  }
  const promise = (async () => {
    if (await flushFreezoneCanvasRuntime(project, canvas) !== true || !current()) throw new Error('画布尚未保存或原片已变化');
    const existingNodeIds = new Set(useCanvasStore.getState().nodes.map(node => node.id));
    const { source_node_id, user_goal, inputs, idempotency_key, agent_id } = parameters;
    const run = await apiCall<ReferenceAnalysisRun>(`projects/${encodeURIComponent(project)}/freezone/canvases/${encodeURIComponent(canvas)}/reference-analysis-runs`,
      { method: 'POST', json: { source_node_id, user_goal, inputs, idempotency_key, agent_id } });
    if (run.project_id !== project || run.canvas_id !== canvas || run.source_node_id !== sourceId || run.agent_id !== agent_id
      || !run.run_id || !run.analysis_node_id) throw new Error('原片分析返回的任务身份不匹配');
    // Admission added nodes on the server. Merge them before the approval flow's
    // next flush, which would otherwise still hold the pre-admission graph.
    await refreshProductionCanvas(project, canvas, current);
    const newNodeId = [run.transcript_node_id, run.analysis_node_id].find(id => id && !existingNodeIds.has(id)
      && useCanvasStore.getState().nodes.some(node => node.id === id));
    if (current() && newNodeId) useCanvasStore.getState().requestFocusNode(newNodeId);
    return run;
  })();
  nativeSubmissions.set(key, { fingerprint, current, promise });
  try { return await promise; } catch (error) { nativeSubmissions.delete(key); throw error; }
}

async function displayReferenceTranscript(project: string, sourceId: string, storyId: string, media: RemixUploadedMedia,
  payload: Record<string, unknown>, current: () => boolean, selectedTranscriptId: string | null): Promise<void> {
  const ref = artifactRef(payload.transcript_ref);
  if (payload.transcript_status !== 'completed' || !ref) return;
  const artifact = await fetchRemixArtifact(project, ref);
  if (!current()) throw new Error('原片已变化，请重新分析');
  const timeline = artifact.payload as TranscriptTimeline;
  if (artifact.schema !== 'word_timeline.v1' || timeline.media_hash !== `sha256:${media.media_hash}`
    || timeline.status !== 'completed') throw new Error('转写产物与原片不匹配');
  const words = timelineWords(timeline);
  if (!words.length) throw new Error('原片转写缺少真实时间词');
  const segments = timelineSegments(timeline);
  const store = useCanvasStore.getState();
  const existing = selectedTranscriptId ? store.nodes.find(node => node.id === selectedTranscriptId) : store.nodes.find(node => node.type === CANVAS_NODE_TYPES.transcript
    && node.data.sourceMediaPath === media.media_path && node.data.sourceMediaHash === media.media_hash
    && store.edges.some(edge => edge.source === sourceId && edge.target === node.id));
  const data = {
    displayName: '原片转写', artifactRef: ref, words, segments, transcriptText: timeline.transcript ?? words.map(word => word.text).join(''),
    sourceMediaPath: media.media_path, sourceMediaHash: media.media_hash, transcriptLanguage: timeline.language,
    status: 'completed', unresolved: [], autoStartMode: null, operationId: null, managedOperationId: null,
  };
  const existingRef = existing?.data.artifactRef as RemixArtifactRef | undefined;
  if (existingRef && (existingRef.artifactId !== ref.artifactId || existingRef.revision !== ref.revision)) throw new Error('原片转写已变化，请重新分析');
  const transcriptId = existing?.id ?? store.addNode(CANVAS_NODE_TYPES.transcript, store.findNodePosition(sourceId, 480, 220), data);
  if (existing && (!Array.isArray(existing.data.words) || !existing.data.words.length)) store.updateNodeData(existing.id, data);
  for (const [source, target] of [[sourceId, transcriptId], [transcriptId, storyId]]) {
    if (!store.edges.some(edge => edge.source === source && edge.target === target) && !store.addEdge(source, target)) throw new Error('连接原片转写节点失败');
  }
}

function patch(id: string, value: Record<string, unknown>): void {
  useCanvasStore.getState().updateNodeData(id, value);
}

function nodeData(id: string): Record<string, unknown> | null {
  return useCanvasStore.getState().nodes.find((node) => node.id === id)?.data ?? null;
}

function artifactRef(value: unknown): RemixArtifactRef | null {
  if (!value || typeof value !== 'object') return null;
  const ref = value as { artifact_id?: string; revision?: number };
  return typeof ref.artifact_id === 'string' && typeof ref.revision === 'number'
    ? { artifactId: ref.artifact_id, revision: ref.revision } : null;
}

function waitForSavedTranscript(id: string, current: () => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const finish = (error?: Error, data?: Record<string, unknown>) => {
      unsubscribe(); window.clearTimeout(timeout);
      if (error) reject(error); else resolve(data!);
    };
    const check = () => {
      if (!current()) return finish(new Error('原片或转写连线已变化，请重新分析'));
      const data = nodeData(id);
      if (!data) return finish(new Error('原片转写节点已删除'));
      if (data.status === 'failed') return finish(new Error(`原片转写失败：${(data.unresolved as string[] | undefined)?.[0] || '请在转写节点重试'}`));
      const ref = data.artifactRef as RemixArtifactRef | undefined;
      if (data.status === 'completed' && ref?.artifactId && Number.isInteger(ref.revision) && ref.revision > 0
        && Array.isArray(data.words) && data.words.length && !data.operationId && !data.managedOperationId
        && data.autoStartMode !== 'transcribe' && !data.transcriptSubmissionPending && !data.transcriptSubmissionRequest) finish(undefined, data);
    };
    const timeout = window.setTimeout(() => finish(new Error('原片转写尚未完成，请检查转写任务后重新分析')), 30 * 60_000);
    unsubscribe = useCanvasStore.subscribe(check);
    check();
  });
}

async function runAnalysis(sourceId: string, storyId: string, videoUrl: string): Promise<void> {
  const { project, canvas } = readUrl();
  let expectedMediaHash: string | null = null;
  let inputTranscriptId: string | null = null;
  let inputTranscriptRef: RemixArtifactRef | null = null;
  let selectedTranscriptId: string | null = null;
  const current = () => nodeData(sourceId)?.videoUrl === videoUrl
    && (expectedMediaHash === null || (nodeData(sourceId)?.remixMedia as RemixUploadedMedia | undefined)?.media_hash === expectedMediaHash)
    && readUrl().project === project && readUrl().canvas === canvas
    && (!selectedTranscriptId || nodeData(selectedTranscriptId) !== null
      && useCanvasStore.getState().edges.some(edge => edge.source === sourceId && edge.target === selectedTranscriptId)
      && useCanvasStore.getState().edges.some(edge => edge.source === selectedTranscriptId && edge.target === storyId)
      && useCanvasStore.getState().edges.some(edge => edge.source === sourceId && edge.target === storyId))
    && (!inputTranscriptRef || (nodeData(inputTranscriptId!)?.artifactRef as RemixArtifactRef | undefined)?.artifactId === inputTranscriptRef.artifactId
      && (nodeData(inputTranscriptId!)?.artifactRef as RemixArtifactRef | undefined)?.revision === inputTranscriptRef.revision);
  try {
    if (!project || !canvas) throw new Error('请先保存当前项目画布');
    if (isSourceTranscriptPreparing(sourceId)) throw new Error('原片转写仍在处理中，请完成后重新点击分析原片');
    const path = projectMediaPathFromUrl(project, videoUrl);
    if (!path) throw new Error('原片尚未保存到当前项目');
    const existing = nodeData(sourceId)?.remixMedia as RemixUploadedMedia | undefined;
    const media = existing?.media_kind === 'video' && existing.media_path === path ? existing : await attachRemixMedia(project, path);
    if (!current() || media.media_kind !== 'video') throw new Error('原片已变化，请重新分析');
    expectedMediaHash = media.media_hash;
    patch(sourceId, { remixMedia: media, remixRole: 'reference' });
    patch(storyId, { sourceMediaHash: media.media_hash, sourceMediaPath: media.media_path, referenceEvidenceRef: null,
      referenceTranscriptRef: null, referenceBlueprintRef: null, referenceAnalysisRef: null, remixAnalysisStage: 'analyzing' });
    if (media.has_audio) {
      const before = useCanvasStore.getState();
      const linked = before.nodes.filter(node => node.type === CANVAS_NODE_TYPES.transcript
        && before.edges.some(edge => edge.source === node.id && edge.target === storyId));
      const eligible = before.nodes.filter(node => node.type === CANVAS_NODE_TYPES.transcript
        && before.edges.some(edge => edge.source === sourceId && edge.target === node.id)
        && node.data.sourceMediaPath === media.media_path && node.data.sourceMediaHash === media.media_hash);
      if (linked.length > 1 || (!linked.length && eligible.length > 1)) throw new Error('存在多个原片转写输入，请保留一个明确连接的转写后重新分析');
      const selected = linked[0] ?? eligible[0];
      if (linked[0] && !eligible.some(node => node.id === linked[0].id)) throw new Error('当前拆解的转写未连接此原片，请核对输入后重新分析');
      if (isSourceTranscriptPreparing(sourceId)) throw new Error('原片转写仍在处理中，请完成后重新点击分析原片');
      const transcriptId = selected?.id ?? await startSourceTranscript(sourceId, { autoStart: false, reuseExisting: true });
      if (!current()) throw new Error('原片已变化，请重新分析');
      const store = useCanvasStore.getState();
      if (!store.edges.some(edge => edge.source === transcriptId && edge.target === storyId)
        && !store.addEdge(transcriptId, storyId)) throw new Error('连接原片转写与拆解节点失败');
      selectedTranscriptId = transcriptId;
      let transcript = nodeData(transcriptId)!;
      const busy = transcript.operationId || transcript.managedOperationId || transcript.transcriptSubmissionPending
        || transcript.autoStartMode === 'transcribe' || (transcript.transcriptSubmissionRequest && transcript.status !== 'failed');
      if (busy || transcript.status !== 'completed' || !(transcript.artifactRef as RemixArtifactRef | undefined)?.artifactId) {
        if (!busy) {
          if (Array.isArray(transcript.words) && transcript.words.length) throw new Error('转写校字尚未保存或需重新对齐，请处理后分析');
          patch(transcriptId, { autoStartMode: 'transcribe', status: 'needs_review', unresolved: [], words: [] });
        }
        transcript = await waitForSavedTranscript(transcriptId, current);
      }
      const savedRef = transcript.artifactRef as RemixArtifactRef;
      if (!Array.isArray(transcript.words) || !transcript.words.length) throw new Error('原片转写缺少已保存的实际词时间');
      inputTranscriptId = transcriptId;
      inputTranscriptRef = { ...savedRef };
    }
    if (await flushFreezoneCanvasRuntime(project, canvas) !== true || !current()) throw new Error('画布未保存或原片已变化，请重新分析');
    const endpoint = `projects/${encodeURIComponent(project)}/freezone/canvases/${encodeURIComponent(canvas)}/reference-analysis`;
    type Receipt = { operation_id: string; status: string; analysis_ref?: unknown; error?: string };
    let receipt = await apiCall<Receipt>(endpoint, { method: 'POST', json: { source_node_id: sourceId, idempotency_key: crypto.randomUUID(),
      ...(selectedTranscriptId ? { transcript_node_id: selectedTranscriptId, analysis_node_id: storyId } : {}) } });
    if (!current()) throw new Error('原片已变化，请重新分析');
    patch(storyId, { managedEvidenceOperationId: receipt.operation_id });
    const deadline = Date.now() + 30 * 60_000;
    while (receipt.status !== 'completed') {
      if (['failed', 'cancelled', 'stale'].includes(receipt.status)) throw new Error(receipt.error || '原片分析任务失败');
      if (!current()) throw new Error('原片已变化，请重新分析');
      if (Date.now() >= deadline) throw new Error('原片处理超时，请检查任务状态');
      await new Promise(resolve => window.setTimeout(resolve, 1_000));
      receipt = await apiCall<Receipt>(`${endpoint}/${encodeURIComponent(receipt.operation_id)}`);
    }
    const ref = artifactRef(receipt.analysis_ref);
    if (!ref) throw new Error('原片联合分析没有返回完成产物');
    const artifact = await fetchRemixArtifact(project, ref);
    if (!current()) throw new Error('原片已变化，请重新分析');
    if (artifact.schema !== 'reference_analysis.v1' || artifact.payload.media_hash !== `sha256:${media.media_hash}`) throw new Error('原片证据与当前视频不匹配');
    const payload = artifact.payload;
    const usedTranscriptRef = artifactRef(payload.transcript_ref);
    if (inputTranscriptRef && (usedTranscriptRef?.artifactId !== inputTranscriptRef.artifactId || usedTranscriptRef.revision !== inputTranscriptRef.revision)) {
      throw new Error('原片分析未使用当前转写修订，请重新分析');
    }
    const story = payload.story as Record<string, unknown> | undefined;
    if (!story?.video_story) throw new Error('原片分析缺少叙事结果');
    await displayReferenceTranscript(project, sourceId, storyId, media, payload, current, selectedTranscriptId);
    patch(storyId, { rows: normalizeVideoStoryRows(story), rawResult: story,
      referenceEvents: Array.isArray(story.reference_events) ? story.reference_events : [],
      referenceAnalysisRef: ref, referenceEvidenceRef: artifactRef(payload.evidence_ref),
      referenceTranscriptRef: artifactRef(payload.transcript_ref), referenceBlueprintRef: artifactRef(payload.blueprint_ref),
      referenceTranscriptStatus: payload.transcript_status, referenceAnalysisCoverage: payload.coverage,
      referenceAnalysisLimitations: payload.limitations ?? [], referenceAnalysisUnknowns: payload.unknowns ?? [],
      managedEvidenceOperationId: null, remixAnalysisStage: 'completed', isAnalyzing: false, analysisError: null });
  } catch (error) {
    patch(storyId, { remixAnalysisStage: 'failed', managedEvidenceOperationId: null, isAnalyzing: false,
      analysisError: error instanceof Error ? error.message : String(error), ...(!current() ? { rows: [], rawResult: null,
        referenceEvents: [], referenceAnalysisRef: null, referenceEvidenceRef: null, referenceTranscriptRef: null, referenceBlueprintRef: null } : {}) });
  }
}

export function analyzeReferenceVideo(sourceId: string, opts: { videoUrl: string; targetStoryId?: string }): { nodeId: string; completion: Promise<void> } {
  const store = useCanvasStore.getState();
  const source = store.nodes.find((node) => node.id === sourceId);
  if (!source || source.type !== CANVAS_NODE_TYPES.video || source.data.videoUrl !== opts.videoUrl) throw new Error('请选择已上传的视频节点');

  const explicitTarget = opts.targetStoryId
    ? store.nodes.find((node) => node.id === opts.targetStoryId
      && node.type === CANVAS_NODE_TYPES.videoStory
      && store.edges.some((edge) => edge.source === sourceId && edge.target === node.id))
    : null;
  if (opts.targetStoryId && !explicitTarget) throw new Error('当前原片拆解节点未连接此视频');

  const runningTarget = !explicitTarget
    ? store.edges
      .filter((edge) => edge.source === sourceId)
      .map((edge) => store.nodes.find((node) => node.id === edge.target && node.type === CANVAS_NODE_TYPES.videoStory))
      .find((node) => node && running.has(node.id))
    : null;
  if (runningTarget) return { nodeId: runningTarget.id, completion: running.get(runningTarget.id)! };

  const storyId = explicitTarget?.id ?? store.addNode(CANVAS_NODE_TYPES.videoStory,
    store.findNodePosition(sourceId, VIDEO_STORY_NODE_DEFAULT_SIZE.width, VIDEO_STORY_NODE_DEFAULT_SIZE.height), {
    displayName: '原片拆解', sourceVideoUrl: opts.videoUrl, rows: [], rawResult: null, isAnalyzing: true, remixAnalysisStage: 'preparing', analysisError: null,
  });
  if (!explicitTarget && !store.addEdge(sourceId, storyId)) { store.deleteNode(storyId); throw new Error('连接原片拆解节点失败'); }
  const pending = running.get(storyId);
  if (pending) return { nodeId: storyId, completion: pending };
  patch(storyId, { sourceVideoUrl: opts.videoUrl, isAnalyzing: true, analysisError: null, remixAnalysisStage: 'preparing' });
  const completion = runAnalysis(sourceId, storyId, opts.videoUrl).finally(() => running.delete(storyId));
  running.set(storyId, completion);
  return { nodeId: storyId, completion };
}

/** Resolve an Agent action only after the generated analysis has usable output. */
export async function waitForReferenceVideoAnalysis(
  result: { nodeId: string; completion: Promise<void> },
  persist?: () => Promise<void>,
): Promise<{ nodeId: string; analysisNodeId: string }> {
  await result.completion;
  const data = nodeData(result.nodeId);
  if (!data) throw new Error('原片拆解节点已删除');
  if (typeof data.analysisError === 'string' && data.analysisError) throw new Error(data.analysisError);
  if (data.isAnalyzing || data.remixAnalysisStage !== 'completed' || !data.rawResult) throw new Error('原片拆解尚未完成');
  await persist?.();
  return { nodeId: result.nodeId, analysisNodeId: result.nodeId };
}
