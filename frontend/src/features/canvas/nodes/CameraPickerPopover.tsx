// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from 'react';
import { Aperture, Camera, ChevronDown, Focus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ImageGenCameraSelection } from '@/features/canvas/domain/canvasNodes';
import { useFreezoneCameraOptions } from '@/features/canvas/hooks/useFreezoneCameraOptions';
import { NODE_FLOATING_PANEL_SURFACE_CLASS } from '@/features/canvas/ui/nodeControlStyles';

// Wheel geometry keeps the chosen item centered in a compact viewport.
const ITEM_HEIGHT = 88;
const VIEWPORT_HEIGHT = 118;
const HIGHLIGHT_TOP = 15;
const COLUMN_WIDTH = 136;
export const CAMERA_PICKER_POPOVER_WIDTH = COLUMN_WIDTH * 4 + 108;
const CAMERA_PICKER_PANEL_CLASS =
  `nodrag nowheel flex flex-col ${NODE_FLOATING_PANEL_SURFACE_CLASS}`;
const CAMERA_PICKER_LABEL_CLASS = 'text-[11px] font-medium text-text-dark/72';
const CAMERA_PICKER_ARROW_CLASS =
  'flex h-7 w-full items-center justify-center text-text-dark/72 transition-colors hover:text-text-dark disabled:cursor-not-allowed disabled:opacity-100';

interface CameraPickerPopoverProps {
  selection: ImageGenCameraSelection | null;
  onConfirm: (selection: ImageGenCameraSelection | null) => void;
  onClose: () => void;
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Backend ids that share artwork with a sibling slug we already have on disk.
// Whenever the backend ships a variant (e.g. Sony Venice 2) without its own
// asset, point it at the base family's PNG. Keep this list explicit — slug
// heuristics produce surprising matches.
const CAMERA_IMAGE_BY_ID: Record<string, string> = {
  red_vraptor_xl: 'red-v-raptor',
  sony_venice_2: 'sony-venice',
};

const LENS_IMAGE_BY_ID: Record<string, string> = {
  cooke_s4i: 'cooke-s4',
  zeiss_supreme_prime: 'zeiss-ultra-prime',
  panavision_primo_70: 'panavision-primo',
};

// Aperture entries come from the backend as labels like "f/2". We only have
// `f-1-4 / f-4 / f-11` images; everything else falls back to `f-4`.
const APERTURE_IMAGE_BY_LABEL: Record<string, string> = {
  'f/2': 'f-4',
  'f/2.8': 'f-4',
  'f/5.6': 'f-4',
  'f/8': 'f-4',
};

function cameraImageFor(id: string, label: string): string {
  const aliased = CAMERA_IMAGE_BY_ID[id];
  if (aliased) return `/images/camera/${aliased}.png`;
  return `/images/camera/${slugify(id || label)}.png`;
}

function lensImageFor(id: string, label: string): string {
  const aliased = LENS_IMAGE_BY_ID[id];
  if (aliased) return `/images/lens/${aliased}.png`;
  return `/images/lens/${slugify(id || label)}.png`;
}

function apertureImageFor(label: string): string {
  const aliased = APERTURE_IMAGE_BY_LABEL[label];
  if (aliased) return `/images/aperture/${aliased}.png`;
  // "ƒ/1.4" → "f-1-4", "f/4" → "f-4"
  const cleaned = label.replace(/^ƒ\//i, 'f-').replace(/^f\//i, 'f-');
  return `/images/aperture/${slugify(cleaned)}.png`;
}

export function CameraPickerPopover({
  selection,
  onConfirm,
  onClose,
}: CameraPickerPopoverProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const { options, isLoading } = useFreezoneCameraOptions();

  const cameraBodies = options?.camera_bodies ?? [];
  const lenses = options?.lenses ?? [];
  const focalLengths = options?.focal_lengths_mm ?? [];
  const apertures = options?.apertures ?? [];

  // Draft state — committed only when the user confirms.
  const [draftCameraId, setDraftCameraId] = useState<string | null>(
    selection?.cameraBodyId ?? null,
  );
  const [draftLensId, setDraftLensId] = useState<string | null>(
    selection?.lensId ?? null,
  );
  const [draftFocal, setDraftFocal] = useState<number | null>(
    selection?.focalLengthMm ?? null,
  );
  const [draftAperture, setDraftAperture] = useState<string | null>(
    selection?.aperture ?? null,
  );

  // Seed defaults to the first item of each list once we have data.
  useEffect(() => {
    if (!options) return;
    if (draftCameraId == null && cameraBodies[0]) setDraftCameraId(cameraBodies[0].id);
    if (draftLensId == null && lenses[0]) setDraftLensId(lenses[0].id);
    if (draftFocal == null && focalLengths.length > 0) {
      // Prefer 35mm if present, else first.
      setDraftFocal(focalLengths.includes(35) ? 35 : focalLengths[0]);
    }
    if (draftAperture == null && apertures[0]) setDraftAperture(apertures[0]);
    // We only want to seed once after options arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);

  const cameraIndex = Math.max(
    0,
    cameraBodies.findIndex((item) => item.id === draftCameraId),
  );
  const lensIndex = Math.max(
    0,
    lenses.findIndex((item) => item.id === draftLensId),
  );
  const focalIndex = Math.max(
    0,
    focalLengths.findIndex((value) => value === draftFocal),
  );
  const apertureIndex = Math.max(
    0,
    apertures.findIndex((value) => value === draftAperture),
  );

  const selectedCameraLabel =
    cameraBodies[cameraIndex]?.label ?? '';
  const selectedLensLabel = lenses[lensIndex]?.label ?? '';

  const handleUse = () => {
    onConfirm({
      cameraBodyId: draftCameraId,
      lensId: draftLensId,
      focalLengthMm: draftFocal,
      aperture: draftAperture,
    });
  };

  return (
    <div
      ref={containerRef}
      className={CAMERA_PICKER_PANEL_CLASS}
      style={{ width: CAMERA_PICKER_POPOVER_WIDTH }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex h-11 items-center justify-between px-4">
        <span className="text-sm font-medium text-text-dark">
          {t('canvas.cameraPicker.title')}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="flex size-6 items-center justify-center rounded-md text-text-muted/90 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
          aria-label={t('common.close')}
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="flex items-start justify-center gap-5 px-6 pb-4 pt-3">
        <Column
          label={t('canvas.cameraPicker.body')}
          captionLabel={selectedCameraLabel}
          items={cameraBodies.map((item) => ({
            key: item.id,
            label: item.label,
            imageSrc: cameraImageFor(item.id, item.label),
          }))}
          selectedIndex={cameraIndex}
          onSelect={(idx) => setDraftCameraId(cameraBodies[idx]?.id ?? null)}
          variant="image"
          fallbackKind="camera"
          isLoading={isLoading}
        />
        <Column
          label={t('canvas.cameraPicker.lens')}
          captionLabel={selectedLensLabel}
          items={lenses.map((item) => ({
            key: item.id,
            label: item.label,
            imageSrc: lensImageFor(item.id, item.label),
          }))}
          selectedIndex={lensIndex}
          onSelect={(idx) => setDraftLensId(lenses[idx]?.id ?? null)}
          variant="image"
          fallbackKind="lens"
          isLoading={isLoading}
        />
        <Column
          label={t('canvas.cameraPicker.focal')}
          captionLabel="mm"
          items={focalLengths.map((value) => ({
            key: String(value),
            label: String(value),
          }))}
          selectedIndex={focalIndex}
          onSelect={(idx) => setDraftFocal(focalLengths[idx] ?? null)}
          variant="text"
          fallbackKind="focal"
          isLoading={isLoading}
        />
        <Column
          label={t('canvas.cameraPicker.aperture')}
          captionLabel={draftAperture ?? ''}
          items={apertures.map((value) => ({
            key: value,
            label: value,
            imageSrc: apertureImageFor(value),
          }))}
          selectedIndex={apertureIndex}
          onSelect={(idx) => setDraftAperture(apertures[idx] ?? null)}
          variant="image"
          fallbackKind="aperture"
          isLoading={isLoading}
        />
      </div>

      <div className="flex items-center justify-end gap-2 px-4 pb-4">
        <button
          type="button"
          onClick={() => onConfirm(null)}
          className="h-8 rounded-md px-3 text-[12px] font-medium text-text-dark/78 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
        >
          {t('canvas.cameraPicker.clear')}
        </button>
        <button
          type="button"
          onClick={handleUse}
          disabled={!options}
          className="h-8 min-w-[50px] rounded-md bg-primary px-3 text-[13px] text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-text-muted"
        >
          {t('common.use')}
        </button>
      </div>
    </div>
  );
}

interface ColumnItem {
  key: string;
  label: string;
  imageSrc?: string;
}

type FallbackKind = 'camera' | 'lens' | 'aperture' | 'focal';

interface ColumnProps {
  label: string;
  captionLabel: string;
  items: ColumnItem[];
  selectedIndex: number;
  onSelect: (index: number) => void;
  variant: 'image' | 'text';
  fallbackKind: FallbackKind;
  isLoading: boolean;
}

function Column({
  label,
  captionLabel,
  items,
  selectedIndex,
  onSelect,
  variant,
  fallbackKind,
  isLoading,
}: ColumnProps) {
  const { t } = useTranslation();
  const canPrev = selectedIndex > 0;
  const canNext = selectedIndex < items.length - 1;
  const translateY = HIGHLIGHT_TOP - selectedIndex * ITEM_HEIGHT;

  return (
    <div className="flex flex-col items-center" style={{ width: COLUMN_WIDTH }}>
      <div className="flex h-7 w-full items-center justify-center">
        <button
          type="button"
          disabled={!canPrev}
          onClick={() => canPrev && onSelect(selectedIndex - 1)}
          className={CAMERA_PICKER_ARROW_CLASS}
          aria-label={t('canvas.cameraPicker.prev')}
        >
          <ChevronDown className="size-3.5 rotate-180" />
        </button>
      </div>

      <div className="relative w-full overflow-hidden" style={{ height: VIEWPORT_HEIGHT }}>
        <div
          className="pointer-events-none absolute inset-x-3 z-20 rounded-[12px] border border-white/12"
          style={{
            top: HIGHLIGHT_TOP,
            height: ITEM_HEIGHT,
          }}
        />

        <div
          className="flex flex-col items-center"
          style={{
            transform: `translateY(${translateY}px)`,
          }}
        >
          {items.map((item, idx) => {
            const isSelected = idx === selectedIndex;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => onSelect(idx)}
                className={
                  variant === 'image'
                    ? 'flex w-full shrink-0 cursor-pointer flex-col items-center justify-center'
                    : 'flex w-full shrink-0 cursor-pointer items-center justify-center'
                }
                style={{ height: ITEM_HEIGHT }}
              >
                {variant === 'image' ? (
                  <Thumbnail
                    src={item.imageSrc}
                    label={item.label}
                    kind={fallbackKind}
                    isSelected={isSelected}
                  />
                ) : (
                  <span
                    className={`tabular-nums font-semibold leading-none text-text-dark transition-all duration-200 ${
                      isSelected ? 'text-[32px] opacity-100' : 'text-2xl opacity-50'
                    }`}
                  >
                    {item.label}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {isLoading && items.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] text-text-muted">
            {t('canvas.cameraPicker.loading')}
          </div>
        )}
      </div>

      <div className="flex h-7 w-full items-center justify-center">
        <button
          type="button"
          disabled={!canNext}
          onClick={() => canNext && onSelect(selectedIndex + 1)}
          className={CAMERA_PICKER_ARROW_CLASS}
          aria-label={t('canvas.cameraPicker.next')}
        >
          <ChevronDown className="size-3.5" />
        </button>
      </div>

      <span className={`mt-2 w-full truncate text-center ${CAMERA_PICKER_LABEL_CLASS}`}>
        {label}
      </span>

      <span className="mt-0.5 w-full truncate text-center text-[11px] text-text-muted/90">
        {captionLabel}
      </span>
    </div>
  );
}

interface ThumbnailProps {
  src?: string;
  label: string;
  kind: FallbackKind;
  isSelected: boolean;
}

function Thumbnail({ src, label, kind, isSelected }: ThumbnailProps) {
  const [broken, setBroken] = useState(false);
  const sizeClass = isSelected ? 'size-12 opacity-100' : 'size-10 opacity-0';

  if (src && !broken) {
    return (
      <img
        src={src}
        alt={label}
        loading="lazy"
        onError={() => setBroken(true)}
        className={`rounded object-cover transition-opacity duration-100 ${sizeClass}`}
      />
    );
  }

  // Fallback when the backend ships a variant id we don't have artwork for —
  // render a neutral chip with a kind-specific icon so the wheel slot still
  // looks intentional rather than empty.
  const FallbackIcon =
    kind === 'lens' ? Focus : kind === 'aperture' ? Aperture : Camera;

  return (
    <div
      className={`flex items-center justify-center rounded bg-white/[0.07] text-text-muted transition-opacity duration-100 ${sizeClass}`}
      title={label}
    >
      <FallbackIcon className={isSelected ? 'size-5' : 'size-4'} />
    </div>
  );
}

export function describeCameraSelection(
  selection: ImageGenCameraSelection | null,
  options: { camera_bodies?: { id: string; label: string }[]; lenses?: { id: string; label: string }[] } | null,
): string | null {
  if (!selection) return null;
  const parts: string[] = [];
  if (selection.cameraBodyId) {
    const found = options?.camera_bodies?.find((x) => x.id === selection.cameraBodyId);
    if (found) parts.push(found.label);
  }
  if (selection.lensId) {
    const found = options?.lenses?.find((x) => x.id === selection.lensId);
    if (found) parts.push(found.label);
  }
  if (selection.focalLengthMm) parts.push(`${selection.focalLengthMm}mm`);
  if (selection.aperture) parts.push(selection.aperture);
  return parts.length > 0 ? parts.join(', ') : null;
}
