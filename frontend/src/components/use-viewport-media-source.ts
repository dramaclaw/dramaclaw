// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState, type RefObject } from 'react';

/** Delay media loading until its slot intersects the viewport and scroll ancestors. */
export function useViewportMediaSource<T extends HTMLElement>(
  src: string,
  rootMargin = '0px',
): { ref: RefObject<T | null>; visibleSrc: string | undefined } {
  const ref = useRef<T>(null);
  const [revealedSrc, setRevealedSrc] = useState<string | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element || !src) return;
    if (typeof IntersectionObserver === 'undefined') {
      setRevealedSrc(src);
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= 0.01)) return;
      setRevealedSrc(src);
      observer.disconnect();
    }, { root: null, rootMargin, threshold: 0.01 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [src, rootMargin]);

  return { ref, visibleSrc: revealedSrc === src ? src : undefined };
}
