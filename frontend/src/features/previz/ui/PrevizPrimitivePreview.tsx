// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ReactNode } from "react";

import type { PrevizPrimitiveShape } from "@/features/previz/domain/primitives";

/**
 * 每种几何体一张线稿，统一从右上方斜看。描边走 currentColor：卡片悬停变亮时，
 * 线稿跟着文字一起亮。
 *
 * 用手写 SVG 而不是离屏渲染一张缩略图：首屏包里不能有 three，而对话框在首屏就可能打开。
 */
const DRAWINGS: Record<PrevizPrimitiveShape, ReactNode> = {
  cube: <path d="M16 26h24v24H16zM16 26l10-10h24L40 26M40 50l10-10V16" />,
  cuboid: <path d="M8 32h36v16H8zM8 32l10-8h36l-10 8M44 48l10-8V24" />,
  roundedBox: (
    <path d="M20 26h16a4 4 0 0 1 4 4v16a4 4 0 0 1-4 4H20a4 4 0 0 1-4-4V30a4 4 0 0 1 4-4zM18 27l9-9h19a4 4 0 0 1 4 4v19l-9 8" />
  ),
  sphere: (
    <>
      <circle cx="32" cy="32" r="18" />
      <ellipse cx="32" cy="32" rx="18" ry="6" />
    </>
  ),
  hemisphere: (
    <>
      <path d="M14 42a18 18 0 0 1 36 0" />
      <ellipse cx="32" cy="42" rx="18" ry="6" />
    </>
  ),
  ellipsoid: (
    <>
      <ellipse cx="32" cy="32" rx="22" ry="13" />
      <ellipse cx="32" cy="32" rx="22" ry="4" />
    </>
  ),
  cylinder: (
    <>
      <ellipse cx="32" cy="18" rx="16" ry="5" />
      <path d="M16 18v28M48 18v28M16 46a16 5 0 0 0 32 0" />
    </>
  ),
  tube: (
    <>
      <ellipse cx="32" cy="18" rx="16" ry="5" />
      <ellipse cx="32" cy="18" rx="9" ry="2.8" />
      <path d="M16 18v28M48 18v28M16 46a16 5 0 0 0 32 0" />
    </>
  ),
  disc: (
    <>
      <ellipse cx="32" cy="30" rx="20" ry="7" />
      <path d="M12 30v4M52 30v4M12 34a20 7 0 0 0 40 0" />
    </>
  ),
  cone: <path d="M16 48L32 12l16 36M16 48a16 5 0 0 0 32 0" />,
  frustum: (
    <>
      <ellipse cx="32" cy="16" rx="9" ry="3" />
      <path d="M23 16l-9 30M41 16l9 30M14 46a18 6 0 0 0 36 0" />
    </>
  ),
  pyramid: <path d="M32 10L12 44l28 6 12-12zM32 10l8 40" />,
  squareFrustum: <path d="M24 22l8 4 8-4-8-4zM24 22L12 42l20 10 20-10-12-20M32 26v26" />,
  bipyramid: (
    <>
      <path d="M32 8L14 32l18 24 18-24z" />
      <path d="M14 32a18 5 0 0 0 36 0" />
    </>
  ),
  capsule: <rect x="22" y="12" width="20" height="40" rx="10" />,
  wedge: <path d="M14 50V22l24 28zM14 22l12-8 24 28-12 8" />,
  triangularPrism: <path d="M18 20l18-7 10 7zM18 20v28h28V20" />,
  hexagonalPrism: (
    <path d="M16 18l8-5h16l8 5-8 5H24zM16 18v26l8 5h16l8-5V18M24 23v26M40 23v26" />
  ),
  octagonalPrism: (
    <path d="M17 16l9-3.5h12l9 3.5v4.5l-9 3.5H26l-9-3.5zM17 20.5v26l9 3.5h12l9-3.5v-26M26 24v26M38 24v26" />
  ),
  starPrism: (
    <path d="M32 24.8l-4.1-4.5-12.1-.2 9.5-3-3.3-4.6 10 2.7 10-2.7-3.3 4.6 9.5 3-12.1.2zM15.8 20.1v28l12.1.2 4.1 4.5 4.1-4.5 12.1-.2v-28M27.9 20.3v28M32 24.8v28M36.1 20.3v28" />
  ),
  tetrahedron: <path d="M32 10L12 48h32zM32 10l20 26-8 12" />,
  octahedron: <path d="M32 8L14 32l18 24 18-26zM32 8l-4 30 4 18M14 32l14 6 22-8" />,
  icosahedron: (
    <path d="M32 10l19 11v22L32 54 13 43V21zM32 18L20 38h24zM32 10v8M13 21l19-3 19 3M13 21l7 17M51 21l-7 17M13 43l7-5M51 43l-7-5M20 38l12 16 12-16" />
  ),
  torus: (
    <>
      <ellipse cx="32" cy="34" rx="20" ry="9" />
      <ellipse cx="32" cy="33" rx="9" ry="3.5" />
    </>
  ),
  plane: <path d="M10 40l16-12h28L38 40z" />,
};

export function PrevizPrimitivePreview({
  shape,
  className,
}: {
  shape: PrevizPrimitiveShape;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-shape={shape}
      className={className}
    >
      {DRAWINGS[shape]}
    </svg>
  );
}
