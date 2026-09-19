// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  applyLocalizedAssets,
  collectRemoteMediaUrls,
} from '@/features/canvas/domain/canvasRemoteMedia';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';

const node = (data: unknown): CanvasNode =>
  ({ id: 'n1', type: 'imageGenNode', position: { x: 0, y: 0 }, data } as unknown as CanvasNode);

describe('collectRemoteMediaUrls', () => {
  it('收集所有 *Url 字段里的远端地址，并跳过已本地化的', () => {
    const urls = collectRemoteMediaUrls([
      node({
        imageUrl: 'https://cdn.example/a.png',
        previewImageUrl: 'https://cdn.example/a.png?x-oss-process=image%2Fresize%2Cw_320',
        localUrl: '/static/projects/p/a.png',
        references: [{ url: 'https://cdn.example/b.png' }],
      }),
    ]);
    expect(urls).toEqual([
      'https://cdn.example/a.png',
      'https://cdn.example/a.png?x-oss-process=image%2Fresize%2Cw_320',
      'https://cdn.example/b.png',
    ]);
  });

  it('不去扫 prompt 里粘着的链接——那不是素材，下载纯属浪费', () => {
    expect(collectRemoteMediaUrls([node({ prompt: '参考 https://example.com/ref' })])).toEqual([]);
  });
});

describe('applyLocalizedAssets', () => {
  it('换掉已落地的地址，并把标记收敛到仍然远端的那几条', () => {
    const next = applyLocalizedAssets(
      {
        imageUrl: 'https://cdn.example/a.png',
        posterUrl: 'https://cdn.example/b.png',
        liblibImport: {
          nodeKey: 'k',
          remoteMedia: [
            { url: 'https://cdn.example/a.png', reason: 'internal_host' },
            { url: 'https://cdn.example/b.png', reason: 'internal_host' },
          ],
        },
      },
      { 'https://cdn.example/a.png': '/static/projects/p/a.png' },
      new Map([['https://cdn.example/b.png', 'liblib_media_unavailable']]),
    );
    expect(next?.imageUrl).toBe('/static/projects/p/a.png');
    expect((next?.liblibImport as { remoteMedia: unknown }).remoteMedia).toEqual([
      { url: 'https://cdn.example/b.png', reason: 'liblib_media_unavailable' },
    ]);
  });

  it('全部本地化后彻底摘掉标记，而不是留一个空数组', () => {
    const next = applyLocalizedAssets(
      {
        imageUrl: 'https://cdn.example/a.png',
        liblibImport: { nodeKey: 'k', remoteMedia: [{ url: 'https://cdn.example/a.png', reason: 'internal_host' }] },
      },
      { 'https://cdn.example/a.png': '/static/projects/p/a.png' },
      new Map(),
    );
    expect(next?.liblibImport).toEqual({ nodeKey: 'k' });
  });

  it('没有任何变化时返回 null，避免一次无意义的 store 写入', () => {
    expect(applyLocalizedAssets({ imageUrl: '/static/projects/p/a.png' }, {}, new Map())).toBeNull();
  });
});

describe('溯源字段不参与本地化', () => {
  // 64c5bb59 那张画布素材早已全部本地化，却有 92 条 liblibImport.sourceUrl 指向 LibTV。
  // 把它们算成待下载素材，就会在一张健康的画布上弹出「92 个素材未本地化」。
  it('liblibImport.sourceUrl 不算作待本地化素材', () => {
    expect(
      collectRemoteMediaUrls([
        node({
          imageUrl: '/static/projects/p/a.png',
          liblibImport: { nodeKey: 'k', sourceUrl: 'https://cdn.example/a.png' },
        }),
      ]),
    ).toEqual([]);
  });

  it('本地化不会把 sourceUrl 改写成本地路径——它要一直指向原址', () => {
    const next = applyLocalizedAssets(
      {
        imageUrl: 'https://cdn.example/a.png',
        liblibImport: { nodeKey: 'k', sourceUrl: 'https://cdn.example/a.png' },
      },
      { 'https://cdn.example/a.png': '/static/projects/p/a.png' },
      new Map(),
    );
    expect(next?.imageUrl).toBe('/static/projects/p/a.png');
    expect((next?.liblibImport as { sourceUrl: string }).sourceUrl).toBe('https://cdn.example/a.png');
  });
});
