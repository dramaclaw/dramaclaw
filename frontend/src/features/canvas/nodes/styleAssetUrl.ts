// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 风格图片地址的唯一解析点。
 *
 * assetBase 为空时走打包进 frontend/public 的静态资源;后端配置了
 * STYLE_GALLERY_ASSET_BASE(例如 OSS 域名)则直接拼该前缀,前端无需改动。
 */
export function resolveStyleAssetUrl(rel: string, assetBase: string): string {
  if (!rel) return '';
  if (!assetBase) return `/style-gallery/${rel}`;
  return `${assetBase.replace(/\/+$/, '')}/${rel}`;
}
