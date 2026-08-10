// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useState } from 'react';
import { ImageOff } from 'lucide-react';

import { resolveStyleAssetUrl } from '@/features/canvas/nodes/styleAssetUrl';

export interface StyleAssetImageProps {
  /** 清单里的相对路径,由 resolveStyleAssetUrl 决定落到本地还是 OSS。 */
  rel: string;
  assetBase: string;
  alt: string;
  className?: string;
  loading?: 'lazy' | 'eager';
  draggable?: boolean;
}

/**
 * 风格封面/示例图。
 *
 * 提示词清单和图片可以分别换代(清单走 STYLE_GALLERY_MANIFEST、图片走
 * STYLE_GALLERY_ASSET_BASE),两边对不上时图会 404 —— 这里兜一个占位块,
 * 免得图墙里散落浏览器默认的碎图标。
 */
export function StyleAssetImage({
  rel,
  assetBase,
  alt,
  className = '',
  loading,
  draggable,
}: StyleAssetImageProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = resolveStyleAssetUrl(rel, assetBase);

  // 比较地址而不是存布尔:换了清单/换了前缀就自动重试一次。
  if (!src || failedSrc === src) {
    return (
      <div
        role="img"
        aria-label={alt}
        className={`flex min-h-10 items-center justify-center bg-white/[0.06] text-text-muted ${className}`}
      >
        <ImageOff className="size-4" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      loading={loading}
      draggable={draggable}
      onError={() => setFailedSrc(src)}
      className={className}
    />
  );
}
