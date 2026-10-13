// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { VideoHTMLAttributes } from 'react';
import { useViewportMediaSource } from './use-viewport-media-source';

type ViewportLazyVideoProps = Omit<VideoHTMLAttributes<HTMLVideoElement>, 'src' | 'muted' | 'autoPlay' | 'controls' | 'preload' | 'playsInline'> & {
  src: string;
};

/** Passive thumbnails never autoplay or request an offscreen video. */
export function ViewportLazyVideo({ src, ...props }: ViewportLazyVideoProps) {
  const posterSource = src.includes('#') ? src : `${src}#t=0.1`;
  const { ref, visibleSrc } = useViewportMediaSource<HTMLVideoElement>(posterSource);
  return <video key={posterSource} {...props} ref={ref} src={visibleSrc} muted playsInline preload="metadata" autoPlay={false} controls={false} />;
}
