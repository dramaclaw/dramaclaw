// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  derivedVideoPoster,
  getLodStill,
  serverSidePosterUrl,
  shouldSelfCaptureLodStill,
} from '@/features/canvas/application/videoFrameCapture';

describe('serverSidePosterUrl', () => {
  it('远端无 query 的视频对象：追加 OSS 服务端抽帧参数', () => {
    const poster = serverSidePosterUrl('https://cdn.example.com/a/b/clip.mp4');
    expect(poster).not.toBeNull();
    expect(poster).toContain('https://cdn.example.com/a/b/clip.mp4?x-oss-process=');
    // 抽帧语法：截帧、JPEG、限宽 320、最近关键帧、100ms。
    const decoded = decodeURIComponent(poster as string);
    expect(decoded).toContain('video/snapshot');
    expect(decoded).toContain('t_100');
    expect(decoded).toContain('f_jpg');
    expect(decoded).toContain('w_320');
    expect(decoded).toContain('m_fast');
  });

  it('远端带 query（预签名地址）：不追加，回落离屏抓帧', () => {
    // 预签名地址的签名覆盖 query，多一个参数会让签名失效、图直接裂掉。
    expect(
      serverSidePosterUrl(
        'https://bucket.oss.example.com/x/clip.mp4?Expires=1&Signature=abc',
      ),
    ).toBeNull();
  });

  it('远端非视频后缀：不追加', () => {
    expect(serverSidePosterUrl('https://cdn.example.com/a/photo.png')).toBeNull();
    expect(serverSidePosterUrl('https://cdn.example.com/a/no-ext')).toBeNull();
  });

  it('各种视频后缀都识别', () => {
    for (const ext of ['mp4', 'mov', 'm4v', 'webm', 'mkv']) {
      expect(
        serverSidePosterUrl(`https://cdn.example.com/a/clip.${ext}`),
        ext,
      ).not.toBeNull();
    }
  });

  it('本地 /static/projects 路径：返回 null，回落离屏抓帧', () => {
    expect(
      serverSidePosterUrl('/static/projects/p1/videos/clip.mp4'),
    ).toBeNull();
  });

  it('blob: / data: / 空值：返回 null', () => {
    expect(serverSidePosterUrl('blob:https://app/abc')).toBeNull();
    expect(serverSidePosterUrl('data:video/mp4;base64,AAAA')).toBeNull();
    expect(serverSidePosterUrl('')).toBeNull();
    expect(serverSidePosterUrl(null)).toBeNull();
    expect(serverSidePosterUrl(undefined)).toBeNull();
  });
});

describe('derivedVideoPoster：封面取用顺序', () => {
  it('落库封面 previewImageUrl 最优先', () => {
    expect(
      derivedVideoPoster({
        previewImageUrl: '/static/projects/p1/freezone/poster.jpg',
        liblibSourceUrl: 'https://libtv-res.liblib.art/a/clip.mp4',
        videoSource: 'https://cdn.example.com/a/clip.mp4',
      }),
    ).toBe('/static/projects/p1/freezone/poster.jpg');
  });

  it('无落库封面但节点带 liblib sourceUrl：现算 liblib 封面（无需重导）', () => {
    // 视频已本地化（videoSource 是 /static），previewImageUrl 丢失，仍能从原始
    // liblib 源直接拿到 OSS 抽帧封面。
    const poster = derivedVideoPoster({
      previewImageUrl: null,
      liblibSourceUrl: 'https://libtv-res.liblib.art/a/clip.mp4',
      videoSource: '/static/projects/p1/videos/clip.mp4',
    });
    expect(poster).not.toBeNull();
    const decoded = decodeURIComponent(poster as string);
    expect(decoded).toContain('libtv-res.liblib.art');
    expect(decoded).toContain('video/snapshot');
  });

  it('liblib sourceUrl 非 liblib 域名：不误用，落到远端服务端抽帧', () => {
    expect(
      derivedVideoPoster({
        previewImageUrl: null,
        liblibSourceUrl: 'https://evil.example.com/a/clip.mp4',
        videoSource: 'https://cdn.example.com/a/clip.mp4',
      }),
    ).toContain('cdn.example.com/a/clip.mp4?x-oss-process=');
  });

  it('都没有：返回 null', () => {
    expect(
      derivedVideoPoster({
        previewImageUrl: null,
        liblibSourceUrl: null,
        videoSource: '/static/projects/p1/videos/clip.mp4',
      }),
    ).toBeNull();
    expect(derivedVideoPoster({})).toBeNull();
  });
});

describe('shouldSelfCaptureLodStill：封面优先、自截兜底', () => {
  it('已落库封面（previewImageUrl）：不自截', () => {
    expect(
      shouldSelfCaptureLodStill({
        previewImageUrl: '/static/projects/p1/freezone/poster.jpg',
        videoSource: '/static/projects/p1/videos/clip.mp4',
      }),
    ).toBe(false);
  });

  it('无落库封面但节点带 liblib sourceUrl：不自截（现算封面）', () => {
    expect(
      shouldSelfCaptureLodStill({
        previewImageUrl: null,
        liblibSourceUrl: 'https://libtv-res.liblib.art/a/clip.mp4',
        videoSource: '/static/projects/p1/videos/clip.mp4',
      }),
    ).toBe(false);
  });

  it('无封面但远端可服务端抽帧：不自截', () => {
    expect(
      shouldSelfCaptureLodStill({ videoSource: 'https://cdn.example.com/a/clip.mp4' }),
    ).toBe(false);
  });

  it('无封面且本地素材：必须自截', () => {
    expect(
      shouldSelfCaptureLodStill({ videoSource: '/static/projects/p1/videos/clip.mp4' }),
    ).toBe(true);
    expect(shouldSelfCaptureLodStill({ videoSource: 'blob:https://app/abc' })).toBe(true);
  });

  it('空白 previewImageUrl 视同没有封面', () => {
    expect(
      shouldSelfCaptureLodStill({
        previewImageUrl: '   ',
        videoSource: '/static/projects/p1/videos/clip.mp4',
      }),
    ).toBe(true);
  });

  it('既无封面也无视频源：自截（requestLodStill 内部对空值本就是 no-op）', () => {
    expect(shouldSelfCaptureLodStill({})).toBe(true);
  });
});

describe('getLodStill 的 getSnapshot 稳定性', () => {
  it('命中服务端抽帧：对同一 src 连续调用返回值相等', () => {
    // useSyncExternalStore 的 getSnapshot 必须稳定：字符串按值比较，值相等即可，
    // 否则 React 会无限重渲染。
    const src = 'https://cdn.example.com/a/clip.mp4';
    const a = getLodStill(src);
    const b = getLodStill(src);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it('未命中服务端抽帧（本地路径、尚未抓帧）：稳定返回 null', () => {
    const src = '/static/projects/p1/videos/never-captured.mp4';
    expect(getLodStill(src)).toBe(getLodStill(src));
    expect(getLodStill(src)).toBeNull();
  });

  it('空值返回 null', () => {
    expect(getLodStill(null)).toBeNull();
    expect(getLodStill(undefined)).toBeNull();
    expect(getLodStill('')).toBeNull();
  });
});
