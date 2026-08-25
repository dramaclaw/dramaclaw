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

/**
 * Keeps `src` off the DOM until the image is near the visible viewport.
 *
 * Native `loading="lazy"` is deliberately heuristic and may eagerly fetch an
 * entire list inside a nested scroll container. Asset paths are conventional,
 * so an eager list can turn every not-yet-generated image into a cold 404. This
 * component keeps metadata loading independent from media loading without
 * adding file-existence state to the database.
 */
export function ViewportLazyImage({
  src,
  rootMargin = "160px 0px",
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
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setRevealedSrc(src);
        observer.disconnect();
      },
      { rootMargin },
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
