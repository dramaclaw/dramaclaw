// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, Maximize2, X } from 'lucide-react';

import type { FreezoneStyleTemplate } from '@/api/ops';
import { resolveStyleAssetUrl } from '@/features/canvas/nodes/styleAssetUrl';

const STYLE_GALLERY_MODAL_CLASS =
  'relative flex h-[min(720px,82vh)] w-[min(1120px,92vw)] flex-col overflow-hidden rounded-[10px] border border-white/[0.12] bg-[#15161b]/96 shadow-[0_18px_48px_rgba(0,0,0,0.45)] backdrop-blur-md';

export interface StyleGalleryModalProps {
  templates: FreezoneStyleTemplate[];
  assetBase: string;
  selectedId: string | null;
  /** 只回调,不自己关闭;关闭由调用方决定。 */
  onSelect: (id: string | null) => void;
  onClose: () => void;
}

export function StyleGalleryModal({
  templates,
  assetBase,
  selectedId,
  onSelect,
  onClose,
}: StyleGalleryModalProps) {
  const [detailId, setDetailId] = useState<string | null>(null);
  const detail = detailId
    ? templates.find((item) => item.id === detailId) ?? null
    : null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (detailId) setDetailId(null);
      else onClose();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [detailId, onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/55"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={STYLE_GALLERY_MODAL_CLASS}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/[0.08] px-4">
          <div className="flex items-center gap-2">
            {detail && (
              <button
                type="button"
                onClick={() => setDetailId(null)}
                aria-label="返回"
                className="flex size-7 items-center justify-center rounded-md text-text-muted/90 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
              >
                <ArrowLeft className="size-4" />
              </button>
            )}
            <span className="text-sm font-medium text-text-dark">
              {detail ? detail.label : '风格'}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {!detail && selectedId && (
              <button
                type="button"
                onClick={() => onSelect(null)}
                className="h-7 rounded-md px-2 text-[11px] font-medium text-text-dark/78 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
              >
                清除风格
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="flex size-7 items-center justify-center rounded-md text-text-muted/90 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {detail ? (
          <div className="flex flex-1 gap-4 overflow-hidden p-4">
            <div className="ui-scrollbar grid flex-1 grid-cols-2 content-start gap-2 overflow-y-auto">
              {detail.samples.map((sample, index) => (
                <img
                  key={sample}
                  src={resolveStyleAssetUrl(sample, assetBase)}
                  alt={`${detail.label} 示例 ${index + 1}`}
                  loading="lazy"
                  className="w-full rounded-[8px] border border-white/[0.08] object-cover"
                />
              ))}
            </div>
            <div className="flex w-[320px] shrink-0 flex-col gap-3">
              <p className="ui-scrollbar flex-1 overflow-y-auto whitespace-pre-line rounded-[8px] border border-white/[0.08] bg-white/[0.03] p-3 text-xs leading-relaxed text-text-dark/80">
                {detail.style_prompt}
              </p>
              <button
                type="button"
                onClick={() => onSelect(detail.id)}
                className="h-9 shrink-0 rounded-md bg-white/[0.92] text-sm font-medium text-black transition-colors hover:bg-white"
              >
                使用
              </button>
            </div>
          </div>
        ) : (
          <div className="ui-scrollbar flex-1 overflow-y-auto p-4">
            <div className="grid grid-cols-4 gap-3">
              {templates.map((item) => {
                const isActive = item.id === selectedId;
                return (
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    aria-label={item.label}
                    onClick={() => onSelect(item.id)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      onSelect(item.id);
                    }}
                    className={`group relative cursor-pointer overflow-hidden rounded-[12px] border bg-white/[0.04] transition-colors ${
                      isActive
                        ? 'border-white/[0.30] ring-1 ring-white/24'
                        : 'border-white/[0.10] hover:border-white/[0.18] hover:bg-white/[0.06]'
                    }`}
                  >
                    <img
                      src={resolveStyleAssetUrl(item.cover, assetBase)}
                      alt={item.label}
                      loading="lazy"
                      className="aspect-video w-full object-cover"
                    />
                    <div className="px-2.5 py-2 text-xs font-medium text-text-dark/86">
                      {item.label}
                    </div>
                    {isActive && (
                      <Check className="absolute right-2 top-2 size-4 text-[rgb(var(--accent-rgb))]" />
                    )}
                    <button
                      type="button"
                      aria-label={`查看${item.label}详情`}
                      onClick={(event) => {
                        event.stopPropagation();
                        setDetailId(item.id);
                      }}
                      className="absolute bottom-10 right-2 flex size-7 items-center justify-center rounded-md bg-black/55 text-text-dark opacity-0 transition-opacity hover:bg-black/75 group-hover:opacity-100"
                    >
                      <Maximize2 className="size-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function describeStyleSelection(
  selectedId: string | null,
  templates: FreezoneStyleTemplate[],
): FreezoneStyleTemplate | null {
  if (!selectedId) return null;
  return templates.find((item) => item.id === selectedId) ?? null;
}
