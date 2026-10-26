import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { AudioLines, ChevronDown, FileText, Maximize2, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { fetchRemixArtifact, fetchRemixOperation, fetchRemixTaskStatus, submitRemixProcessAction, type RemixArtifactRef, type RemixProcessRequest } from '@/api/remix';
import type { TranscriptNodeData } from '@/features/canvas/domain/canvasNodes';
import { correctedTimeline, readableTranscript, RealignmentRequiredError, segmentWordGroups, sourceMediaForTranscript, sourceScriptForTranscript, speechReviewItems, timelineSegments, timelineWords, transcriptPlaybackParts, transcriptSrt, type SpeechMatchReport, type SpeechMismatch, type TranscriptTimeline } from '@/features/canvas/remix/transcriptModel';
import { reviseTranscriptArtifact } from '@/features/canvas/remix/transcriptArtifactApi';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { CANVAS_NODE_PANEL_SURFACE_CLASS, canvasNodeFrameClass } from '@/features/canvas/ui/nodeFrameStyles';
import { NODE_CONTEXT_CONTROL_TRIGGER_CLASS } from '@/features/canvas/ui/nodeControlStyles';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';

type Props = NodeProps & { id: string; data: TranscriptNodeData; selected?: boolean };
type TranscriptLanguage = 'auto' | 'zh' | 'en';
type SpeechSubmission = Extract<RemixProcessRequest, { action: 'transcribe_media' | 'align_script' }>;
const activeSubmissions = new Map<string, ReturnType<typeof submitRemixProcessAction>>();

function transcriptLanguage(value: unknown): TranscriptLanguage {
  return value === 'zh' || value === 'en' || value === 'auto' ? value : 'auto';
}

function stamp(us: number): string {
  const ms = Math.max(0, Math.floor(us / 1_000));
  return `${String(Math.floor(ms / 60_000)).padStart(2, '0')}:${String(Math.floor(ms / 1_000) % 60).padStart(2, '0')}.${String(ms % 1_000).padStart(3, '0')}`;
}

/** Gutters only need enough precision to find the line, not to cut frames. */
function stampShort(us: number): string {
  const tenths = Math.max(0, Math.floor(us / 100_000));
  return `${String(Math.floor(tenths / 600)).padStart(2, '0')}:${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`;
}

function playbackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const whole = Math.floor(seconds);
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

function download(name: string, body: string, type: string): void {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export const TranscriptNode = memo(({ id, data, selected }: Props) => {
  const updateNodeInternals = useUpdateNodeInternals();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const source = useMemo(() => sourceMediaForTranscript(id, nodes, edges), [id, nodes, edges]);
  const scriptRef = useMemo(() => sourceScriptForTranscript(id, nodes, edges), [id, nodes, edges]);
  const [operationId, setOperationId] = useState<string | null>(typeof data.operationId === 'string' ? data.operationId : null);
  const [language, setLanguage] = useState<TranscriptLanguage>(() => transcriptLanguage(data.transcriptLanguage));
  const [edited, setEdited] = useState<string[]>(() => data.words.map((word) => word.text));
  const [showWordDetails, setShowWordDetails] = useState(false);
  const [confirmedTiming, setConfirmedTiming] = useState(false);
  const [activePartIndex, setActivePartIndex] = useState(-1);
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(-1);
  const [expandedSegments, setExpandedSegments] = useState<number[]>([]);
  const [mediaTime, setMediaTime] = useState(0);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [mediaPlaying, setMediaPlaying] = useState(false);
  const [mediaMuted, setMediaMuted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaRef = useRef<HTMLMediaElement>(null);
  const autoStartConsumed = useRef(false);
  const submissionReconciled = useRef(false);
  useEffect(() => updateNodeInternals(id), [id, updateNodeInternals]);
  useEffect(() => setEdited(data.words.map((word) => word.text)), [data.words]);
  useEffect(() => setLanguage(transcriptLanguage(data.transcriptLanguage)), [data.transcriptLanguage]);

  const project = readUrl().project;
  const artifactRef = data.artifactRef as RemixArtifactRef | null | undefined;
  const canSave = Boolean(artifactRef && edited.some((text, index) => text !== data.words[index]?.text));
  const transcriptText = typeof data.transcriptText === 'string' && data.transcriptText.trim()
    ? data.transcriptText
    : data.words.map((word) => word.text).join('');
  const displayTranscript = useMemo(() => readableTranscript(transcriptText, data.words), [transcriptText, data.words]);
  const playbackParts = useMemo(() => transcriptPlaybackParts(displayTranscript, data.words), [displayTranscript, data.words]);
  const segments = useMemo(() => (Array.isArray(data.segments) ? data.segments : []), [data.segments]);
  const segmentGroups = useMemo(() => segmentWordGroups(segments, data.words), [segments, data.words]);
  const reviewingWords = Boolean(showWordDetails) || expandedSegments.length > 0;
  const speechMismatch = data.speechMismatch as SpeechMismatch | null | undefined;
  const speechMatchReport = data.speechMatchReport as SpeechMatchReport | null | undefined;
  const speechReview = useMemo(() => speechReviewItems(speechMismatch, speechMatchReport), [speechMatchReport, speechMismatch]);
  const hasSpeechReview = Boolean(speechReview.length || speechMismatch?.report);
  const reviewScript = () => {
    const expected = (data.pendingScriptRef ?? scriptRef) as RemixArtifactRef | null | undefined;
    const scriptNode = nodes.find((node) => {
      const ref = node.data.remixScriptRef as RemixArtifactRef | null | undefined;
      return expected && ref?.artifactId === expected.artifactId && ref.revision === expected.revision;
    });
    if (scriptNode) setSelectedNode(scriptNode.id);
  };
  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    let frame: number | null = null;
    const sync = () => {
      const timeUs = Math.round(media.currentTime * 1_000_000);
      const index = playbackParts.findIndex((part) => part.startUs !== undefined && part.endUs !== undefined
        && timeUs >= part.startUs && timeUs < part.endUs);
      setActivePartIndex((current) => current === index ? current : index);
      const segment = segments.findIndex((item) => timeUs >= item.startUs && timeUs < item.endUs);
      setActiveSegmentIndex((current) => current === segment ? current : segment);
    };
    const tick = () => {
      sync();
      frame = window.requestAnimationFrame(tick);
    };
    const stop = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      sync();
    };
    const play = () => {
      sync();
      if (frame === null) frame = window.requestAnimationFrame(tick);
    };
    media.addEventListener('play', play);
    media.addEventListener('pause', stop);
    media.addEventListener('ended', stop);
    media.addEventListener('seeking', sync);
    media.addEventListener('timeupdate', sync);
    if (!media.paused) play();
    else sync();
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      media.removeEventListener('play', play);
      media.removeEventListener('pause', stop);
      media.removeEventListener('ended', stop);
      media.removeEventListener('seeking', sync);
      media.removeEventListener('timeupdate', sync);
    };
  }, [playbackParts, segments, source?.url]);
  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    const sync = () => {
      setMediaTime(media.currentTime);
      setMediaDuration(Number.isFinite(media.duration) ? media.duration : 0);
      setMediaPlaying(!media.paused);
      setMediaMuted(media.muted);
    };
    for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'seeking', 'play', 'pause', 'ended', 'volumechange']) {
      media.addEventListener(event, sync);
    }
    sync();
    return () => {
      for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'seeking', 'play', 'pause', 'ended', 'volumechange']) {
        media.removeEventListener(event, sync);
      }
    };
  }, [source?.url, source?.kind]);
  useEffect(() => {
    const needsText = !data.transcriptText;
    const needsSegments = !Array.isArray(data.segments);
    if (!project || !artifactRef || data.words.length === 0 || (!needsText && !needsSegments)) return;
    let cancelled = false;
    void fetchRemixArtifact(project, artifactRef).then((artifact) => {
      const payload = artifact.payload as TranscriptTimeline;
      if (cancelled || artifact.schema !== 'word_timeline.v1') return;
      const patch: Record<string, unknown> = {};
      if (needsText && typeof payload.transcript === 'string') patch.transcriptText = payload.transcript;
      const segments = timelineSegments(payload);
      if (needsSegments) patch.segments = segments;
      if (Object.keys(patch).length) updateNodeData(id, patch);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [artifactRef?.artifactId, artifactRef?.revision, data.segments, data.transcriptText, data.words.length, id, project, updateNodeData]);
  useEffect(() => {
    const aligned = data.alignedScriptRef as RemixArtifactRef | null | undefined;
    if (artifactRef && aligned && (!scriptRef || aligned.artifactId !== scriptRef.artifactId || aligned.revision !== scriptRef.revision)) {
      updateNodeData(id, { artifactRef: null, status: 'needs_review', alignmentStale: true, unresolved: ['脚本已修改，请重新对齐'] });
    }
  }, [artifactRef, data.alignedScriptRef, id, scriptRef, updateNodeData]);

  const start = async (mode: 'transcribe' | 'align', reconcile = false) => {
    const live = useCanvasStore.getState().nodes.find(node => node.id === id)?.data;
    if (busy || operationId || live?.operationId || live?.managedOperationId || (live?.transcriptSubmissionPending && !reconcile)) return;
    const saved = live?.transcriptSubmissionRequest as { project: string; request: SpeechSubmission } | undefined;
    if (saved && (saved.project !== project || !saved.request || !['transcribe_media', 'align_script'].includes(saved.request.action)
      || !saved.request.idempotencyKey || !saved.request.mediaPath || !Number.isInteger(saved.request.nodeRevision))) {
      if (reconcile) updateNodeData(id, { transcriptSubmissionPending: null });
      setError('原转写提交范围已变化，请核对已有任务'); return;
    }
    if (!project || !source) {
      if (reconcile) updateNodeData(id, { transcriptSubmissionPending: null });
      setError('请先连接已上传的音频或带声音视频'); return;
    }
    if (!saved && mode === 'align' && !scriptRef) { setError('请先连接已保存脚本的节点'); return; }
    if (!saved && data.words.length > 0 && !window.confirm('重新识别会替换当前校字结果，确定继续吗？')) return;
    const revision = (typeof data.nodeRevision === 'number' ? data.nodeRevision : 0) + 1;
    const request: SpeechSubmission = saved?.request ?? (mode === 'align'
      ? { action: 'align_script', mediaPath: source.path, scriptRef: scriptRef!, idempotencyKey: crypto.randomUUID(), nodeRevision: revision }
      : { action: 'transcribe_media', mediaPath: source.path, language, idempotencyKey: crypto.randomUUID(), nodeRevision: revision });
    const submissionKey = request.idempotencyKey;
    const ownsSubmission = () => useCanvasStore.getState().nodes.find(node => node.id === id)?.data.transcriptSubmissionPending === submissionKey;
    updateNodeData(id, { transcriptSubmissionPending: submissionKey, transcriptSubmissionRequest: { project, request } });
    setBusy(true); setError(null);
    try {
      const key = JSON.stringify([project, submissionKey]);
      let admission = activeSubmissions.get(key);
      if (!admission) {
        admission = submitRemixProcessAction(project, request).finally(() => activeSubmissions.delete(key));
        activeSubmissions.set(key, admission);
      }
      const task = await admission;
      if (!ownsSubmission()) {
        if (useCanvasStore.getState().nodes.find(node => node.id === id)?.data.operationId === task.operation_id) setOperationId(task.operation_id);
        return;
      }
      updateNodeData(id, { transcriptSubmissionPending: null, transcriptSubmissionRequest: null, operationId: task.operation_id, sourceMediaPath: request.mediaPath, nodeRevision: request.nodeRevision, status: 'needs_review', unresolved: [], artifactRef: null, reviewArtifactRef: null, speechMismatch: null, speechMatchReport: null, words: [], segments: [], transcriptText: null, pendingScriptRef: request.action === 'align_script' ? request.scriptRef : null, alignedScriptRef: null, alignmentStale: false });
      setShowWordDetails(false);
      setOperationId(task.operation_id);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      if (ownsSubmission()) updateNodeData(id, { status: 'failed', unresolved: [`转写提交未完成：${message}`] });
      setError(message);
    }
    finally { if (ownsSubmission()) updateNodeData(id, { transcriptSubmissionPending: null }); setBusy(false); }
  };
  useEffect(() => {
    // Reconcile one saved admission per mount with its actual original key.
    // A failed receipt leaves manual retry available with the same request.
    if (submissionReconciled.current || operationId || !data.transcriptSubmissionRequest) return;
    submissionReconciled.current = true;
    const saved = data.transcriptSubmissionRequest as { request?: SpeechSubmission };
    void start(saved.request?.action === 'align_script' ? 'align' : 'transcribe', true);
  }, [data.transcriptSubmissionRequest, id, operationId, project]);
  useEffect(() => {
    const mode = data.autoStartMode;
    if (mode !== 'transcribe' && mode !== 'align') { autoStartConsumed.current = false; return; }
    if (!source || (mode === 'align' && !scriptRef) || autoStartConsumed.current) return;
    autoStartConsumed.current = true;
    updateNodeData(id, { autoStartMode: null });
    void start(mode);
  }, [data.autoStartMode, id, source, scriptRef, start, updateNodeData]);
  useEffect(() => canvasEventBus.subscribe('remix-node/action', ({ nodeId, action }) => {
    if (nodeId !== id) return;
    if (action === 'transcribe') void start('transcribe');
    if (action === 'align') void start('align');
  }), [id, start]);

  useEffect(() => {
    if (!project || !operationId) return;
    let cancelled = false;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const operation = await fetchRemixOperation(project, operationId);
        if (cancelled) return;
        if (operation.status === 'failed' || operation.status === 'cancelled') throw new Error('语音识别失败，请重试');
        if (operation.status !== 'needs_confirmation' && operation.status !== 'completed' && operation.task_type && operation.task_scope) {
          const taskState = await fetchRemixTaskStatus(project, operation.task_type, operation.task_scope);
          if (taskState?.status === 'failed') throw new Error(taskState.error || '语音识别失败，请重试');
        }
        if (operation.status !== 'needs_confirmation' && operation.status !== 'completed') return;
        const output = operation.output_refs.find((item) => item.artifact_id && item.revision);
        if (!output?.artifact_id || !output.revision) throw new Error('语音识别未返回转写产物');
        const artifact = await fetchRemixArtifact(project, { artifactId: output.artifact_id, revision: output.revision });
        if (cancelled) return;
        if (artifact.schema !== 'word_timeline.v1') throw new Error('转写产物格式错误');
        const payload = artifact.payload as TranscriptTimeline;
        const store = useCanvasStore.getState();
        const current = sourceMediaForTranscript(id, store.nodes, store.edges);
        const saved = store.nodes.find((node) => node.id === id)?.data as TranscriptNodeData | undefined;
        if (!current || current.path !== saved?.sourceMediaPath) throw new Error('上游音频已变化，请重新转写');
        const pendingScript = saved?.pendingScriptRef as RemixArtifactRef | null | undefined;
        const currentScript = sourceScriptForTranscript(id, store.nodes, store.edges);
        if (pendingScript && (!currentScript || pendingScript.artifactId !== currentScript.artifactId || pendingScript.revision !== currentScript.revision)) {
          const message = '脚本已修改，请按当前脚本重新对齐';
          updateNodeData(id, { artifactRef: null, operationId: null, pendingScriptRef: null, status: 'needs_review', alignmentStale: true, unresolved: [message] });
          setError(message);
          setOperationId(null);
          return;
        }
        if (pendingScript && (payload.script_revision !== pendingScript.revision
          || !artifact.upstream_refs?.some((ref) => ref.artifact_id === pendingScript.artifactId && ref.revision === pendingScript.revision))) {
          const message = '对齐结果对应的脚本版本不一致，请重新对齐';
          updateNodeData(id, { artifactRef: null, operationId: null, pendingScriptRef: null, status: 'needs_review', alignmentStale: true, unresolved: [message] });
          setError(message);
          setOperationId(null);
          return;
        }
        if (payload.status === 'script_mismatch') {
          const message = '脚本与音频不一致，请核对台词后重新对齐';
          updateNodeData(id, { artifactRef: null, reviewArtifactRef: { artifactId: artifact.id, revision: artifact.revision }, speechMismatch: payload.mismatch ?? null, speechMatchReport: null, operationId: null, status: 'needs_review', alignmentStale: true, unresolved: [message] });
          setError(message);
          setOperationId(null);
          return;
        }
        const words = timelineWords(payload);
        if (payload.status !== 'completed' || words.length === 0) throw new Error('没有识别到人声，请检查素材');
        updateNodeData(id, { artifactRef: { artifactId: artifact.id, revision: artifact.revision }, words, segments: timelineSegments(payload), transcriptText: typeof payload.transcript === 'string' ? payload.transcript : words.map((word) => word.text).join(''), speechMismatch: null, speechMatchReport: payload.match_report ?? null, status: 'completed', unresolved: [], operationId: null, alignedScriptRef: saved?.pendingScriptRef ?? null, pendingScriptRef: null, alignmentStale: false });
        setShowWordDetails(false);
        setExpandedSegments([]);
        setOperationId(null);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
          updateNodeData(id, { operationId: null, status: 'failed' });
          setOperationId(null);
        }
      } finally { checking = false; }
    };
    void check();
    const timer = window.setInterval(() => void check(), 3_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [id, operationId, project, updateNodeData]);

  const saveCorrections = async () => {
    if (!project || !artifactRef || !canSave || busy) return;
    setBusy(true); setError(null);
    try {
      const artifact = await fetchRemixArtifact(project, artifactRef);
      if (artifact.schema !== 'word_timeline.v1') throw new Error('转写产物格式错误');
      const payload = artifact.payload as TranscriptTimeline;
      const revised = correctedTimeline(payload, payload.words.map((word, index) => edited[index] ?? word.text), confirmedTiming);
      const rawRefs = (artifact as typeof artifact & { upstream_refs?: Array<{ artifact_id: string; revision: number }> }).upstream_refs;
      if (!Array.isArray(rawRefs) && (data.alignedScriptRef || payload.script_ref)) throw new Error('无法确认对齐脚本版本，请重新对齐');
      const upstreamRefs = (rawRefs ?? []).map((upstream) => ({ artifactId: upstream.artifact_id, revision: upstream.revision }));
      const saved = await reviseTranscriptArtifact(project, artifactRef, revised, upstreamRefs);
      updateNodeData(id, { artifactRef: { artifactId: saved.id, revision: saved.revision }, words: timelineWords(revised), segments: timelineSegments(revised), transcriptText: revised.transcript, status: 'completed', pendingCorrectionText: null });
      setConfirmedTiming(false);
    } catch (caught) {
      if (caught instanceof RealignmentRequiredError) {
        updateNodeData(id, { artifactRef: null, status: 'needs_review', alignmentStale: true, pendingCorrectionText: edited.join(''), unresolved: ['台词已修改，请同步脚本并重新对齐'] });
      }
      setError(caught instanceof Error ? caught.message : String(caught));
    }
    finally { setBusy(false); }
  };

  const exportResult = async (format: 'json' | 'srt') => {
    if (!project || !artifactRef) return;
    try {
      const artifact = await fetchRemixArtifact(project, artifactRef);
      const name = `transcript-${artifactRef.artifactId}-r${artifactRef.revision}`;
      if (format === 'json') download(`${name}.json`, JSON.stringify(artifact.payload, null, 2), 'application/json');
      else download(`${name}.srt`, transcriptSrt(timelineWords(artifact.payload as TranscriptTimeline)), 'text/plain');
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };
  useEffect(() => canvasEventBus.subscribe('remix-node/action', ({ nodeId, action }) => {
    if (nodeId !== id) return;
    if (action === 'export_transcript_json') void exportResult('json');
    if (action === 'export_transcript_srt') void exportResult('srt');
  }), [artifactRef?.artifactId, artifactRef?.revision, id, project]);

  const sourceName = source?.path.split('/').pop() || source?.path;
  const mediaStatus = operationId || data.managedOperationId || data.transcriptSubmissionPending
    ? '处理中…'
    : data.status === 'no_speech' ? '未识别到人声'
      : artifactRef ? `已完成 · 版本 ${artifactRef.revision}`
        : data.status === 'failed' ? '失败' : '待转写';
  const togglePlayback = () => {
    const media = mediaRef.current;
    if (!media) return;
    if (media.paused) void media.play().catch(() => setError('无法播放来源素材'));
    else media.pause();
  };

  return <div className="group relative w-[420px]" onClick={() => setSelectedNode(id)}>
    <Handle type="target" position={Position.Left} id="target" className="!h-2 !w-2 !border-0 !bg-[rgb(148,163,184)]" />
    <Handle type="source" position={Position.Right} id="source" className="!h-2 !w-2 !border-0 !bg-[rgb(45,212,191)]" />
    <NodeHeader className={NODE_HEADER_FLOATING_POSITION_CLASS} icon={<FileText className="h-4 w-4" />} titleText={data.displayName || '转写与对齐'} editable={false} />
    <NodeResizeHandle minWidth={320} minHeight={220} maxWidth={760} maxHeight={900} />
    <div className={`flex max-h-[600px] flex-col overflow-hidden rounded-[var(--node-radius)] border ${CANVAS_NODE_PANEL_SURFACE_CLASS} ${canvasNodeFrameClass({ selected })}`}>
      <div className="border-b border-[rgb(var(--border-rgb))] p-3">
        <div className="flex gap-3">
          <div className="flex h-36 w-24 shrink-0 items-center justify-center overflow-hidden rounded-md border border-[rgb(var(--border-rgb))] bg-[rgb(var(--bg-rgb))]">
            {source?.url && source.kind === 'video'
              ? <video ref={mediaRef as React.RefObject<HTMLVideoElement>} src={source.url} preload="metadata" playsInline className="h-full w-full object-contain" />
              : source?.url && source.kind === 'audio'
                ? <><audio ref={mediaRef as React.RefObject<HTMLAudioElement>} src={source.url} preload="metadata" /><AudioLines aria-hidden="true" className="h-7 w-7 text-text-muted" /></>
                : <FileText aria-hidden="true" className="h-7 w-7 text-text-muted" />}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="text-xs text-text-muted">{source ? source.kind === 'audio' ? '来源音频' : '来源视频' : '来源素材'}</div>
            <div className="mt-1 truncate text-sm font-medium text-text-dark" title={source?.path}>
              {sourceName || '请连接音频或带声音视频'}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
              <span>{language === 'zh' ? '中文' : language === 'en' ? 'English' : '自动识别'}</span>
              <span aria-hidden="true" className="h-1 w-1 rounded-full bg-[rgb(var(--text-muted-rgb))]" />
              <span>{mediaStatus}</span>
            </div>
            {source?.url && <div className="mt-auto space-y-2">
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <button type="button" aria-label={mediaPlaying ? '暂停原片' : '播放原片'} onClick={togglePlayback} className="nodrag flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--accent-rgb)/0.16)] text-[rgb(var(--accent-rgb))] hover:bg-[rgb(var(--accent-rgb)/0.24)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent-rgb))]">
                  {mediaPlaying ? <Pause aria-hidden="true" className="h-3.5 w-3.5 fill-current" /> : <Play aria-hidden="true" className="h-3.5 w-3.5 fill-current" />}
                </button>
                <span className="min-w-0 flex-1 whitespace-nowrap font-mono">{playbackTime(mediaTime)} / {playbackTime(mediaDuration)}</span>
                <button type="button" aria-label={mediaMuted ? '取消静音' : '静音'} onClick={() => { if (mediaRef.current) mediaRef.current.muted = !mediaRef.current.muted; }} className="nodrag rounded-sm p-1 text-text-muted hover:text-text-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent-rgb))]">
                  {mediaMuted ? <VolumeX aria-hidden="true" className="h-4 w-4" /> : <Volume2 aria-hidden="true" className="h-4 w-4" />}
                </button>
                {source.kind === 'video' && <button type="button" aria-label="全屏播放" onClick={() => void mediaRef.current?.requestFullscreen?.()} className="nodrag rounded-sm p-1 text-text-muted hover:text-text-dark focus-visible:outline focus-visible:outline-2 focus-visible:outline-[rgb(var(--accent-rgb))]">
                  <Maximize2 aria-hidden="true" className="h-4 w-4" />
                </button>}
              </div>
              <input type="range" aria-label="播放进度" min={0} max={mediaDuration || 0} step={0.01} value={Math.min(mediaTime, mediaDuration || 0)} disabled={!mediaDuration} onChange={(event) => { if (mediaRef.current) mediaRef.current.currentTime = Number(event.target.value); setMediaTime(Number(event.target.value)); }} className="nodrag h-1 w-full cursor-pointer accent-[rgb(var(--accent-rgb))] disabled:cursor-not-allowed" />
            </div>}
          </div>
        </div>
      </div>
      <div className="ui-scrollbar nowheel overflow-auto p-3">
        <div className="mb-2 flex items-center justify-between text-xs text-text-muted">
          <span className="font-medium text-text-dark">转写内容</span>
          {data.words.length > 0 && <span>{data.words.length} 词</span>}
        </div>
        {Boolean(data.alignmentStale) && <p className="px-2 py-1 text-xs text-amber-300">{data.unresolved?.[0] || (data.pendingCorrectionText ? '台词已修改，请同步脚本并重新对齐' : '脚本已修改，请重新对齐')}</p>}
        {hasSpeechReview && <div className="mx-2 mb-2 rounded-[12px] border border-white/10 bg-surface-field p-2 text-xs text-text-muted">
          <ul className="space-y-1">{(speechReview.length ? speechReview : ['对齐覆盖不完整，请核对台词']).map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={reviewScript} className={NODE_CONTEXT_CONTROL_TRIGGER_CLASS}>校对台词</button>
            <button type="button" disabled={!scriptRef || busy || Boolean(operationId || data.managedOperationId || data.transcriptSubmissionPending) || !source} onClick={() => void start('align')} className={`${NODE_CONTEXT_CONTROL_TRIGGER_CLASS} disabled:opacity-50`}>重新对齐</button>
          </div>
        </div>}
        {data.words.length > 0 && (segmentGroups.length > 0 ? <>
          <div className="space-y-px">{segmentGroups.map(({ segment, words }, index) => {
            const open = expandedSegments.includes(index);
            const active = activeSegmentIndex === index;
            return <div key={`${segment.startUs}-${index}`} className="group/seg relative">
              <div className={`relative flex items-start gap-2 rounded-[6px] transition-colors ${active ? 'bg-[rgb(var(--accent-rgb)/0.08)]' : 'hover:bg-white/[0.035]'}`}>
                {active && <span aria-hidden="true" className="absolute bottom-1 left-0 top-1 w-[2px] rounded-full bg-[rgb(var(--accent-rgb))]" />}
                <button type="button" aria-label={`跳转到第 ${index + 1} 句，${stamp(segment.startUs)}`} aria-current={active ? 'true' : undefined} onClick={() => { if (mediaRef.current) mediaRef.current.currentTime = segment.startUs / 1_000_000; setActiveSegmentIndex(index); }} className="nodrag group/line flex min-w-0 flex-1 items-start gap-2.5 rounded-[6px] py-[3px] pl-2 text-left focus-visible:outline focus-visible:outline-1 focus-visible:outline-[rgb(var(--accent-rgb))]">
                  <span className={`w-[42px] shrink-0 pt-px font-mono text-[10px] tabular-nums transition-colors ${active ? 'text-[rgb(var(--accent-rgb))]' : 'text-text-muted/70 group-hover/line:text-text-muted'}`}>{stampShort(segment.startUs)}</span>
                  <span className={`min-w-0 flex-1 whitespace-pre-wrap text-[13px] leading-[1.6] ${active ? 'text-text-dark' : 'text-text-dark/80 group-hover/line:text-text-dark'}`}>{segment.text}</span>
                </button>
                {words.length > 0 && <button type="button" aria-expanded={open} aria-label={`${open ? '收起' : '展开'}第 ${index + 1} 句逐词校对（${words.length}）`} onClick={() => setExpandedSegments((current) => open ? current.filter((item) => item !== index) : [...current, index])} className={`nodrag mr-1 mt-[3px] flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-text-muted transition-opacity hover:bg-white/10 hover:text-text-dark focus-visible:outline focus-visible:outline-1 focus-visible:outline-[rgb(var(--accent-rgb))] ${open ? 'opacity-100' : 'opacity-35 group-hover/seg:opacity-100 focus-visible:opacity-100'}`}>
                  <ChevronDown aria-hidden="true" className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
                </button>}
              </div>
              {open && <div className="mb-1 ml-[58px] mt-0.5 border-l border-white/[0.09] pl-2">{words.map(({ word, index: wordIndex }) => <div key={`${word.startUs}-${wordIndex}`} className="group/word flex items-center gap-2 rounded-[4px] py-[1px] pr-1 transition-colors hover:bg-white/[0.05]">
                <button type="button" title={`跳到 ${stamp(word.startUs)}`} className="w-[38px] shrink-0 rounded-[4px] text-right font-mono text-[10px] tabular-nums text-text-muted/60 transition-colors group-hover/word:text-text-muted hover:!text-[rgb(var(--accent-rgb))] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[rgb(var(--accent-rgb))]" onClick={() => { if (mediaRef.current) mediaRef.current.currentTime = word.startUs / 1_000_000; }}>{stampShort(word.startUs)}</button>
                <input aria-label={`第 ${wordIndex + 1} 个字词`} value={edited[wordIndex] ?? word.text} onChange={(event) => { setConfirmedTiming(false); setEdited((current) => current.map((text, position) => position === wordIndex ? event.target.value : text)); }} className={`nodrag min-w-0 flex-1 rounded-[4px] border-b bg-transparent px-0.5 py-[1px] text-[12.5px] leading-[1.45] text-text-dark outline-none transition-colors ${edited[wordIndex] !== undefined && edited[wordIndex] !== word.text ? 'border-[rgb(var(--accent-rgb)/0.55)]' : 'border-transparent hover:border-white/12 focus:border-[rgb(var(--accent-rgb)/0.6)]'}`} />
                {typeof word.confidence === 'number' && word.confidence < 0.6 && <span title="低置信度" aria-label="低置信度" className="mr-1 h-[5px] w-[5px] shrink-0 rounded-full bg-amber-300/70" />}
              </div>)}</div>}
            </div>;
          })}</div>
          <button type="button" onClick={() => setExpandedSegments((current) => current.length === segmentGroups.length ? [] : segmentGroups.map((_, index) => index))} className={`${NODE_CONTEXT_CONTROL_TRIGGER_CLASS} mt-2`}>{expandedSegments.length === segmentGroups.length ? '收起逐词校对' : `展开逐词校对（${data.words.length}）`}</button>
        </> : <>
          <p className="whitespace-pre-wrap text-sm leading-6 text-text-dark">{playbackParts.map((part, index) => part.startUs === undefined
            ? <span key={index}>{part.text}</span>
            : <button key={index} type="button" aria-label={`跳转到 ${part.text}，${stamp(part.startUs)}`} aria-current={activePartIndex === index ? 'true' : undefined} onClick={() => { if (mediaRef.current) mediaRef.current.currentTime = part.startUs! / 1_000_000; setActivePartIndex(index); }} className={`nodrag rounded-sm text-inherit hover:bg-[rgb(var(--accent-rgb)/0.12)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[rgb(var(--accent-rgb))] ${activePartIndex === index ? 'bg-[rgb(var(--accent-rgb)/0.2)]' : ''}`}>{part.text}</button>)}</p>
          <button type="button" onClick={() => setShowWordDetails((current) => !current)} className={`${NODE_CONTEXT_CONTROL_TRIGGER_CLASS} mt-3`}>{showWordDetails ? '收起逐词校对' : `展开逐词校对（${data.words.length}）`}</button>
          {showWordDetails && data.words.map((word, index) => <div key={`${word.startUs}-${index}`} className="flex items-center gap-2 rounded-md px-2 py-1 text-[12px] text-text-dark">
            <button type="button" className="w-[145px] shrink-0 text-left font-mono text-[11px] text-text-muted" onClick={() => { if (mediaRef.current) mediaRef.current.currentTime = word.startUs / 1_000_000; }}>{stamp(word.startUs)} – {stamp(word.endUs)}</button>
            <input aria-label={`第 ${index + 1} 个字词`} value={edited[index] ?? word.text} onChange={(event) => { setConfirmedTiming(false); setEdited((current) => current.map((text, position) => position === index ? event.target.value : text)); }} className="nodrag min-w-0 flex-1 rounded-[12px] border border-white/10 bg-surface-field px-2 py-1 outline-none focus:border-white/25" />
            {typeof word.confidence === 'number' && word.confidence < 0.6 && <span className="shrink-0 text-amber-300">低置信度</span>}
          </div>)}
        </>)}
        {data.words.length === 0 && <p className="px-2 py-3 text-[12px] text-text-muted">{data.status === 'no_speech' ? '这段素材未识别到人声，原片拆解会继续分析画面。' : '暂无转写内容'}</p>}
      </div>
      {artifactRef && reviewingWords && <div className="border-t border-white/[0.08] p-3 text-xs"><label className="mb-2 flex items-center gap-2 text-text-muted"><input type="checkbox" checked={confirmedTiming} onChange={(event) => setConfirmedTiming(event.target.checked)} />仅校正同一发音和词边界，保留原时间</label><button type="button" disabled={!canSave || busy} onClick={() => void saveCorrections()} className={`${NODE_CONTEXT_CONTROL_TRIGGER_CLASS} disabled:opacity-50`}>保存校字</button></div>}
      {error && error !== data.unresolved?.[0] && <p role="alert" className="px-3 pb-2 text-xs text-red-300">{error}</p>}
    </div>
  </div>;
});
TranscriptNode.displayName = 'TranscriptNode';
