// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { MediaViewerShell } from './MediaViewerShell';
import styles from './media-viewer.module.css';

export interface ImageViewerModalProps {
  open: boolean;
  imageUrl: string;
  imageList: string[];
  currentIndex: number;
  onClose: () => void;
  onNavigate: (direction: 'prev' | 'next') => void;
  onSelect: (index: number) => void;
}

export function ImageViewerModal({ open, imageUrl, imageList, currentIndex, onClose, onNavigate, onSelect }: ImageViewerModalProps): ReactElement {
  const { t } = useTranslation();
  const [imageSize, setImageSize] = useState({ url: '', ratio: 16 / 9 });
  return <MediaViewerShell open={open} title={t('viewer.imageDetails')} mediaType="image"
    ratio={imageSize.url === imageUrl ? imageSize.ratio : 16 / 9} items={imageList} currentIndex={currentIndex}
    onClose={onClose} onNavigate={onNavigate} onSelect={onSelect}>
    <img src={imageUrl} alt={t('viewer.imageAlt')} className={styles.media} draggable={false}
      onLoad={event => {
        const image = event.currentTarget;
        if (image.naturalWidth > 0 && image.naturalHeight > 0) {
          setImageSize({ url: imageUrl, ratio: image.naturalWidth / image.naturalHeight });
        }
      }} />
  </MediaViewerShell>;
}
