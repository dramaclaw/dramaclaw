// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useId, useState } from 'react';
import { LockKeyhole, UnlockKeyhole } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CANVAS_NODE_TOOLBAR_CARD_CLASS } from './nodeFrameStyles';
import { loadImageElement } from '@/features/canvas/application/imageData';
import { proportionalResizeDimension, resizeImage, validResizeDimensions, RESIZE_MAX_EDGE } from '@/features/canvas/application/imageResize';

interface ImageResizeProps {
  nodeId: string;
  imageSource: string;
  onClose: () => void;
  onCreated?: (nodeId: string) => void;
}

export function ImageResizePanel({ nodeId, imageSource, onClose, onCreated }: ImageResizeProps) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const [locked, setLocked] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    setNatural(null);
    setError(null);
    void loadImageElement(imageSource).then((image) => {
      if (disposed) return;
      if (!image.naturalWidth || !image.naturalHeight) throw new Error('Invalid image dimensions');
      setNatural({ width: image.naturalWidth, height: image.naturalHeight });
      setWidth(String(image.naturalWidth));
      setHeight(String(image.naturalHeight));
    }).catch(() => { if (!disposed) setError(t('resizeEditor.loadFailed')); });
    return () => { disposed = true; };
  }, [imageSource, t]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const changeDimension = (axis: 'width' | 'height', value: string) => {
    (axis === 'width' ? setWidth : setHeight)(value);
    if (!locked || !natural) return;
    if (!value) {
      (axis === 'width' ? setHeight : setWidth)('');
    } else if (Number.isFinite(Number(value)) && Number(value) > 0) {
      const other = axis === 'width'
        ? proportionalResizeDimension(Number(value), natural.width, natural.height)
        : proportionalResizeDimension(Number(value), natural.height, natural.width);
      (axis === 'width' ? setHeight : setWidth)(String(other));
    }
  };
  const valid = validResizeDimensions(Number(width), Number(height));
  const unchanged = natural?.width === Number(width) && natural?.height === Number(height);
  return <section aria-label={t('resizeEditor.title')}
    className={`nodrag nopan nowheel w-[324px] p-3 ${CANVAS_NODE_TOOLBAR_CARD_CLASS}`}
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => event.stopPropagation()}>
      <div className="mb-4 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 className="text-sm font-semibold text-text-dark">{t('resizeEditor.title')}</h3>
        <p className="text-xs text-text-muted">{natural
          ? t('resizeEditor.original', natural) : t('resizeEditor.loading')}</p>
      </div>
      <form className="space-y-4" onSubmit={(event) => {
        event.preventDefault();
        if (!natural || !valid || unchanged) return;
        const result = resizeImage(nodeId, imageSource, Number(width), Number(height), t('resizeEditor.resultTitle'));
        if (!result) { setError(t('resizeEditor.saveFailed')); return; }
        onClose();
        onCreated?.(result.nodeId);
      }}>
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
          <div className="space-y-2">
            <label htmlFor={`${fieldId}-width`}>{t('resizeEditor.width')}</label>
            <Input id={`${fieldId}-width`} type="number" min={1} max={RESIZE_MAX_EDGE} step={1}
              disabled={!natural} value={width} onChange={(event) => changeDimension('width', event.target.value)} />
          </div>
          <div className="group/resize-ratio relative">
          <Button type="button" variant="ghost" size="icon" disabled={!natural} aria-pressed={locked}
            aria-label={t('resizeEditor.lockRatio')} aria-describedby={`${fieldId}-ratio-tip`}
            onClick={() => {
              if (!locked && natural && Number(width) > 0) {
                setHeight(String(proportionalResizeDimension(Number(width), natural.width, natural.height)));
              }
              setLocked(!locked);
            }}>
            {locked ? <LockKeyhole /> : <UnlockKeyhole />}
          </Button>
          <span id={`${fieldId}-ratio-tip`} role="tooltip"
            className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-surface-dark px-2 py-1 text-xs text-text-dark opacity-0 shadow-lg transition-opacity duration-150 group-hover/resize-ratio:opacity-100 group-focus-within/resize-ratio:opacity-100">
            {t('resizeEditor.lockRatio')}
          </span>
          </div>
          <div className="space-y-2">
            <label htmlFor={`${fieldId}-height`}>{t('resizeEditor.height')}</label>
            <Input id={`${fieldId}-height`} type="number" min={1} max={RESIZE_MAX_EDGE} step={1}
              disabled={!natural} value={height} onChange={(event) => changeDimension('height', event.target.value)} />
          </div>
        </div>
        {natural && width && height && !valid && <p role="alert" className="text-sm text-destructive">{t('resizeEditor.invalidSize')}</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" variant="outline" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" disabled={!natural || !valid || unchanged}>{t('resizeEditor.submit')}</Button>
        </div>
      </form>
  </section>;
}

/** Storyboard details use the same form without a React Flow node anchor. */
export function ImageResizeDialog(props: ImageResizeProps) {
  const { t } = useTranslation();
  return <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
    <DialogContent className="z-[310] w-auto gap-0 border-0 bg-transparent p-0 ring-0 sm:max-w-none"
      overlayClassName="z-[309] bg-black/60 supports-backdrop-filter:backdrop-blur-none"
      showCloseButton={false} onClick={(event) => event.stopPropagation()}>
      <DialogTitle className="sr-only">{t('resizeEditor.title')}</DialogTitle>
      <ImageResizePanel {...props} />
    </DialogContent>
  </Dialog>;
}
