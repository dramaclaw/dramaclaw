// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { MediaViewerShell } from './MediaViewerShell';
import { VideoPlayerControls } from './VideoPlayerControls';
import styles from './media-viewer.module.css';

export interface VideoViewerModalProps {
  open: boolean;
  videoUrl: string;
  title?: string;
  videoList?: string[];
  currentIndex?: number;
  onClose: () => void;
  onSelect?: (index: number) => void;
  onNavigate?: (direction: 'prev' | 'next') => void;
}

export function VideoViewerModal({ open, videoUrl, title, videoList = [], currentIndex = 0, onClose, onSelect, onNavigate }: VideoViewerModalProps): ReactElement {
  const { t } = useTranslation();
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [videoSize, setVideoSize] = useState({ url: '', ratio: 16 / 9 });
  const frameRef = useRef<HTMLDivElement>(null);
  useEffect(() => () => { videoEl?.pause(); }, [videoEl, videoUrl, open]);
  return <MediaViewerShell open={open} title={title ?? t('viewer.videoTitleFallback')} mediaType="video"
    ratio={videoSize.url === videoUrl ? videoSize.ratio : 16 / 9} items={videoList} currentIndex={currentIndex}
    onClose={onClose} onSelect={onSelect} onNavigate={onNavigate} frameRef={frameRef}>
    <video key={videoUrl} ref={setVideoEl} src={videoUrl} aria-label={title ?? t('viewer.videoTitleFallback')}
      className={styles.media} autoPlay playsInline
      onLoadedMetadata={event => {
        const video = event.currentTarget;
        if (video.videoWidth > 0 && video.videoHeight > 0) setVideoSize({ url: videoUrl, ratio: video.videoWidth / video.videoHeight });
      }} />
    <VideoPlayerControls videoEl={videoEl} onFullscreen={() => { void frameRef.current?.requestFullscreen?.().catch(() => undefined); }} />
  </MediaViewerShell>;
}
