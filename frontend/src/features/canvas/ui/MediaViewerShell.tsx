// SPDX-License-Identifier: Elastic-2.0
import { useRef, type CSSProperties, type ReactNode, type Ref } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { resolveMediaUrl } from '@/lib/media-url';
import { ViewportLazyImage } from '@/components/viewport-lazy-image';
import { ViewportLazyVideo } from '@/components/viewport-lazy-video';
import { useViewerImmersiveBody } from '@/features/viewer-kit/useViewerImmersiveBody';
import { MEDIA_VIEWER_CLOSE_BUTTON_CLASS, MEDIA_VIEWER_CLOSE_ICON_CLASS } from './closeButtonStyles';
import styles from './media-viewer.module.css';

interface MediaViewerShellProps {
  open: boolean;
  title: string;
  ratio: number;
  mediaType: 'image' | 'video';
  items?: string[];
  currentIndex?: number;
  onClose: () => void;
  onSelect?: (index: number) => void;
  onNavigate?: (direction: 'prev' | 'next') => void;
  frameRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}

/** Shared viewport, focus, navigation, media frame, and compact history rail. */
export function MediaViewerShell({ open, title, ratio, mediaType, items = [], currentIndex = 0, onClose, onSelect, onNavigate, frameRef, children }: MediaViewerShellProps) {
  const { t } = useTranslation();
  const closeRef = useRef<HTMLButtonElement>(null);
  useViewerImmersiveBody(open);
  return <Dialog.Root open={open} onOpenChange={nextOpen => { if (!nextOpen) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className={styles.backdrop} />
      <Dialog.Popup className={styles.popup} initialFocus={closeRef}
        onClick={event => { if (event.target === event.currentTarget) onClose(); }}
        onKeyDown={event => {
          // The seek slider owns its arrow keys.
          if ((event.target as HTMLElement).tagName === 'INPUT') return;
          if (onNavigate && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
            event.preventDefault(); event.stopPropagation();
            onNavigate(event.key === 'ArrowLeft' ? 'prev' : 'next');
          }
        }}>
        <Dialog.Title className="sr-only">{title}</Dialog.Title>
        <div className={styles.gallery}>
          <div className={styles.stage} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
            <div ref={frameRef} className={styles.frame} style={{ '--media-ratio': ratio } as CSSProperties}>
              {children}
              <button ref={closeRef} type="button" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}
                className={`${styles.close} ${MEDIA_VIEWER_CLOSE_BUTTON_CLASS}`}>
                <X className={MEDIA_VIEWER_CLOSE_ICON_CLASS} />
              </button>
            </div>
          </div>
          {items.length > 1 && onSelect && <aside className={`${styles.history} ui-scrollbar ui-scrollbar-vertical`} aria-label={t('canvas.nodeHistory.title')}>
            {items.map((url, index) => <button key={`${url}:${index}`} type="button" className={styles.thumbnail}
              aria-label={t(mediaType === 'image' ? 'viewer.imageIndex' : 'viewer.videoIndex', { index: index + 1 })}
              aria-pressed={currentIndex === index} onClick={() => onSelect(index)}>
              {mediaType === 'image'
                ? <ViewportLazyImage src={resolveMediaUrl(url, { variant: 'thumb' }) ?? url} alt="" draggable={false} />
                : <ViewportLazyVideo src={url} />}
            </button>)}
          </aside>}
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
