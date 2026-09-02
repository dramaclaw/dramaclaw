// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  type CameraMovementPreset,
  cameraMovementPresetLabel,
  resolveCameraPresetVideoUrl,
} from '@/features/canvas/domain/cameraMovementPresets';
import { NODE_FLOATING_PANEL_SURFACE_CLASS } from '@/features/canvas/ui/nodeControlStyles';

const CAMERA_MOVEMENT_PANEL_CLASS =
  `nodrag nowheel flex w-[640px] flex-col ${NODE_FLOATING_PANEL_SURFACE_CLASS}`;

interface CameraMovementPickerPopoverProps {
  templates: ReadonlyArray<CameraMovementPreset>;
  isLoading: boolean;
  selectedId: string | null;
  onConfirm: (id: string | null) => void;
  onClose: () => void;
}

export function CameraMovementPickerPopover({
  templates,
  isLoading,
  selectedId,
  onConfirm,
  onClose,
}: CameraMovementPickerPopoverProps) {
  const { t } = useTranslation();
  const [draftId, setDraftId] = useState<string | null>(selectedId);

  return (
    <div
      className={CAMERA_MOVEMENT_PANEL_CLASS}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex h-10 items-center justify-between px-4">
        <span className="text-sm font-medium text-text-dark">{t("canvas.cameraMovement.title")}</span>
        <button
          type="button"
          onClick={onClose}
          className="flex size-6 items-center justify-center rounded-md text-text-muted/90 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
          aria-label={t("common.close")}
        >
          <X className="size-3.5" />
        </button>
      </div>

      {templates.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-[12px] text-text-muted">
          {isLoading ? t('canvas.cameraMovement.loading') : t('canvas.cameraMovement.empty')}
        </div>
      ) : (
        <div className="ui-scrollbar grid max-h-[420px] grid-cols-4 gap-3 overflow-y-auto px-4 pb-4 pt-2">
          {templates.map((preset) => (
            <PresetCard
              key={preset.id}
              preset={preset}
              isSelected={draftId === preset.id}
              onSelect={() => setDraftId(preset.id)}
            />
          ))}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 px-4 pb-4 pt-1">
        <button
          type="button"
          onClick={() => onConfirm(null)}
          className="h-8 rounded-md px-3 text-[12px] font-medium text-text-dark/78 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
        >
          {t("canvas.cameraMovement.clear")}
        </button>
        <button
          type="button"
          onClick={() => onConfirm(draftId)}
          disabled={!draftId}
          className="h-8 min-w-[50px] rounded-md bg-primary px-3 text-[13px] text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-text-muted"
        >
          {t("canvas.cameraMovement.apply")}
        </button>
      </div>
    </div>
  );
}

interface PresetCardProps {
  preset: CameraMovementPreset;
  isSelected: boolean;
  onSelect: () => void;
}

function PresetCard({ preset, isSelected, onSelect }: PresetCardProps) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isHovering, setIsHovering] = useState(false);
  const videoSrc = resolveCameraPresetVideoUrl(preset);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (isHovering) {
      void el.play().catch(() => undefined);
    } else {
      el.pause();
      try {
        el.currentTime = 0;
      } catch {
        // ignored
      }
    }
  }, [isHovering]);

  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
      className={`group/card relative flex flex-col overflow-hidden rounded-[8px] border text-left transition-colors ${
        isSelected
          ? 'border-accent bg-[rgb(var(--accent-rgb)/0.14)] shadow-[0_0_0_1px_rgb(var(--accent-rgb)/0.45),0_0_18px_rgb(var(--accent-rgb)/0.18)]'
          : 'border-white/12 bg-white/[0.04] hover:border-white/20 hover:bg-white/[0.08]'
      }`}
    >
      {isSelected ? (
        <span className="pointer-events-none absolute right-2 top-2 z-10 h-2 w-2 rounded-full bg-accent shadow-[0_0_10px_rgb(var(--accent-rgb)/0.75)]" />
      ) : null}
      <div className="relative aspect-video w-full overflow-hidden bg-black/40">
        {videoSrc ? (
          <video
            ref={videoRef}
            src={videoSrc}
            muted
            loop
            playsInline
            preload="metadata"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[11px] text-text-muted">
            {t("canvas.cameraMovement.noPreview")}
          </div>
        )}
      </div>
      <div className={`flex h-7 items-center justify-center px-2 text-[12px] ${isSelected ? 'text-white' : 'text-text-dark'}`}>
        {cameraMovementPresetLabel(preset, t)}
      </div>
    </button>
  );
}
