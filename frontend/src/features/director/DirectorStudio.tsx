// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/** A new screenplay surface: the canvas card, editor and chat all read one document version. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUp, ChevronDown, Clock3, History, Minus, PanelRight, Plus, Settings2, X, Share2, Plug, Hand, ScrollText, NodeCharacter, MessageCirclePlus, DirectorReferenceIcon, FileText, Caption, Maximize2, Sparkles, Download, ChevronRight, Check } from './components/DirectorReferenceIcon';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  createDirectorWork, decideDirectorChange, directorDocumentKey,
  decideOutlineGroups, outlineDecisionCommand,
  finalizeDirectorV2, getDirectorDocument,
  getDirectorModelContract,
  getDirectorQualityReport,
  getOutlineQualityReport, type OutlineQualityReport,
  getDirectorWork, listDirectorWorks,
  proposeDirectorChange, putDirectorDocument,
  updateDirectorWork,
  getCanonicalDocuments, previewSettingsRevision, previewEpisodeReopen, commitDirectorRevision,
  type RevisionImpact, type CommitRevision, type CanonicalDocumentProjection,
  type DirectorChange, type DirectorDocument, type DirectorDocumentKind,
  type DirectorWork,
  type DirectorModelContract,
  type DirectorQualityReport,
  type FinalizeDirectorCommand,
  type DirectorWorkDetail,
  type DirectorMediaKind,
} from '@/api/director';
import { ApiError } from '@/api/client';
import { DirectorPresetDialog, GENRES, PRESET_DEFAULTS, type DirectorWorkDraft } from './DirectorPresetDialog';
import { DirectorSettingsDialog } from './components/DirectorSettingsDialog';
import { DirectorHistoryPopover } from './components/DirectorHistoryPopover';
import { DirectorPopover } from './components/DirectorPopover';
import { DirectorCanvas } from './components/DirectorCanvas';
import { DirectorMediaNodes } from './components/DirectorMediaNodes';
import { DirectorRichText } from './components/DirectorRichText';
import { readDirectorPreference, saveDirectorPreference, notifyDirectorTask } from './director-ui-state';
import { DirectorWindow } from './components/DirectorWindow';
import { executionCommand, getExecutionCapability, getRetainedResult, isExecutionActive, listExecutionRuns, sendExecutionCommand,
  type ExecutionCapability, type ExecutionCommand, type ExecutionQuote, type ExecutionRun, type RetainedResult } from '@/api/director-execution';
import { DirectorConversation, ConversationScroll } from './components/DirectorConversation';
import { RequestParameters } from './components/ExecutionHistory';
import { useExecutionStream } from './useExecutionStream';
import { PlanningWorkflow } from './components/PlanningWorkflow';
import type { PlanningState } from '@/api/director-execution';
import { DocumentVersionPanel } from './components/DocumentVersionPanel';
import { QualityReviewDialog } from './components/QualityReviewDialog';
import { OutlineReviewDialog } from './components/OutlineReviewDialog';
import { OutlinePatchReview } from './components/OutlinePatchReview';
import { RevisionImpactDialog } from './components/RevisionImpactDialog';
import { DirectorDocumentEditor } from './components/DirectorDocumentEditor';
import { DirectorMediaPanel } from './components/DirectorMediaPanel';
import './director.css';

const SECTIONS: Array<{ kind: DirectorDocumentKind; key: string }> = [
  { kind: 'outline', key: 'outline' },
  { kind: 'characters', key: 'characters' },
  { kind: 'scenes', key: 'scenes' },
  { kind: 'props', key: 'props' },
  { kind: 'episode', key: 'episode' },
];

function initialDraft(): DirectorWorkDraft {
  return {
    title: '', brief: '', sourceText: '', sourceFileName: '',
    preset: {
      mode: 'original', primary_genre: '', fusion_genre: '', audience: '',
      characters: '', era: '', highlights: '', visual_style: '', model_name: '', structure: 'three_act',
      narrative_tone: '', ending_type: 'closed', output_language: 'zh-CN', market: 'unspecified',
      fidelity: 'strict', locked_facts: '', allowed_additions: '',
      episode_count: 20, duration_seconds: 120, adapt_direction: null,
      source_episode_label: '', delivery_episode_label: '',
    },
  };
}

function draftFromWork(work: DirectorWork): DirectorWorkDraft {
  return {
    title: work.title,
    brief: work.brief,
    sourceText: work.source_text ?? '',
    sourceFileName: '',
    preset: { ...work.preset, model_name: work.preset.model_name ?? '' },
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function DirectorStudio({ project }: { project: string }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<DirectorWorkDraft>(initialDraft);
  const [modelContract, setModelContract] = useState<DirectorModelContract | null>(null);
  const selectedModelId = modelContract?.locked ? modelContract.model_name : draft.preset.model_name || modelContract?.model_name || '';
  const selectedModel = modelContract?.options?.find(option => option.id === selectedModelId || (option.id.startsWith('siliconflow::') && option.upstreamModel === selectedModelId));
  const [works, setWorks] = useState<DirectorWork[]>([]);
  const [detail, setDetail] = useState<DirectorWorkDetail | null>(null);
  const [document, setDocument] = useState<DirectorDocument | null>(null);
  const [selectedKind, setSelectedKind] = useState<DirectorDocumentKind>('outline');
  const [composer, setComposer] = useState(() => readDirectorPreference(`composer:${project}`, ''));
  const [presetOpen, setPresetOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [popoverAnchor, setPopoverAnchor] = useState<HTMLElement | null>(null);
  const [composerMenu, setComposerMenu] = useState<'attachment' | 'model' | 'manual' | 'reference' | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [notificationDismissed, setNotificationDismissed] = useState(() => readDirectorPreference('notificationDismissed', false));
  const [scriptModesOpen, setScriptModesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [methodsOpen, setMethodsOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [planningDraftOpen, setPlanningDraftOpen] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const [mediaKind, setMediaKind] = useState<DirectorMediaKind | null>(null);
  const [mediaAnchor, setMediaAnchor] = useState<HTMLElement | null>(null);
  const editorFlush = useRef<(() => Promise<boolean>) | null>(null);
  const [proposalPreview, setProposalPreview] = useState(false);
  const [editorText, setEditorText] = useState('');
  const [reviewText, setReviewText] = useState('');
  const [reviewBaseVersion, setReviewBaseVersion] = useState(0);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [preview, setPreview] = useState<ExecutionQuote | null>(null);
  const patchDecisionIntent = useRef<ReturnType<typeof outlineDecisionCommand> | null>(null);
  const [retainedResult, setRetainedResult] = useState<RetainedResult | null>(null);
  const [capability, setCapability] = useState<ExecutionCapability | null>(null);
  const [executions, setExecutions] = useState<ExecutionRun[]>([]);
  const observedExecutions = useRef(new Map<string, boolean>());
  useEffect(() => {
    let changed = false;
    for (const item of executions) {
      if (observedExecutions.current.get(item.id) === true && !isExecutionActive(item)) changed = true;
      observedExecutions.current.set(item.id, isExecutionActive(item));
    }
    if (changed) notifyDirectorTask(t('director.surface.taskUpdate'));
  }, [executions, t]);
  const [planningPhase, setPlanningPhase] = useState<PlanningState['phase'] | null>(null);
  const [initialQuoteWorkId, setInitialQuoteWorkId] = useState<string | null>(null);
  const [sourceBoundOutline, setSourceBoundOutline] = useState(false);
  const planningQuoteAction = useRef<(() => void) | null>(null);
  const approvalIntent = useRef<ExecutionCommand | null>(null);
  const visibleWork = useRef<string | null>(null);
  const [modelCostAcknowledged, setModelCostAcknowledged] = useState(false);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [qualityReport, setQualityReport] = useState<DirectorQualityReport | null>(null);
  const [outlineReport, setOutlineReport] = useState<OutlineQualityReport | null>(null);
  const [docked, setDocked] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [revisionImpact, setRevisionImpact] = useState<RevisionImpact | null>(null);
  const [selectedEpisode, setSelectedEpisode] = useState<number | null>(null);
  const [episodes, setEpisodes] = useState<CanonicalDocumentProjection['episodes']>([]);
  useEffect(() => { saveDirectorPreference(`composer:${project}`, composer); }, [project, composer]);

  const work = detail?.work ?? null;
  const planningMain = Boolean(work && ['original', 'adaptation'].includes(work.mode) && planningPhase !== 'READY' &&
    (planningPhase !== 'NOT_STARTED' || !detail?.documents.length));
  useEffect(() => { visibleWork.current = work?.id ?? null; }, [work?.id]);
  const hasActiveExecution = executions.some(isExecutionActive);
  const stream = useExecutionStream(project, work?.id, hasActiveExecution);
  const stoppable = executions.find(item => item.canCancel && (item.purpose ? item.purpose !== 'planning' : !item.parameters.stage));
  const ordinal = selectedEpisode ?? work?.current_episode ?? 1;
  const episodeReadOnly = Boolean(selectedKind === 'episode' && work &&
    (ordinal !== work.current_episode || ordinal > work.preset.episode_count));
  const documentReadOnly = work?.status === 'completed' || episodeReadOnly;
  const docKey = directorDocumentKey(selectedKind, ordinal);
  useEffect(() => { setOutlineReport(null); }, [work?.id, work?.revision, docKey, document?.version]);
  const pending = detail?.changes.find((change) => change.doc_key === docKey && change.status === 'pending') ?? null;
  const settingsFrozen = Boolean(work && (work.status !== 'created' || detail?.documents.length || detail?.changes.length || detail?.runs.some((item) => item.status !== 'failed')));
  const savedWorkKey = `director:last-work:${project}`;

  const refreshList = useCallback(async () => {
    const next = await listDirectorWorks(project);
    setWorks(next);
    return next;
  }, [project]);

  const openWork = useCallback(async (workId: string) => {
    if (editorFlush.current && !await editorFlush.current()) return;
    setInitialQuoteWorkId(null);
    const reopeningCurrent = visibleWork.current === workId;
    visibleWork.current = workId;
    setPreview(null);
    setRetainedResult(null);
    setFinalizeOpen(false);
    setQualityReport(null);
    setOutlineReport(null);
    setRevisionImpact(null);
    setSelectedEpisode(null);
    setEditorOpen(false);
    setMediaKind(null); setMediaAnchor(null);
    setReviewOpen(false);
    approvalIntent.current = null;
    // Reopening the same history item does not change the effect dependencies.
    // Keep its loaded state rather than clearing it with no subsequent fetch.
    if (!reopeningCurrent) {
      setExecutions([]);
      setPlanningPhase(null);
      setDocument(null);
    }
    const next = await getDirectorWork(project, workId);
    if (visibleWork.current !== workId) return;
    setDetail(next);
    setDraft(draftFromWork(next.work));
    setSelectedKind('outline');
    setHistoryOpen(false);
    setPanelOpen(true);
    window.localStorage.setItem(savedWorkKey, workId);
  }, [project, savedWorkKey]);

  const refreshDetail = useCallback(async (workId: string) => {
    const next = await getDirectorWork(project, workId);
    if (visibleWork.current === workId) setDetail(current => current?.work.id === workId && current.work.revision > next.work.revision ? current : next);
    return next;
  }, [project]);

  useEffect(() => { setSelectedEpisode(null); }, [work?.id, work?.current_episode]);
  useEffect(() => {
    setEpisodes([]);
    if (!work) return;
    let active = true;
    void getCanonicalDocuments(project, work.id).then((projection) => {
      if (active) setEpisodes(projection.episodes);
    }).catch((reason) => { if (active) setError(describeError(reason)); });
    return () => { active = false; };
  }, [project, work?.id, work?.revision]);

  useEffect(() => {
    let active = true;
    let request = 0;
    const refresh = () => {
      const current = ++request;
      void getExecutionCapability(project).then((value) => {
        if (active && current === request) setCapability(value);
      }).catch((reason) => { if (active && current === request) setError(describeError(reason)); });
    };
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('media-model-catalog-updated', refresh);
    return () => { active = false; window.removeEventListener('focus', refresh); window.removeEventListener('media-model-catalog-updated', refresh); };
  }, [project]);

  useEffect(() => {
    if (!work) { setExecutions([]); return; }
    const workId = work.id;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous = '';
    const poll = async () => {
      try {
        const next = await listExecutionRuns(project, workId);
        if (!active || visibleWork.current !== workId) return;
        setExecutions(next);
        const signature = next.map((item) => `${item.id}:${item.revision}`).join('|');
        if (signature !== previous) {
          previous = signature;
          await refreshDetail(workId);
          const current = await getDirectorDocument(project, workId, docKey);
          if (active && visibleWork.current === workId) setDocument(previous => previous?.doc_key === current.doc_key && previous.version > current.version ? previous : current);
        }
      } catch (reason) {
        if (active) setError(describeError(reason));
      } finally {
        if (active) timer = setTimeout(() => void poll(), 2500);
      }
    };
    void poll();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [project, work?.id, docKey, refreshDetail]);

  useEffect(() => {
    let active = true;
    let request = 0;
    const refresh = () => {
      const currentRequest = ++request;
      void getDirectorModelContract(project).then((contract) => {
        if (!active || currentRequest !== request) return;
        setModelContract(contract);
        setDraft((current) => current.preset.model_name ? current : {
          ...current, preset: { ...current.preset, model_name: contract.model_name },
        });
      }).catch((reason) => { if (active && currentRequest === request) setError(describeError(reason)); });
    };
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('media-model-catalog-updated', refresh);
    return () => { active = false; window.removeEventListener('focus', refresh); window.removeEventListener('media-model-catalog-updated', refresh); };
  }, [project]);

  useEffect(() => {
    let active = true;
    void listDirectorWorks(project).then((next) => {
      if (!active) return;
      setWorks(next);
      const remembered = window.localStorage.getItem(savedWorkKey);
      const chosen = next.find((item) => item.id === remembered) ?? next[0];
      if (chosen) void getDirectorWork(project, chosen.id).then((value) => {
        if (active) { setDetail(value); setDraft(draftFromWork(value.work)); }
      });
    }).catch((reason) => { if (active) setError(describeError(reason)); });
    return () => { active = false; };
  }, [project, savedWorkKey]);

  useEffect(() => {
    if (!work) { setDocument(null); return; }
    // Keep a mounted editor's pinned draft while polling fetches a newer version.
    setDocument(current => current?.doc_key === docKey ? current : null);
    let active = true;
    void getDirectorDocument(project, work.id, docKey).then((value) => {
      if (active) setDocument(previous => previous?.doc_key === value.doc_key && previous.version > value.version ? previous : value);
    }).catch((reason) => { if (active) setError(describeError(reason)); });
    return () => { active = false; };
  }, [project, work?.id, work?.revision, docKey]);

  const run = async (label: string, operation: () => Promise<void>) => {
    setBusy(label);
    setError('');
    try { await operation(); }
    catch (reason) {
      const body = reason instanceof ApiError ? reason.body as { detail?: { code?: string } } | undefined : undefined;
      const code = body?.detail?.code;
      setError(code ? t(`director.execution.errors.${code}`, { defaultValue: code })
        : reason instanceof ApiError && reason.status === 502 ? t('director.gatewayFailure') : describeError(reason));
    }
    finally { setBusy(''); }
  };

  const createWork = async () => {
    if (!modelContract) { setError(t('director.modelUnavailable')); return; }
    const brief = composer.trim() || draft.brief.trim();
    if (!brief && !draft.sourceText.trim()) {
      setError(t('director.briefRequired'));
      return;
    }
    if (draft.preset.mode === 'adaptation' && !draft.sourceText.trim()) {
      setError(t('director.sourceRequired'));
      return;
    }
    await run('create', async () => {
      const created = await createDirectorWork(project, {
        title: draft.title.trim() || t('director.untitled'),
        brief, source_text: draft.sourceText,
        preset: { ...draft.preset, model_name: modelContract.locked ? modelContract.model_name : draft.preset.model_name },
      });
      await refreshList();
      await openWork(created.id);
      // The first Send is the user's request to start the conversation. Quote
      // this work once after its workflow state loads, without granting cost.
      if (visibleWork.current === created.id) setInitialQuoteWorkId(created.id);
      setComposer('');
    });
  };

  const savePreset = async (confirmed: DirectorWorkDraft) => {
    if (!work) { setDraft(confirmed); setPresetOpen(false); return; }
    await run('settings', async () => {
      if (settingsFrozen) {
        const impact = await previewSettingsRevision(project, work, {
          title: confirmed.title.trim() || work.title, brief: confirmed.brief.trim(),
          preset: { ...confirmed.preset, model_name: modelContract?.locked ? modelContract.model_name : confirmed.preset.model_name },
        });
        if (visibleWork.current !== work.id) return;
        if (impact.changedFields.length === 1 && impact.changedFields[0].field === 'model_name' && impact.restartEpisode == null) {
          const id = crypto.randomUUID();
          await commitDirectorRevision(project, {
            schemaVersion: 2, commandId: id, clientRequestId: id, workId: work.id,
            previewId: impact.previewId, previewHash: impact.previewHash, archiveEpisodeIds: [],
            reason: 'User explicitly selected the model for subsequent executions.',
          });
          const updated = await refreshDetail(work.id);
          setDraft(draftFromWork(updated.work));
          setPreview(null); approvalIntent.current = null;
          await refreshList();
          setPresetOpen(false);
          return;
        }
        setPresetOpen(false);
        setRevisionImpact(impact);
        return;
      }
      await updateDirectorWork(project, work.id, {
        title: confirmed.title.trim() || work.title,
        brief: confirmed.brief.trim(),
        source_text: confirmed.sourceText,
        preset: { ...confirmed.preset, model_name: modelContract?.locked ? modelContract.model_name : confirmed.preset.model_name },
        expected_revision: work.revision,
      });
      const updated = await refreshDetail(work.id);
      setDraft(draftFromWork(updated.work));
      setPreview(null); approvalIntent.current = null;
      await refreshList();
      setPresetOpen(false);
    });
  };

  const reopenEpisode = async () => {
    if (!work || !document?.version || hasActiveExecution || ordinal > work.preset.episode_count) return;
    await run('reopen', async () => {
      const impact = await previewEpisodeReopen(project, work, ordinal);
      if (visibleWork.current === work.id) setRevisionImpact(impact);
    });
  };

  const commitRevision = async (command: CommitRevision) => {
    await run('revision', async () => {
      await commitDirectorRevision(project, command);
      if (visibleWork.current !== command.workId) return;
      const next = await refreshDetail(command.workId);
      if (visibleWork.current !== command.workId) return;
      setDraft(draftFromWork(next.work));
      setSelectedEpisode(null);
      setQualityReport(null); setFinalizeOpen(false); setPreview(null);
      approvalIntent.current = null;
      setRevisionImpact(null);
      await refreshList();
    });
  };

  const startGeneration = async (purpose: 'draft' | 'review' = 'draft', reviewTarget?: { changeId: string; changeRevision: number; acceptGroupIds: string[] }) => {
    if (!work || !document || document.doc_key !== docKey || !capability || hasActiveExecution || documentReadOnly || editorDirty) return;
    const instruction = purpose === 'review' ? '' : composer.trim();
    await run('preview', async () => {
      const result = await sendExecutionCommand<ExecutionQuote>(project,
        executionCommand(work.id, work.revision, docKey, document.version, capability.version, {
          type: 'cost.quote', kind: selectedKind,
          ...(selectedKind === 'episode' ? { episodeOrdinal: ordinal } : {}),
          instruction, purpose, ...(reviewTarget ? { reviewTarget } : {}),
        }));
      if (visibleWork.current !== work.id) return;
      setPreview(result);
      approvalIntent.current = executionCommand(work.id, work.revision, docKey, document.version, capability.version, {
        type: 'approval.grant', quoteId: result.quoteId, requestHash: result.requestHash, unknownCostConsent: true,
      });
      setModelCostAcknowledged(false);
    });
  };

  const confirmGeneration = async () => {
    if (!work || !preview || !modelCostAcknowledged || !approvalIntent.current) return;
    const command = approvalIntent.current;
    await run('generate', async () => {
      try {
        const accepted = await sendExecutionCommand<ExecutionRun>(project, command);
        if (visibleWork.current === work.id) {
          setExecutions((current) => [accepted, ...current.filter((item) => item.id !== accepted.id)]);
          setPreview(null);
          approvalIntent.current = null;
          if (preview.parameters.purpose !== 'review') setComposer('');
        }
      } finally {
        await refreshDetail(work.id);
      }
    });
  };

  const controlExecution = async (item: ExecutionRun, type: 'run.cancel' | 'run.resume') => {
    if (!work || !document || !capability) return;
    await run(type, async () => {
      const updated = await sendExecutionCommand<ExecutionRun>(project,
        executionCommand(work.id, work.revision, docKey, document.version, capability.version, { type, runId: item.id }));
      if (visibleWork.current === work.id) setExecutions((current) => current.map((value) => value.id === updated.id ? updated : value));
    });
  };

  const viewExecutionResult = async (item: ExecutionRun) => {
    await run('result', async () => {
      const result = await getRetainedResult(project, item.workId, item.id);
      if (visibleWork.current === item.workId) setRetainedResult(result);
    });
  };

  const decide = async (change: DirectorChange, accept: boolean) => {
    if (!work) return;
    await run('review', async () => {
      const result = await decideDirectorChange(project, work.id, change.id, accept);
      if (result.document && change.doc_key === docKey) setDocument(result.document);
      await refreshDetail(work.id);
      setEditorOpen(false);
      setProposalPreview(false);
    });
  };

  const decidePatch = async (groupIds: string[], accept: boolean, reportId: string | null = null) => {
    if (!work || !document?.document_id || !pending?.outlinePatch) return;
    if (patchDecisionIntent.current && patchDecisionIntent.current.workId !== work.id) patchDecisionIntent.current = null;
    patchDecisionIntent.current ??= outlineDecisionCommand(work, document, pending, groupIds, accept ? 'accept' : 'reject', reportId);
    await run('review', async () => {
      try {
        await decideOutlineGroups(project, patchDecisionIntent.current!);
        patchDecisionIntent.current = null;
        const fresh = await refreshDetail(work.id);
        if (visibleWork.current !== work.id) return;
        setDocument(await getDirectorDocument(project, work.id, docKey));
        if (!fresh?.changes.some(c => c.id === pending.id && c.status === 'pending')) { setProposalPreview(false); setEditorOpen(false); }
      } catch (reason) {
        if (reason instanceof ApiError && reason.status >= 400 && reason.status < 500) patchDecisionIntent.current = null;
        throw reason;
      }
    });
  };

  const saveEditor = async (text: string, baseVersion: number) => {
    if (!work || !document || pending || proposalPreview || documentReadOnly) return;
    await run('save', async () => {
      const saved = await putDirectorDocument(project, work.id, docKey, text, baseVersion);
      setDocument(saved);
      await refreshDetail(work.id);
      setEditorOpen(false);
    });
  };

  const proposeEditorChange = async () => {
    if (!work || !document || pending || proposalPreview || documentReadOnly) return;
    await run('propose', async () => {
      await proposeDirectorChange(project, work.id, docKey, reviewText, reviewBaseVersion, t('director.manualRevision'));
      await refreshDetail(work.id);
      setReviewOpen(false);
    });
  };

  const finalize = async (command: FinalizeDirectorCommand) => {
    if (!work || !document || selectedKind !== 'episode' ||
        !qualityReport?.ready_for_human_review || qualityReport.version !== document.version) return;
    await run('finalize', async () => {
      await finalizeDirectorV2(project, command);
      await refreshDetail(work.id);
      await refreshList();
      setFinalizeOpen(false);
      setQualityReport(null);
    });
  };

  const openFinalization = async () => {
    if (!work || !document) return;
    await run('quality', async () => {
      const report = await getDirectorQualityReport(project, work.id, ordinal);
      if (visibleWork.current !== work.id) return;
      setQualityReport(report);
      setFinalizeOpen(true);
    });
  };

  const openOutlineReview = async () => {
    if (!work || document?.doc_key !== 'outline' || !document.version) return;
    await run('outline-quality', async () => {
      const report = await getOutlineQualityReport(project, work.id);
      if (visibleWork.current !== work.id || report.documentVersion !== document.version) return;
      setOutlineReport(report);
    });
  };

  const title = work?.title ?? (draft.title || t('director.untitled'));
  const episodeLabel = work?.delivery_episode_label && ordinal === 1
    ? work.delivery_episode_label
    : t('director.episodeNumber', { number: ordinal });
  const currentLabel = useMemo(() => {
    if (selectedKind !== 'episode') return t(`director.section.${selectedKind}`);
    return episodeLabel;
  }, [episodeLabel, selectedKind, t]);
  const openEditor = () => { setProposalPreview(false); setEditorText(document?.content ?? ''); setEditorOpen(true); };
  const downloadDocument = () => {
    if (!document?.content) return;
    const url = URL.createObjectURL(new Blob([document.content], { type: 'text/markdown;charset=utf-8' }));
    const link = window.document.createElement('a');
    link.href = url; link.download = `${title.replace(/[\\/:*?"<>|]/g, '_')}-${docKey}.md`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const showMenu = (menu: typeof composerMenu, anchor: HTMLElement) => { setPopoverAnchor(anchor); setComposerMenu(composerMenu === menu ? null : menu); };
  const newConversation = async () => {
    if (editorFlush.current && !await editorFlush.current()) return false;
    if ((composer || (!work && (draft.title || draft.sourceText || draft.preset.primary_genre))) && !window.confirm(t('director.ui.discardDraft'))) return false;
    visibleWork.current = null;
    window.localStorage.removeItem(savedWorkKey); setDetail(null); setDocument(null);
    setDraft({ ...initialDraft(), preset: { ...initialDraft().preset, model_name: modelContract?.model_name ?? '' } }); setComposer('');
    setExecutions([]); setPreview(null); setPlanningPhase(null); setPanelOpen(true);
    setError(''); setSelectedKind('outline'); setSelectedEpisode(null); setEditorOpen(false); setMediaKind(null); return true;
  };
  const openMedia = async (kind: DirectorMediaKind) => {
    if (editorFlush.current && !await editorFlush.current()) return;
    setMediaAnchor(null); setMediaKind(kind); setPanelOpen(true);
  };
  const selectDocument = async (kind: DirectorDocumentKind, episode?: number) => {
    if (editorFlush.current && !await editorFlush.current()) return false;
    setSelectedKind(kind);
    if (episode !== undefined) setSelectedEpisode(episode);
    return true;
  };
  const attachSource = async (file?: File) => {
    if (!file) return;
    if (work) { setError(t('director.surface.sourceLocked')); return; }
    if (!/\.(md|txt)$/i.test(file.name)) { setError(t('director.surface.documentTypes')); return; }
    if (file.size > 1024 * 1024) { setError(t('director.sourceTooLarge')); return; }
    try { const text = await file.text(); if (text.includes('\0')) throw new Error(t('director.surface.documentTypes'));
      setDraft(value => ({ ...value, sourceFileName: file.name, sourceText: text, preset: { ...value.preset, mode: 'adaptation', adapt_direction: 'condense' } })); setComposerMenu(null);
    } catch (reason) { setError(describeError(reason)); }
  };

  return (
    <div className={`dc-studio${editorOpen || planningDraftOpen ? ' dc-editor-active' : ''}`}>
      <header className="dc-canvas-topbar">
        <span className="dc-brand"><Sparkles size={16} /> {t('director.title')}</span>
        <span className="dc-topbar-project">{title}</span>
        <button type="button" onClick={() => setPresetOpen(true)}>{t('director.presetTitle')}</button>
        <span className="dc-topbar-spacer" />
        <button type="button" onClick={(event) => { setPopoverAnchor(event.currentTarget); setHistoryOpen(true); }}><History size={16} /> {t('director.history')}</button>
      </header>

      <DirectorCanvas project={project} onCreate={() => { void newConversation().then(created => { if (created) setPresetOpen(true); }); }} onDirector={() => setPanelOpen(true)}>
        {work ? (
          <div className="dc-script-node">
            <div className="dc-node-toolbar" role="toolbar" aria-label={t('director.ui.nodeActions')}>
              <button type="button" aria-haspopup="menu" aria-expanded={Boolean(mediaAnchor)} onClick={event => setMediaAnchor(mediaAnchor ? null : event.currentTarget)}><NodeCharacter size={18} />{t('director.ui.characterImage')}<ChevronDown size={13} /></button>
              <button type="button" onClick={() => void openMedia(['characters', 'scenes', 'props'].includes(selectedKind) ? selectedKind as DirectorMediaKind : 'characters')}><Sparkles size={20} />{t('director.ui.creation')}</button>
              <i aria-hidden="true" />
              <button type="button" onClick={openEditor} aria-label={t('director.editor')}><Maximize2 size={18} /></button>
              <button type="button" disabled={!document?.content} onClick={downloadDocument} aria-label={t('director.ui.download')}><Download size={18} /></button>
            </div>
            <div className="dc-script-node-caption"><Caption size={16} /> {title}</div>
            <div className="dc-script-document">
              <div className="dc-script-document-title"><Sparkles size={22} /> {title}</div>
              <div className="dc-script-document-date">{new Date(work.created_at * 1000).toLocaleDateString()}</div>
              <div className="dc-script-body">
                <nav className="dc-document-rail" aria-label={t('director.sections')}>
                  {SECTIONS.map((section) => (
                    <button type="button" key={section.key} aria-current={selectedKind === section.kind ? 'page' : undefined}
                      onClick={() => setSelectedKind(section.kind)}>
                      {t(`director.section.${section.kind}`)}
                    </button>
                  ))}
                  {selectedKind === 'episode' && episodes.filter(item => !item.archived).map(episode => <button type="button" className="dc-episode-child" key={episode.id}
                    aria-current={ordinal === episode.orderKey ? 'page' : undefined} onClick={() => setSelectedEpisode(episode.orderKey)}>{episode.deliveryLabel}</button>)}
                </nav>
                <div className="dc-document-preview">
                  <h2>{currentLabel}</h2>
                  {selectedKind === 'outline' && <button type="button" disabled={Boolean(busy) || document?.doc_key !== 'outline' || !document?.version}
                    onClick={() => void openOutlineReview()}>{t('director.outlineReview.title')}</button>}
                  {selectedKind === 'episode' && episodes.length > 0 && <label className="dc-field-label">{t('director.revision.chooseEpisode')}
                    <select value={ordinal} onChange={(event) => { setSelectedEpisode(Number(event.target.value)); setQualityReport(null); setFinalizeOpen(false); }}>
                      {episodes.map((episode) => <option key={episode.id} value={episode.orderKey}>
                        {episode.deliveryLabel}{episode.archived ? ` · ${t('director.revision.archived')}` : ''}
                      </option>)}
                    </select>
                  </label>}
                  {selectedKind === 'episode' && documentReadOnly && !!document?.version && ordinal <= work.preset.episode_count &&
                    <button type="button" disabled={Boolean(busy) || hasActiveExecution} onClick={() => void reopenEpisode()}>{t('director.revision.reopen')}</button>}
                  <div className="dc-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: () => null, a: ({ children }) => <span>{children}</span> }}>{document?.content || t('director.emptyDocument')}</ReactMarkdown></div>
                </div>
              </div>
              <button type="button" className="dc-document-edit" onClick={openEditor}>
                <DirectorReferenceIcon name="Edit" size={16} /> {documentReadOnly ? t('director.view') : t('director.edit')}
              </button>
              <details className="dc-document-versions"><summary>{t('director.version', { number: document?.version ?? 0 })}</summary>
                <DocumentVersionPanel key={work.id} project={project} workId={work.id} revision={work.revision} docKey={docKey}
                  onImported={async () => { await refreshDetail(work.id); setDocument(await getDirectorDocument(project, work.id, docKey)); }} />
              </details>
            </div>
          </div>
        ) : (
          <div className="dc-empty-canvas"><ScrollText size={32} /><h1>{t('director.emptyCanvas')}</h1><p>{t('director.emptyCanvasHint')}</p>
            <button type="button" className="dc-primary-button" onClick={() => setPresetOpen(true)}>{t('director.start')}</button>
          </div>
        )}
        {work && <DirectorMediaNodes key={work.id} project={project} work={work.id} onPlan={kind => void openMedia(kind)} />}
      </DirectorCanvas>

      {panelOpen && (
        <DirectorWindow docked={docked} project={project}>
          <header className="dc-panel-header">
            <strong>{work ? title : t('director.newConversation')}</strong>
            <div className="dc-panel-actions">
              <button type="button" disabled={!work && !composer && !draft.title && !draft.preset.primary_genre} title={t('director.newConversation')} aria-label={t('director.newConversation')} onClick={newConversation}><MessageCirclePlus size={16} /></button>
              <button type="button" title={t('director.history')} aria-label={t('director.history')} onClick={(event) => { setPopoverAnchor(event.currentTarget); setHistoryOpen(true); }}><Clock3 size={16} /></button>
              <span title={t('director.ui.shareUnavailable')}><button type="button" disabled aria-label={t('director.ui.share')}><Share2 size={16} /></button></span>
              <button type="button" title={t('director.settings')} aria-label={t('director.settings')} onClick={() => setSettingsOpen(true)}><Settings2 size={16} /></button>
              <span title={t('director.ui.pluginUnavailable')}><button type="button" disabled aria-label={t('director.ui.plugins')}><Plug size={16} /></button></span>
              <button type="button" title={t(docked ? 'director.ui.undock' : 'director.dock')} aria-label={t(docked ? 'director.ui.undock' : 'director.dock')} aria-pressed={docked} onClick={() => setDocked(!docked)}><PanelRight size={16} /></button>
              <button type="button" title={t('director.close')} aria-label={t('director.close')} onClick={() => setPanelOpen(false)}><Minus size={16} /></button>
            </div>
          </header>
          <ConversationScroll key={work?.id ?? 'new'} revision={`${stream.state.cursor}:${executions.map(run => `${run.id}:${run.revision}`).join('|')}:${pending?.id ?? ''}`}>
            {!work && <div className="dc-welcome"><div className="dc-welcome-heading"><DirectorReferenceIcon name="Welcome" size={40} /><h2>{t('director.ui.startGenre')}</h2></div>
              <div className="dc-welcome-presets">{GENRES.map((genre, index) => <button type="button" key={genre} onClick={() => { const { name: _name, ...preset } = PRESET_DEFAULTS[index]; setDraft({ ...draft, preset: { ...draft.preset, ...preset } }); setPresetOpen(true); }}><span>#{index + 1}</span>{t(`director.genre.${index + 1}`)}</button>)}</div>
            </div>}
            {work && <>
              <div className="dc-message dc-message-user"><strong>{t('director.createdWork')}</strong><p>{work.brief}</p></div>
              <div className="dc-work-status">{t('director.status')} · {t(`director.workStatus.${work.status}`, { defaultValue: work.status })} · {t('director.episodeNumber', { number: work.current_episode })}</div>
              {['original', 'adaptation'].includes(work.mode) && <PlanningWorkflow key={work.id} project={project} work={work} capability={capability}
                hasDocuments={Boolean(detail?.documents.length)}
                onChanged={refreshDetail} onState={setPlanningPhase} quoteAction={planningQuoteAction}
                automatic autoQuote={initialQuoteWorkId === work.id} onAutoQuoteStarted={() => setInitialQuoteWorkId(null)}
                onPreviewState={setPlanningDraftOpen} onPipeline={setSourceBoundOutline} onConversation={() => setPanelOpen(value => !value)} />}
              {detail?.runs.filter((item) => !executions.some((execution) => execution.id === item.id)).map((item) => <div className="dc-message" key={item.id}><strong>{t('director.run')} · {item.action}</strong><p>{item.status === 'failed' ? item.error : t(`director.runStatus.${item.status}`)}</p></div>)}
              <DirectorConversation runs={executions} previews={stream.state.runs} busy={Boolean(busy)} onAction={(item, type) => void controlExecution(item, type)} onViewResult={(item) => void viewExecutionResult(item)}
                onRefine={async item => { if (!await selectDocument('episode', Number(item.docKey.slice(8)))) return; setComposer(t('director.stream.refinePrompt')); setPanelOpen(true); }} />
              {pending && <div className="dc-message dc-change-card"><strong>{t('director.reviewRequired')}</strong><p>{pending.reason}</p>{pending.outlinePatch ? <ul>{pending.outlinePatch.changeSummary.map((item, index) => <li key={index}>{item.text}</li>)}</ul> : <div className="dc-change-excerpt">{pending.content.slice(0, 240)}</div>}
                <div className="dc-card-actions"><button type="button" onClick={() => { setProposalPreview(true); setEditorText(pending.content); setEditorOpen(true); }}>{t('director.openDraft')}</button>{!pending.outlinePatch && <><button type="button" onClick={() => void decide(pending, false)}>{t('director.reject')}</button><button type="button" className="dc-primary-button" onClick={() => void decide(pending, true)}>{t('director.accept')}</button></>}</div>
              </div>}
              {selectedKind === 'episode' && document && document.version > 0 && !pending && !documentReadOnly && <button type="button" disabled={hasActiveExecution || editorDirty || Boolean(busy)} className="dc-finalize-entry" onClick={() => void openFinalization()}>{t('director.finalizeEpisode')}</button>}
            </>}
          </ConversationScroll>
          {stream.reconnecting && <p className="dc-stream-connection" role="status">{t('director.stream.reconnecting')}</p>}
          {error && !preview && <div className="dc-error" role="alert">{error}<button type="button" aria-label={t('director.close')} onClick={() => setError('')}><X size={14} /></button></div>}
          {!notificationDismissed && <div className="dc-notification-banner"><span><span>{t('director.surface.notificationBanner')}</span><button type="button" onClick={() => setSettingsOpen(true)}>{t('director.surface.enable')}</button></span><button type="button" aria-label={t('director.surface.dismissNotification')} onClick={() => { setNotificationDismissed(true); saveDirectorPreference('notificationDismissed', true); }}><X size={12} /></button></div>}
          <div className="dc-composer" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void attachSource(event.dataTransfer.files[0]); }}>
            <div className="dc-composer-chips"><button type="button" className="dc-preset-chip" onClick={() => setPresetOpen(true)}><ScrollText size={13} />{t('director.presetTitle')}</button>
              {work && <button type="button" className="dc-context-chip" onClick={openEditor}><FileText size={14} /><span>{title}</span></button>}
            </div>
            {draft.sourceFileName && !work && <div className="dc-source-chip"><FileText size={14} />{draft.sourceFileName}<button type="button" aria-label={t('director.surface.removeSource')} onClick={() => setDraft(value => ({ ...value, sourceFileName: '', sourceText: '' }))}><X size={12} /></button></div>}
            {!work && draft.preset.primary_genre && <button type="button" className="dc-preset-chip" onClick={() => setPresetOpen(true)}>{draft.preset.primary_genre} · {draft.preset.episode_count} {t('director.episodeUnit')}</button>}
            <textarea value={composer} onChange={(event) => { setComposer(event.target.value); if (event.target.value.endsWith('@')) { setPopoverAnchor(event.currentTarget); setComposerMenu('reference'); } }} placeholder={t('director.inputPlaceholder')} aria-label={t('director.inputPlaceholder')} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.closest('.dc-composer')?.querySelector<HTMLButtonElement>('.dc-send:not(:disabled)')?.click(); } }} />
            {work && <p className="dc-planning-hint">{t(planningMain ? 'director.planning.composerHint' : sourceBoundOutline ? 'director.planning.outlineReady' : 'director.planning.compatibilityHint')}</p>}
            <div className="dc-composer-footer">
              <input type="file" ref={fileInput} hidden accept=".md,.txt,text/plain,text/markdown" onChange={event => { void attachSource(event.target.files?.[0]); event.target.value = ''; }} />
              <button type="button" className="dc-icon-button" onClick={event => showMenu('attachment', event.currentTarget)} aria-label={t('director.surface.addAttachment')}><Plus size={18} /></button>
              <div className="dc-mode-wrap"><button type="button" onClick={() => { if (work) { setModeOpen(false); setPresetOpen(true); } else setModeOpen(!modeOpen); }} aria-expanded={!work && modeOpen}>{t('director.ui.scriptMode')} <ChevronDown size={13} /></button>
                {modeOpen && !work && <div className="dc-mode-menu" role="menu" onKeyDown={(event) => { if (event.key === 'Escape') setModeOpen(false); }}>
                  <button type="button" disabled title={t('director.ui.mediaUnavailable')}>{t('director.ui.creation')}</button>
                  <button type="button" onMouseEnter={() => setScriptModesOpen(true)} onClick={() => setScriptModesOpen(!scriptModesOpen)} aria-expanded={scriptModesOpen}>{t('director.ui.scriptMode')}<ChevronRight size={14} /></button>
                  <button type="button" disabled title={t('director.ui.mediaUnavailable')}>{t('director.ui.directing')}</button>
                  {scriptModesOpen && <div className="dc-mode-submenu">{(['original', 'adaptation'] as const).map((mode) => <button type="button" key={mode} aria-pressed={draft.preset.mode === mode} onClick={() => { setDraft({ ...draft, preset: { ...draft.preset, mode, adapt_direction: mode === 'adaptation' ? 'condense' : null } }); setModeOpen(false); setPresetOpen(true); }}>{t(`director.${mode}`)}</button>)}</div>}
                </div>}
              </div>
              <button type="button" className="dc-model-name" onClick={event => showMenu('model', event.currentTarget)} aria-label={t('director.surface.chooseModel')} aria-expanded={composerMenu === 'model'} title={selectedModel ? `${selectedModel.providerLabel} · ${selectedModel.upstreamModel}` : t('director.textModel')}>{selectedModel?.label || selectedModelId || t('director.modelUnavailable')}<ChevronDown size={12} /></button>
              <span className="dc-composer-spacer" />
              {work && <select aria-label={t('director.sections')} value={selectedKind} onChange={(event) => void selectDocument(event.target.value as DirectorDocumentKind)}>{SECTIONS.map((section) => <option value={section.kind} key={section.kind}>{t(`director.section.${section.kind}`)}</option>)}</select>}
              <button type="button" className="dc-icon-button dc-manual" onClick={event => showMenu('manual', event.currentTarget)} title={t('director.manualApprovalOnly')} aria-label={t('director.ui.manual')}><Hand size={18} /></button>
              {stoppable ? <button type="button" className="dc-send dc-stop" disabled={Boolean(busy)} aria-label={t('director.execution.stop')} onClick={() => void controlExecution(stoppable, 'run.cancel')}><span aria-hidden="true">■</span></button> : <button type="button" className="dc-send" disabled={editorDirty || Boolean(busy) || Boolean(pending) || hasActiveExecution || !capability || Boolean(work && (!document || document.doc_key !== docKey)) || documentReadOnly || (planningMain && !['NOT_STARTED', 'WAIT_COST', 'FAILED_RECOVERABLE', 'CANCELLED'].includes(planningPhase ?? ''))} aria-label={t('director.send')}
                onClick={() => { if (planningMain) planningQuoteAction.current?.(); else void (work ? startGeneration() : createWork()); }}>{busy ? '…' : <ArrowUp size={18} />}</button>}
            </div>
          </div>
          {mediaKind && work && <DirectorMediaPanel key={`${work.id}:${mediaKind}`} project={project} workId={work.id} kind={mediaKind} onKind={setMediaKind} onClose={() => setMediaKind(null)} />}
        </DirectorWindow>
      )}
      {mediaAnchor && <DirectorPopover anchor={mediaAnchor} label={t('director.ui.characterImage')} width={176} onClose={() => setMediaAnchor(null)}>
        <div className="dc-menu-rows" role="menu">{(['characters', 'scenes', 'props'] as const).map(kind => <button key={kind} type="button" role="menuitem" onClick={() => void openMedia(kind)}>{t(`director.media.${kind}`)}</button>)}</div>
      </DirectorPopover>}

      {presetOpen && <DirectorPresetDialog draft={draft} onClose={() => setPresetOpen(false)} onConfirm={(confirmed) => void savePreset(confirmed)} readOnly={hasActiveExecution || Boolean(busy)} sourceLocked={settingsFrozen} fixedModel={modelContract?.locked ? modelContract.model_name : undefined} modelOptions={modelContract?.options} />}

      {revisionImpact && <RevisionImpactDialog key={revisionImpact.previewId} impact={revisionImpact} busy={Boolean(busy)} error={error}
        onClose={() => setRevisionImpact(null)} onCommit={(command) => void commitRevision(command)} />}

      {historyOpen && <DirectorHistoryPopover project={project} works={works} anchor={popoverAnchor} onClose={() => setHistoryOpen(false)} onOpen={id => { if (!composer || window.confirm(t('director.ui.discardDraft'))) { setComposer(''); void openWork(id); } }} onChanged={async (id, archived) => {
        await refreshList(); if (work?.id === id) { if (archived) { visibleWork.current = null; setDetail(null); setDocument(null); setExecutions([]); setComposer(''); setDraft({ ...initialDraft(), preset: { ...initialDraft().preset, model_name: modelContract?.model_name ?? '' } }); setHistoryOpen(false); window.localStorage.removeItem(savedWorkKey); } else await refreshDetail(id); }
      }} />}
      {composerMenu && <DirectorPopover anchor={popoverAnchor} label={t(`director.surface.${composerMenu}`)} width={composerMenu === 'attachment' ? 153 : 300} onClose={() => setComposerMenu(null)}>
        {composerMenu === 'attachment' && <div className="dc-menu-rows dc-attachment-menu"><button type="button" title={t('director.surface.documentTypes')} onClick={() => fileInput.current?.click()}><Plus size={16} />{t('director.surface.localUpload')}</button><button type="button" onClick={() => setComposerMenu('reference')}><DirectorReferenceIcon name="Library" size={16} />{t('director.surface.fromLibrary')}</button></div>}
        {composerMenu === 'model' && <div className="dc-model-picker"><h3>{t('director.surface.chooseModel')}</h3>
          {modelContract?.options ? <>
            {!selectedModel && <button type="button" disabled><span>{selectedModelId}<small>{t('director.modelUnavailable')}</small></span></button>}
            {modelContract.options.map(option => <button type="button" key={option.id} aria-pressed={selectedModel?.id === option.id} disabled={hasActiveExecution || Boolean(busy) || Boolean(pending)} title={option.upstreamModel} onClick={() => { setComposerMenu(null); if (selectedModel?.id !== option.id) void savePreset({ ...draft, preset: { ...draft.preset, model_name: option.id } }); }}><span>{option.label}<small>{option.providerLabel}</small></span>{selectedModel?.id === option.id && <Check size={16} />}</button>)}
          </> : <><button type="button" aria-pressed="true" onClick={() => setComposerMenu(null)}><span>{selectedModelId}<small>{t(modelContract?.locked ? 'director.fixedModel' : 'director.modelAlias')}</small></span><Check size={16} /></button>{!modelContract?.locked && <button type="button" onClick={() => { setComposerMenu(null); setPresetOpen(true); }}>{t('director.ui.advanced')}</button>}</>}
        </div>}
        {composerMenu === 'manual' && <div className="dc-menu-rows"><button type="button" aria-pressed="true" onClick={() => setComposerMenu(null)}><Hand size={18} />{t('director.ui.manual')}<Check size={14} /></button><button type="button" disabled>{t('director.surface.autoGenerate')}</button><p>{t('director.manualApprovalOnly')}</p></div>}
        {composerMenu === 'reference' && <div className="dc-menu-rows"><h3>{t('director.surface.reference')}</h3>{document?.content ? <button type="button" onClick={() => { const value = `${composer.replace(/@$/, '')}\n${t('director.surface.referenceLabel', { label: currentLabel, version: document.version })}\n${document.content}`; if ([...value].length > 10000) { setError(t('director.surface.referenceTooLong')); return; } setComposer(value); setComposerMenu(null); }}><FileText size={16} />{currentLabel} · v{document.version}</button> : <p>{t('director.surface.noReference')}</p>}<small>{t('director.surface.referenceHint')}</small></div>}
      </DirectorPopover>}

      {editorOpen && !proposalPreview && work && document?.doc_key === docKey && <DirectorDocumentEditor key={`${work.id}:${docKey}`} project={project} work={work}
        initial={document} currentVersion={document.version} readOnly={documentReadOnly || Boolean(pending) || hasActiveExecution} busy={Boolean(busy)} error={error} label={currentLabel} companionOpen={panelOpen}
        onClose={() => setEditorOpen(false)} onSave={(text, version) => void saveEditor(text, version)}
        flushRef={editorFlush} onDirty={setEditorDirty} onAutosaved={(saved, revision) => {
          if (visibleWork.current !== work.id) return;
          setDocument(previous => previous?.doc_key === saved.doc_key && previous.version > saved.version ? previous : saved);
          setDetail(previous => !previous || previous.work.id !== work.id || previous.work.revision > revision ? previous : {
            ...previous, work: { ...previous.work, revision }, documents: [...previous.documents.filter(item => item.doc_key !== saved.doc_key), { doc_key: saved.doc_key, version: saved.version }],
          });
        }}
        onConversation={() => setPanelOpen(value => !value)}
        sections={SECTIONS.flatMap(section => [{ id: section.kind, label: t(`director.section.${section.kind}`), selected: selectedKind === section.kind && section.kind !== 'episode' }, ...(section.kind === 'episode' ? episodes.filter(item => !item.archived).map(episode => ({ id: `episode-${episode.orderKey}`, label: episode.deliveryLabel, selected: selectedKind === 'episode' && ordinal === episode.orderKey })) : [])])}
        onSection={id => { if (id.startsWith('episode-')) { setSelectedKind('episode'); setSelectedEpisode(Number(id.slice(8))); } else setSelectedKind(id as DirectorDocumentKind); }}
        onReference={(text, version) => { const value = `${composer}\n${t('director.surface.referenceLabel', { label: currentLabel, version })}\n> ${text.replace(/\n/g, '\n> ')}`; if ([...value].length > 10000) { setError(t('director.surface.referenceTooLong')); return; } setComposer(value); setPanelOpen(true); }}
        onPropose={(text, version) => { setReviewText(text); setReviewBaseVersion(version); setEditorOpen(false); setReviewOpen(true); }} />}

      {editorOpen && proposalPreview && <div className="dc-editor-overlay dc-screenplay-editor" role="dialog" aria-modal={!panelOpen} aria-label={t('director.editor')} onKeyDown={event => { if (event.key === 'Escape') setEditorOpen(false); }}>
        <header><strong>{title} · {currentLabel}{proposalPreview ? ` · ${t('director.reviewRequired')}` : ''}</strong><span>{t('director.version', { number: document?.version ?? 0 })}</span><button type="button" className="dc-editor-chat-toggle" aria-pressed={panelOpen} onClick={() => setPanelOpen(value => !value)}>{t('director.openPanel')}</button><button type="button" onClick={() => setEditorOpen(false)} aria-label={t('director.close')}><X size={20} /></button></header>
        {pending?.outlinePatch ? <OutlinePatchReview change={pending} busy={Boolean(busy) || hasActiveExecution} label={currentLabel}
          sections={SECTIONS.map(section => ({ id: section.kind, label: t(`director.section.${section.kind}`), selected: selectedKind === section.kind }))}
          onSection={id => { setProposalPreview(false); setSelectedKind(id as DirectorDocumentKind); }}
          onAccept={(groups, report) => void decidePatch(groups, true, report)} onReject={groups => void decidePatch(groups, false)}
          onReview={groups => void startGeneration('review', { changeId: pending.id, changeRevision: pending.outlinePatch!.revision, acceptGroupIds: groups })} />
          : <><DirectorRichText value={editorText} onChange={() => {}} readOnly label={currentLabel} screenplay={selectedKind === 'episode'} />
            <div className="dc-editor-safety"><div className="dc-editor-actions">{pending && <><button type="button" disabled={Boolean(busy)} onClick={() => void decide(pending, false)}>{t('director.reject')}</button><button type="button" className="dc-primary-button" disabled={Boolean(busy)} onClick={() => void decide(pending, true)}>{t('director.accept')}</button></>}</div></div></>}
      </div>}

      {reviewOpen && <div className="dc-overlay"><div className="dc-small-modal" role="dialog" aria-modal="true" aria-label={t('director.proposeRevision')}><h2>{t('director.proposeRevision')}</h2><p>{t('director.revisionHint')}</p><textarea value={reviewText} onChange={(event) => setReviewText(event.target.value)} /><footer><button type="button" onClick={() => setReviewOpen(false)}>{t('director.cancel')}</button><button type="button" className="dc-primary-button" onClick={() => void proposeEditorChange()}>{t('director.submitForReview')}</button></footer></div></div>}

      {retainedResult && <div className="dc-overlay">
        <div className="dc-small-modal" role="dialog" aria-modal="true" aria-label={t('director.execution.viewResult')}>
          <h2>{t('director.execution.viewResult')}</h2>
          <p>{t('director.execution.retainedHint')}</p>
          {retainedResult.factAudit && !retainedResult.factAudit.passed && <div role="alert"><strong>{t('director.factAudit.title')}</strong><p>{t('director.factAudit.hint')}</p><ul>{retainedResult.factAudit.issues.map((issue, index) => <li key={index}>{issue.entityId} · {issue.field ? t(`director.factAudit.fields.${issue.field}`, { defaultValue: issue.field }) : issue.code}{issue.value ? `：${issue.value}` : ''}</li>)}</ul></div>}
          <textarea readOnly aria-label={t('director.execution.retainedText')} value={retainedResult.output ?? ''} />
          <footer><button type="button" onClick={() => setRetainedResult(null)}>{t('director.close')}</button></footer>
        </div>
      </div>}

      {preview && <div className="dc-overlay">
        <div className="dc-small-modal" role="dialog" aria-modal="true" aria-label={t('director.parameterReview')}>
          <h2>{t('director.parameterReview')}</h2>
          <p>{t('director.parameterReviewHint')}</p>
          {error && <div className="dc-error" role="alert">{error}</div>}
          <RequestParameters parameters={preview.parameters} />
          <div className="dc-parameter-list">
            <div><span>{t('director.execution.outputBudget')}</span><strong>{t('director.execution.automaticBudget')}</strong></div>
            <div><span>{t('director.execution.attempts')}</span><strong>{preview.limits.maxAttempts}</strong></div>
            <div><span>{t('director.execution.expires')}</span><strong>{new Date(preview.expiresAt * 1000).toLocaleTimeString()}</strong></div>
            <div><span>{t('director.execution.requestHash')}</span><code>{preview.requestHash}</code></div>
          </div>
          <details><summary>{t('director.execution.requestDetails')}</summary><p>{t('director.execution.maxOutputTokens')} · {preview.limits.maxOutputTokens}</p></details>
          <p className="dc-cost-warning">{t('director.execution.boundedUnknownCost')}</p>
          <label className="dc-checkbox"><input type="checkbox" checked={modelCostAcknowledged} onChange={(event) => setModelCostAcknowledged(event.target.checked)} />{t('director.costAcknowledgement')}</label>
          <footer>
            <button type="button" disabled={Boolean(busy)} onClick={() => { setPreview(null); approvalIntent.current = null; }}>{t('director.cancel')}</button>
            <button type="button" className="dc-primary-button" disabled={!modelCostAcknowledged || Boolean(busy)} onClick={() => void confirmGeneration()}>{t(preview.parameters.purpose === 'review' ? 'director.review.confirm' : 'director.confirmGeneration')}</button>
          </footer>
        </div>
      </div>}

      {finalizeOpen && work && qualityReport && <QualityReviewDialog key={`${work.id}-${qualityReport.review?.id}-${qualityReport.version}`}
        work={work} ordinal={ordinal} report={qualityReport} busy={Boolean(busy)} error={error}
        onClose={() => setFinalizeOpen(false)} onConfirm={finalize}
        onReview={() => { setFinalizeOpen(false); void startGeneration('review'); }} />}
      {outlineReport && selectedKind === 'outline' && outlineReport.documentVersion === document?.version && <OutlineReviewDialog report={outlineReport}
        canRun={!busy && !hasActiveExecution && !documentReadOnly && !pending && !planningMain}
        onClose={() => setOutlineReport(null)} onReview={() => { setOutlineReport(null); void startGeneration('review'); }} />}

      {settingsOpen && <DirectorSettingsDialog onClose={() => setSettingsOpen(false)} onMethods={() => { setSettingsOpen(false); setMethodsOpen(true); }} />}

      {methodsOpen && <div className="dc-overlay"><div className="dc-small-modal" role="dialog" aria-modal="true" aria-label={t('director.methods')}><header><h2>{t('director.methods')}</h2><button type="button" onClick={() => setMethodsOpen(false)} aria-label={t('director.close')}><X size={18} /></button></header><p>{t('director.methodVersion', { version: capability?.methodVersion ?? '—' })}</p><p>{t('director.methodsHint')}</p><footer><button type="button" className="dc-primary-button" onClick={() => setMethodsOpen(false)}>{t('director.confirm')}</button></footer></div></div>}
    </div>
  );
}
