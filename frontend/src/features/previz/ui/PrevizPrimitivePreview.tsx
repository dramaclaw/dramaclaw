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
  sphere: (
    <>
      <circle cx="32" cy="32" r="18" />
      <ellipse cx="32" cy="32" rx="18" ry="6" />
    </>
  ),
  cylinder: (
    <>
      <ellipse cx="32" cy="18" rx="16" ry="5" />
      <path d="M16 18v28M48 18v28M16 46a16 5 0 0 0 32 0" />
    </>
  ),
  cone: <path d="M16 48L32 12l16 36M16 48a16 5 0 0 0 32 0" />,
  plane: <path d="M10 40l16-12h28L38 40z" />,
  capsule: <rect x="22" y="12" width="20" height="40" rx="10" />,
  wedge: <path d="M14 50V22l24 28zM14 22l12-8 24 28-12 8" />,
  torus: (
    <>
      <ellipse cx="32" cy="34" rx="20" ry="9" />
      <ellipse cx="32" cy="33" rx="9" ry="3.5" />
    </>
  ),
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
