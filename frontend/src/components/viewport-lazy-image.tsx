// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
import type { ImgHTMLAttributes } from "react";

type ViewportLazyImageProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src"
> & {
  src: string;
  rootMargin?: string;
};

const MIN_VISIBLE_RATIO = 0.01;

/**
 * Keeps `src` off the DOM until the image is actually visible in the viewport.
 *
 * Native `loading="lazy"` is deliberately heuristic and may eagerly fetch an
 * entire list inside a nested scroll container. Asset paths are conventional,
 * so an eager list can turn every not-yet-generated image into a cold 404. This
 * component keeps metadata loading independent from media loading without
 * adding file-existence state to the database.
 */
export function ViewportLazyImage({
  src,
  rootMargin = "0px",
  ...props
}: ViewportLazyImageProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [revealedSrc, setRevealedSrc] = useState<string | null>(null);

  useEffect(() => {
    const image = imageRef.current;
    if (!image || !src) return;

    if (typeof IntersectionObserver === "undefined") {
      setRevealedSrc(src);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visiblyIntersecting = entries.some(
          (entry) =>
            entry.isIntersecting && entry.intersectionRatio >= MIN_VISIBLE_RATIO,
        );
        if (!visiblyIntersecting) return;
        setRevealedSrc(src);
        observer.disconnect();
      },
      {
        // `root: null` intersects against the browser viewport while still
        // respecting every clipping/scrolling ancestor. A zero margin means
        // the request starts only after the user can actually see the slot.
        root: null,
        rootMargin,
        threshold: MIN_VISIBLE_RATIO,
      },
    );
    observer.observe(image);
    return () => observer.disconnect();
  }, [rootMargin, src]);

  return (
    <img
      ref={imageRef}
      {...props}
      src={revealedSrc === src ? src : undefined}
      loading="lazy"
      decoding={props.decoding ?? "async"}
    />
  );
}
