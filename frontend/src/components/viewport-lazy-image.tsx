// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useViewportMediaSource } from "./use-viewport-media-source";
import type { ImgHTMLAttributes } from "react";

type ViewportLazyImageProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src"
> & {
  src: string;
  rootMargin?: string;
};

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
  const { ref: imageRef, visibleSrc } = useViewportMediaSource<HTMLImageElement>(src, rootMargin);

  return (
    <img
      ref={imageRef}
      {...props}
      src={visibleSrc}
      loading="lazy"
      decoding={props.decoding ?? "async"}
    />
  );
}
