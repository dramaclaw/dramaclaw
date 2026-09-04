// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Download, Music, Send, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { SOURCE_LABEL_KEYS, type LibraryItem } from './assetLibraryItems';

interface AssetLibraryPreviewDialogProps {
  entry: LibraryItem;
  onClose: () => void;
  onDownload: () => void;
  onSend?: () => void;
  onDelete?: () => void;
}

/** 管理态的单项落点：预览内容，并集中承接下载、发送和可选的删除操作。 */
export function AssetLibraryPreviewDialog({
  entry,
  onClose,
  onDownload,
  onSend,
  onDelete,
}: AssetLibraryPreviewDialogProps) {
  const { t } = useTranslation();
  const src = resolveImageDisplayUrl(entry.url);
  const mediaLabel = t(`canvas.assetLibrary.media.${entry.media}`);

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center p-6">
      <button
        type="button"
        className="absolute inset-0 bg-black/65 backdrop-blur-sm"
        aria-label={t('canvas.assetLibrary.preview.closeAria')}
        onClick={onClose}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t('canvas.assetLibrary.preview.dialogAria')}
        className="relative flex w-[min(760px,86vw)] flex-col overflow-hidden rounded-xl border border-[var(--ui-border-soft)] bg-[rgba(var(--surface-rgb)/0.98)] shadow-[0_22px_64px_rgba(0,0,0,0.55)]"
      >
        <header className="flex items-center gap-3 border-b border-[var(--ui-border-soft)] px-5 py-4">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold text-foreground">
              {entry.name || t('canvas.assetLibrary.unnamed')}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(SOURCE_LABEL_KEYS[entry.source])} · {mediaLabel}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('canvas.assetLibrary.preview.closeAria')}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.07] hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex min-h-[360px] items-center justify-center bg-black/30 p-5">
          {entry.media === 'image' ? (
            <img
              src={src}
              alt={entry.name}
              className="max-h-[56vh] max-w-full rounded-md object-contain"
              draggable={false}
            />
          ) : entry.media === 'video' ? (
            <video
              src={src}
              className="max-h-[56vh] max-w-full rounded-md"
              controls
              autoPlay
              playsInline
            />
          ) : (
            <div className="flex w-full max-w-lg flex-col items-center gap-5 rounded-lg border border-white/[0.07] bg-white/[0.03] px-8 py-12">
              <Music className="h-10 w-10 text-muted-foreground" />
              <audio src={src} className="w-full" controls autoPlay />
            </div>
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-[var(--ui-border-soft)] px-5 py-4">
          {entry.source !== 'upload' ? (
            <p className="mr-auto text-xs text-muted-foreground">
              {t('canvas.assetLibrary.preview.mainlineHint')}
            </p>
          ) : (
            <div className="mr-auto" />
          )}
          <Button size="sm" variant="ghost" onClick={onDownload}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            {t('common.download')}
          </Button>
          {onDelete && (
            <Button
              size="sm"
              className="bg-red-500 text-white hover:bg-red-500/90"
              onClick={onDelete}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {t('common.delete')}
            </Button>
          )}
          {onSend && (
            <Button size="sm" onClick={onSend}>
              <Send className="mr-1.5 h-3.5 w-3.5" />
              {t('canvas.assetLibrary.sendToCanvas')}
            </Button>
          )}
        </footer>
      </section>
    </div>
  );
}
