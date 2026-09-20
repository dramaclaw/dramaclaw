// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Clapperboard, FileText, Film, Link2, MousePointerClick, Repeat2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { CANVAS_NODE_TYPES, type VideoNodeData } from '@/features/canvas/domain/canvasNodes';
import { STORY_CLIP_DETAILS_WIDTH_PERCENT } from '@/features/canvas/story/storyClipLayout';
import { STORY_CHOICE_EDGE_TYPE } from '@/features/canvas/story/storyTypes';
import {
  bindChoiceLoopPatch,
  choiceLoopVideoCandidates,
  clearChoiceLoopMediaPatch,
} from '@/features/canvas/story/choiceLoopBinding';
import { useCanvasStore } from '@/stores/canvasStore';
import { safeCtaUrl } from '@/features/canvas/story/storyEvents';
import styles from './StoryClipNarrativePanel.module.css';

type StoryClipMediaState = 'missing' | 'uploading' | 'generating' | 'ready' | 'failed';

const CTA_INPUT_CLASS = 'w-full min-w-0 rounded-xl border border-transparent bg-white/[0.035] px-2.5 py-2 text-xs leading-5 text-text-dark outline-none transition-colors placeholder:text-text-muted/60 hover:bg-white/[0.055] focus:border-accent/45 focus:bg-white/[0.06]';

interface StoryClipNarrativePanelProps {
  nodeId: string;
  narration?: string;
  productionNotes?: string;
  videoHint?: string;
  importNeedsReview?: boolean;
  importReviewNote?: string;
  mediaState: StoryClipMediaState;
  onChange: (patch: Partial<VideoNodeData>) => void;
}

function blurOnCommitShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    event.currentTarget.blur();
  }
}

export const StoryClipNarrativePanel = memo(function StoryClipNarrativePanel({
  nodeId,
  narration = '',
  productionNotes = '',
  videoHint,
  importNeedsReview,
  importReviewNote,
  mediaState,
  onChange,
}: StoryClipNarrativePanelProps) {
  const { t } = useTranslation();
  const [narrationDraft, setNarrationDraft] = useState(narration);
  const [notesDraft, setNotesDraft] = useState(productionNotes);
  const [loopPickerOpen, setLoopPickerOpen] = useState(false);
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const hasOutgoingChoices = useCanvasStore((state) =>
    state.edges.some((edge) => edge.type === STORY_CHOICE_EDGE_TYPE && edge.source === nodeId),
  );
  const nodeData = nodes.find((node) => node.id === nodeId)?.data as VideoNodeData | undefined;
  const continuityCandidates = useMemo(() => {
    if (nodeData?.storyRole === 'start') return [];
    const sourceIds = new Set(edges.filter((edge) => edge.target === nodeId && edge.source !== nodeId &&
      (edge.type === STORY_CHOICE_EDGE_TYPE || edge.data?.link_type === 'dependency_for'))
      .map((edge) => edge.source));
    return nodes.filter((node) => sourceIds.has(node.id) && node.type === CANVAS_NODE_TYPES.video);
  }, [nodes, edges, nodeId, nodeData?.storyRole]);
  const autoContinuity = nodeData?.storyRole !== 'start' && (nodeData?.continuityMode === 'auto' ||
    (nodeData?.continuityMode !== 'independent' && continuityCandidates.some((node) =>
      edges.some((edge) => edge.source === node.id && edge.target === nodeId && edge.data?.link_type === 'dependency_for'))));
  const continuitySource = continuityCandidates.find((node) => node.id === nodeData?.continuitySourceNodeId)
    ?? (continuityCandidates.length === 1 ? continuityCandidates[0] : undefined);
  const [ctaUrlDraft, setCtaUrlDraft] = useState(nodeData?.storyCta?.url ?? '');
  useEffect(() => setCtaUrlDraft(nodeData?.storyCta?.url ?? ''), [nodeData?.storyCta?.url, nodeId]);
  const loopCandidates = useMemo(
    () => choiceLoopVideoCandidates(nodes, nodeId),
    [nodes, nodeId],
  );
  const boundCandidateId = loopCandidates.find(
    (candidate) => candidate.url === nodeData?.choiceLoopVideoUrl,
  )?.nodeId ?? (nodeData?.choiceLoopVideoUrl ? '__external__' : '');

  useEffect(() => setNarrationDraft(narration), [narration]);
  useEffect(() => setNotesDraft(productionNotes), [productionNotes]);

  const commitNarration = () => {
    const next = narrationDraft.trim();
    if (next !== narration) onChange({ narration: next });
  };
  const commitNotes = () => {
    const next = notesDraft.trim();
    if (next !== productionNotes) onChange({ storyProductionNotes: next });
  };

  const handleCtaLabelChange = (label: string) => {
    // Keep the destination while editing; clearing the label removes the CTA.
    onChange({
      endingLabel: nodeData?.endingLabel || '体验结束',
      storyCta: label.trim() ? { label, url: nodeData?.storyCta?.url ?? '' } : undefined,
    });
  };
  const commitCtaUrl = () => {
    const cta = nodeData?.storyCta;
    const url = ctaUrlDraft.trim();
    if (!cta || (url && !safeCtaUrl(url))) return;
    onChange({ storyCta: { label: cta.label, url } });
  };

  const showMediaState = mediaState === 'uploading' || mediaState === 'generating' || mediaState === 'failed';
  const mediaLabel = showMediaState ? t(`canvas.story.mediaState.${mediaState}`) : videoHint;

  const handleLoopChange = (candidateId: string) => {
    if (candidateId === '__external__') return;
    if (!candidateId) {
      onChange(clearChoiceLoopMediaPatch(nodeData?.storyChoiceLoop));
      return;
    }
    const candidate = loopCandidates.find((item) => item.nodeId === candidateId);
    if (candidate) onChange(bindChoiceLoopPatch(nodeData?.storyChoiceLoop, candidate));
  };

  return (
    <aside
      className="nodrag nopan absolute inset-y-0 right-0 z-20 flex flex-col overflow-hidden border-l border-white/[0.08] bg-[#242426]/95"
      style={{ width: `${STORY_CLIP_DETAILS_WIDTH_PERCENT}%` }}
      aria-label={t('canvas.story.segmentDetails')}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="nowheel flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
        <label className="flex shrink-0 flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-text-muted">
            <FileText className="h-3.5 w-3.5" />
            {t('canvas.story.narrationLabel')}
          </span>
          <div className={styles.textareaFrame}>
          <textarea
            value={narrationDraft}
            rows={3}
            aria-label={t('canvas.story.narrationLabel')}
            placeholder={t('canvas.story.narrationPlaceholder')}
            className={`${styles.textarea} nowheel text-xs leading-5 text-text-dark placeholder:text-text-muted/60`}
            onChange={(event) => setNarrationDraft(event.target.value)}
            onBlur={commitNarration}
            onKeyDown={blurOnCommitShortcut}
          />
          </div>
        </label>

        <label className="flex shrink-0 flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-text-muted">
            <Clapperboard className="h-3.5 w-3.5" />
            {t('canvas.story.productionNotesLabel')}
          </span>
          <div className={styles.textareaFrame}>
          <textarea
            value={notesDraft}
            aria-label={t('canvas.story.productionNotesLabel')}
            placeholder={t('canvas.story.productionNotesPlaceholder')}
            rows={3}
            className={`${styles.textarea} nowheel text-xs leading-5 text-text-dark placeholder:text-text-muted/60`}
            onChange={(event) => setNotesDraft(event.target.value)}
            onBlur={commitNotes}
            onKeyDown={blurOnCommitShortcut}
          />
          </div>
        </label>

        <fieldset className="flex min-w-0 shrink-0 flex-col gap-1.5">
          <legend className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-text-muted">
            <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
            {t('canvas.story.continuity.label')}
          </legend>
          <div className="flex flex-wrap gap-1">
            <button type="button" className={styles.modeButton} aria-pressed={!autoContinuity}
              onClick={() => onChange({ continuityMode: 'independent', continuitySourceNodeId: '' })}>
              {t('canvas.story.continuity.independent')}
            </button>
            <button type="button" className={styles.modeButton} aria-pressed={autoContinuity}
              disabled={continuityCandidates.length === 0}
              onClick={() => onChange({ continuityMode: 'auto', continuitySourceNodeId: continuitySource?.id ?? '' })}>
              {t('canvas.story.continuity.auto')}
            </button>
          </div>
          {autoContinuity && continuityCandidates.length > 1 && (
            <label className="flex min-w-0 flex-col gap-1.5 text-xs text-text-dark/75">
              {t('canvas.story.continuity.source')}
              <select className={styles.sourceSelect} value={continuitySource?.id ?? ''}
                onChange={(event) => onChange({ continuitySourceNodeId: event.target.value })}>
                <option value="">{t('canvas.story.continuity.chooseSource')}</option>
                {continuityCandidates.map((node) => <option key={node.id} value={node.id}>
                  {String(node.data.displayName || t('canvas.story.continuity.untitled'))}
                </option>)}
              </select>
            </label>
          )}
          <span className="text-xs leading-5 text-text-dark/75">
            {continuityCandidates.length === 0
              ? t('canvas.story.continuity.noSource')
              : autoContinuity
                ? continuitySource
                  ? t('canvas.story.continuity.sourceHint', { name: continuitySource.data.displayName || t('canvas.story.continuity.untitled') })
                  : t('canvas.story.continuity.chooseSource')
                : t('canvas.story.continuity.independentHint')}
          </span>
        </fieldset>

        {!hasOutgoingChoices && <fieldset className="min-w-0 shrink-0 text-xs text-text-dark">
          <legend className="mb-3 flex items-center gap-1.5 text-xs font-medium text-text-muted">
            <MousePointerClick className="h-3.5 w-3.5" aria-hidden="true" />
            {t('canvas.story.ctaTitle', { defaultValue: '结尾转化按钮' })}
          </legend>
          <div className="flex flex-col gap-3">
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs text-text-dark/75">{t('canvas.story.ctaLabel', { defaultValue: '按钮文案' })}</span>
            <input className={CTA_INPUT_CLASS} value={nodeData?.storyCta?.label ?? ''}
              maxLength={120}
              onChange={(event) => handleCtaLabelChange(event.target.value)} />
          </label>
          {nodeData?.storyCta && <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs text-text-dark/75">{t('canvas.story.ctaUrl', { defaultValue: '访问地址（HTTPS）' })}</span>
            <input className={CTA_INPUT_CLASS} type="url" maxLength={4096} value={ctaUrlDraft}
              onChange={(event) => setCtaUrlDraft(event.target.value)}
              onBlur={commitCtaUrl} />
            {!safeCtaUrl(ctaUrlDraft) && <span role="status">{t('canvas.story.ctaInvalidUrl')}</span>}
          </label>}
          </div>
        </fieldset>}
        {hasOutgoingChoices && (
          <div className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-text-muted">
              <Repeat2 className="h-3.5 w-3.5" />
              {t('canvas.story.waitingBehavior')}
            </span>
            <div className="flex gap-1" role="group" aria-label={t('canvas.story.waitingBehavior')}>
              <button type="button" className="tap-button aria-pressed:text-accent" aria-pressed={!boundCandidateId && !loopPickerOpen}
                onClick={() => { handleLoopChange(''); setLoopPickerOpen(false); }}>{t('canvas.story.freezeFrame')}</button>
              <button type="button" className="tap-button aria-pressed:text-accent" aria-pressed={!!boundCandidateId || loopPickerOpen}
                onClick={() => setLoopPickerOpen(true)}>{t('canvas.story.loopVideo')}</button>
            </div>
            {(!!boundCandidateId || loopPickerOpen) && <>
            <select
              value={boundCandidateId}
              aria-label={t('canvas.story.choiceLoop.label')}
              className="h-8 min-w-0 rounded-[10px] border border-transparent bg-white/[0.035] px-2 text-[11px] text-text-dark outline-none transition-colors hover:bg-white/[0.055] focus:border-accent/45 focus:bg-white/[0.06]"
              onChange={(event) => handleLoopChange(event.target.value)}
            >
              <option value="">{t('canvas.story.choiceLoop.freezeTail')}</option>
              {boundCandidateId === '__external__' && (
                <option value="__external__" disabled>{t('canvas.story.choiceLoop.boundExternal')}</option>
              )}
              {loopCandidates.map((candidate) => (
                <option key={candidate.nodeId} value={candidate.nodeId}>
                  {candidate.label}{candidate.durationMs ? ` · ${(candidate.durationMs / 1000).toFixed(1)}s` : ''}
                </option>
              ))}
            </select>
            <span className="text-[10px] leading-4 text-text-muted/80">
              {loopCandidates.length > 0
                ? t('canvas.story.choiceLoop.hint')
                : t('canvas.story.choiceLoop.empty')}
            </span>
            </>}
          </div>
        )}
      </div>

      {(mediaLabel || importNeedsReview) && (
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-t border-white/[0.07] px-3 text-[11px] text-text-muted">
        {mediaLabel && <><Film className="h-3.5 w-3.5 shrink-0" /><span className="truncate" title={videoHint}>{mediaLabel}</span></>}
        {importNeedsReview ? (
          <span className="ml-auto shrink-0 text-amber-400" title={importReviewNote}>
            {t('canvas.story.reviewRequired')}
          </span>
        ) : null}
      </div>
      )}
    </aside>
  );
});
