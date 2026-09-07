// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useEffect, useState, type KeyboardEvent } from 'react';
import { Clapperboard, FileText, Film } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { VideoNodeData } from '@/features/canvas/domain/canvasNodes';
import { STORY_CLIP_DETAILS_WIDTH_PERCENT } from '@/features/canvas/story/storyClipLayout';

type StoryClipMediaState = 'missing' | 'uploading' | 'generating' | 'ready' | 'failed';

interface StoryClipNarrativePanelProps {
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

  const showMediaState = mediaState === 'uploading' || mediaState === 'generating' || mediaState === 'failed';
  const mediaLabel = showMediaState ? t(`canvas.story.mediaState.${mediaState}`) : videoHint;

  return (
    <aside
      className="nodrag nopan absolute inset-y-0 right-0 z-20 flex flex-col overflow-hidden border-l border-white/[0.08] bg-[#242426]/95"
      style={{ width: `${STORY_CLIP_DETAILS_WIDTH_PERCENT}%` }}
      aria-label={t('canvas.story.segmentDetails')}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 px-3 py-3">
        <label className="flex min-h-0 flex-1 flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-text-muted">
            <FileText className="h-3.5 w-3.5" />
            {t('canvas.story.narrationLabel')}
          </span>
          <textarea
            value={narrationDraft}
            aria-label={t('canvas.story.narrationLabel')}
            placeholder={t('canvas.story.narrationPlaceholder')}
            className="nowheel min-h-[84px] flex-1 resize-none rounded-[10px] border border-transparent bg-white/[0.035] px-2.5 py-2 text-[12px] leading-5 text-text-dark outline-none transition-colors placeholder:text-text-muted/60 hover:bg-white/[0.055] focus:border-accent/45 focus:bg-white/[0.06]"
            onChange={(event) => setNarrationDraft(event.target.value)}
            onBlur={commitNarration}
            onKeyDown={blurOnCommitShortcut}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-text-muted">
            <Clapperboard className="h-3.5 w-3.5" />
            {t('canvas.story.productionNotesLabel')}
          </span>
          <textarea
            value={notesDraft}
            aria-label={t('canvas.story.productionNotesLabel')}
            placeholder={t('canvas.story.productionNotesPlaceholder')}
            rows={2}
            className="nowheel resize-none rounded-[10px] border border-transparent bg-white/[0.035] px-2.5 py-2 text-[11px] leading-4 text-text-dark outline-none transition-colors placeholder:text-text-muted/60 hover:bg-white/[0.055] focus:border-accent/45 focus:bg-white/[0.06]"
            onChange={(event) => setNotesDraft(event.target.value)}
            onBlur={commitNotes}
            onKeyDown={blurOnCommitShortcut}
          />
        </label>
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
