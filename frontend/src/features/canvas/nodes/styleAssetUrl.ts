// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 风格图片地址的唯一解析点。
 *
 * 图片不随仓库发布:后端配 STYLE_GALLERY_ASSET_BASE(OSS/CDN 域名)后由接口
 * 下发前缀,这里直接拼。assetBase 为空时回落到同源 /style-gallery/ —— 那个
 * 目录默认是空的,交给 StyleAssetImage 显示占位块。
 */
export function resolveStyleAssetUrl(rel: string, assetBase: string): string {
  if (!rel) return '';
  if (!assetBase) return `/style-gallery/${rel}`;
  return `${assetBase.replace(/\/+$/, '')}/${rel}`;
}
