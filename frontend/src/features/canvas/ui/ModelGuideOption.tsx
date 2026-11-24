// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useId } from 'react';
import { Check, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ModelGuideData, ModelPickerGuide } from '@/lib/media-model-catalog-types';

export function ModelGuideOption({ label, data, selected, preview, disabledReason, onPreview, onSelect }: {
  label: string;
  data?: ModelGuideData;
  selected: boolean;
  preview: boolean;
  disabledReason?: string | null;
  onPreview: (open: boolean, anchor: HTMLElement) => void;
  onSelect: () => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const locale = (i18n?.resolvedLanguage || i18n?.language || 'en').split('-')[0] as keyof ModelPickerGuide;
  const guide = data?.pickerGuide?.[locale] ?? data?.pickerGuide?.en;
  const summary = disabledReason || guide?.summary;
  const detail = guide?.detail;
  const tags = disabledReason ? [] : [...new Set(guide?.tags)];
  const hasDetail = !!detail?.trim();
  const expanded = hasDetail && preview;
  return (
    <div className={`flex min-w-0 flex-col rounded-lg transition-colors hover:bg-text-dark/[0.065] ${expanded ? 'bg-text-dark/[0.065]' : ''}`}>
      <div className="flex items-center">
        <button type="button" aria-label={label} aria-pressed={selected}
          aria-disabled={disabledReason ? true : undefined}
          aria-describedby={[...tags.map((_, i) => id + '-tag-' + i), summary && id + '-summary', expanded && id + '-detail'].filter(Boolean).join(' ') || undefined}
          onMouseEnter={(event) => onPreview(hasDetail, event.currentTarget)}
          onFocus={(event) => onPreview(hasDetail, event.currentTarget)}
          onClick={(event) => { event.stopPropagation(); if (!disabledReason) onSelect(); }}
          className={`grid min-h-9 min-w-0 flex-1 grid-cols-[14px_minmax(0,1fr)] items-start gap-x-2 rounded-lg px-2.5 py-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${disabledReason ? 'cursor-not-allowed text-text-dark/45' : 'text-text-dark'}`}>
          <span aria-hidden="true" className="flex h-5 items-center">
            {selected && <Check className="size-3.5" strokeWidth={2.25} />}
          </span>
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 [overflow-wrap:anywhere]">
              <span className="text-sm font-medium leading-5">{label}</span>
              {tags.map((tag, i) => (
                <span key={tag} id={id + '-tag-' + i} className="max-w-full rounded bg-text-dark/[0.07] px-1.5 text-xs font-medium leading-4 text-text-dark/75">{tag}</span>
              ))}
            </span>
            {summary && <span id={id + '-summary'} className="mt-0.5 block text-xs font-normal leading-4 text-text-dark/65 [overflow-wrap:anywhere]">{summary}</span>}
          </span>
        </button>
        {hasDetail && <button type="button" aria-label={t('modelPicker.details', { model: label })}
          aria-expanded={expanded} aria-controls={expanded ? id + '-detail' : undefined}
          className="hidden size-11 shrink-0 items-center justify-center rounded-lg text-text-dark/65 [@media(hover:none)]:inline-flex [@media(any-pointer:coarse)]:inline-flex"
          onClick={(event) => { event.stopPropagation(); onPreview(!expanded, event.currentTarget); }}>
          <Info className="size-3.5" />
        </button>}
      </div>
      {expanded && <p id={id + '-detail'} className="ms-8 me-3 whitespace-pre-wrap border-t border-text-dark/10 py-2 text-xs leading-[1.5] text-text-dark/85 [overflow-wrap:anywhere]">{detail}</p>}
    </div>
  );
}
