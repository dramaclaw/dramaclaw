// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  collectReferenceCandidates,
  collectReferencePickTargets,
  supportsReferencePick,
} from '@/features/canvas/application/referencePick';
import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';

function node(
  id: string,
  type: CanvasNodeType,
  data: Record<string, unknown> = {},
): CanvasNode {
  return { id, type, position: { x: 0, y: 0 }, data } as unknown as CanvasNode;
}

const TARGET_IMAGE = node('target-image', CANVAS_NODE_TYPES.imageGen);
const TARGET_VIDEO = node('target-video', CANVAS_NODE_TYPES.video);

describe('reference pick candidates', () => {
  it('只给图片 / 视频节点开放 ＋参考 入口', () => {
    expect(supportsReferencePick(CANVAS_NODE_TYPES.imageGen)).toBe(true);
    expect(supportsReferencePick(CANVAS_NODE_TYPES.video)).toBe(true);
    expect(supportsReferencePick(CANVAS_NODE_TYPES.audio)).toBe(false);
    expect(supportsReferencePick(CANVAS_NODE_TYPES.textAnnotation)).toBe(false);
    expect(supportsReferencePick(undefined)).toBe(false);
  });

  it('图片节点只收图片和文本', () => {
    const nodes = [
      TARGET_IMAGE,
      node('text', CANVAS_NODE_TYPES.textAnnotation, { content: '一段描述' }),
      node('image', CANVAS_NODE_TYPES.imageGen, { imageUrl: 'https://x/a.png' }),
      node('video', CANVAS_NODE_TYPES.video, { videoUrl: 'https://x/a.mp4' }),
      node('audio', CANVAS_NODE_TYPES.audio, { audioUrl: 'https://x/a.mp3' }),
    ];

    const candidates = collectReferenceCandidates(
      nodes,
      TARGET_IMAGE.id,
      CANVAS_NODE_TYPES.imageGen,
    );

    expect([...candidates.keys()].sort()).toEqual(['image', 'text']);
  });

  it('视频节点收图片、视频、音频和文本', () => {
    const nodes = [
      TARGET_VIDEO,
      node('text', CANVAS_NODE_TYPES.textAnnotation, { content: '一段描述' }),
      node('image', CANVAS_NODE_TYPES.imageGen, { imageUrl: 'https://x/a.png' }),
      node('video', CANVAS_NODE_TYPES.video, { videoUrl: 'https://x/a.mp4' }),
      node('audio', CANVAS_NODE_TYPES.audio, { audioUrl: 'https://x/a.mp3' }),
    ];

    const candidates = collectReferenceCandidates(
      nodes,
      TARGET_VIDEO.id,
      CANVAS_NODE_TYPES.video,
    );

    expect([...candidates.keys()].sort()).toEqual(['audio', 'image', 'text', 'video']);
  });

  it('自己不能参考自己', () => {
    const candidates = collectReferenceCandidates(
      [TARGET_IMAGE],
      TARGET_IMAGE.id,
      CANVAS_NODE_TYPES.imageGen,
    );

    expect(candidates.size).toBe(0);
  });

  it('还没有内容的节点按类型判定，不会从候选里消失', () => {
    const nodes = [
      TARGET_IMAGE,
      node('empty-text', CANVAS_NODE_TYPES.textAnnotation, { content: '' }),
      node('empty-image', CANVAS_NODE_TYPES.imageGen),
    ];

    const candidates = collectReferenceCandidates(
      nodes,
      TARGET_IMAGE.id,
      CANVAS_NODE_TYPES.imageGen,
    );

    expect([...candidates.keys()].sort()).toEqual(['empty-image', 'empty-text']);
  });

  it('上传节点按它实际装的东西判定：只有装图片的能进图片节点候选', () => {
    const uploadVideo = node('upload-video', CANVAS_NODE_TYPES.upload, {
      videoUrl: 'https://x/a.mp4',
    });
    const uploadImage = node('upload-image', CANVAS_NODE_TYPES.upload, {
      imageUrl: 'https://x/a.png',
    });

    expect(
      [
        ...collectReferenceCandidates(
          [TARGET_IMAGE, uploadVideo, uploadImage],
          TARGET_IMAGE.id,
          CANVAS_NODE_TYPES.imageGen,
        ).keys(),
      ].sort(),
    ).toEqual(['upload-image', 'upload-video']);
  });

  it('系统专用边不进候选：风格节点不能手工连进图片节点', () => {
    const candidates = collectReferenceCandidates(
      [TARGET_IMAGE, node('style', CANVAS_NODE_TYPES.style, {})],
      TARGET_IMAGE.id,
      CANVAS_NODE_TYPES.imageGen,
    );

    expect(candidates.has('style')).toBe(false);
  });

  it('候选带上节点显示名，供「选择 xxx」提示使用', () => {
    const candidates = collectReferenceCandidates(
      [
        TARGET_IMAGE,
        node('named', CANVAS_NODE_TYPES.textAnnotation, {
          content: 'x',
          displayName: 'S09｜近景·正面',
        }),
        node('unnamed', CANVAS_NODE_TYPES.textAnnotation, { content: 'x' }),
      ],
      TARGET_IMAGE.id,
      CANVAS_NODE_TYPES.imageGen,
    );

    expect(candidates.get('named')?.label).toBe('S09｜近景·正面');
    expect(candidates.get('unnamed')?.label).toBe('文本');
  });
});

describe('reference pick rejections', () => {
  it('图片节点面对视频 / 音频节点给出可解释的拒绝，而不是静默消失', () => {
    const { candidates, rejections } = collectReferencePickTargets(
      [
        TARGET_IMAGE,
        node('image', CANVAS_NODE_TYPES.imageGen, { imageUrl: 'https://x/a.png' }),
        node('video', CANVAS_NODE_TYPES.video, { videoUrl: 'https://x/a.mp4' }),
        node('audio', CANVAS_NODE_TYPES.audio, { audioUrl: 'https://x/a.mp3' }),
      ],
      TARGET_IMAGE.id,
      CANVAS_NODE_TYPES.imageGen,
    );

    expect([...candidates.keys()]).toEqual(['image']);
    expect(rejections.get('video')).toBe('视频暂不支持作为参考');
    expect(rejections.get('audio')).toBe('音频暂不支持作为参考');
  });

  it('视频节点全收，所以没有任何拒绝', () => {
    const { rejections } = collectReferencePickTargets(
      [
        TARGET_VIDEO,
        node('image', CANVAS_NODE_TYPES.imageGen, { imageUrl: 'https://x/a.png' }),
        node('video', CANVAS_NODE_TYPES.video, { videoUrl: 'https://x/a.mp4' }),
        node('audio', CANVAS_NODE_TYPES.audio, { audioUrl: 'https://x/a.mp3' }),
      ],
      TARGET_VIDEO.id,
      CANVAS_NODE_TYPES.video,
    );

    expect(rejections.size).toBe(0);
  });

  it('说不出种类的节点给通用文案，分组节点则完全不盖遮罩', () => {
    const { candidates, rejections } = collectReferencePickTargets(
      [
        TARGET_IMAGE,
        node('style', CANVAS_NODE_TYPES.style, {}),
        node('group', CANVAS_NODE_TYPES.group, {}),
      ],
      TARGET_IMAGE.id,
      CANVAS_NODE_TYPES.imageGen,
    );

    expect(candidates.size).toBe(0);
    expect(rejections.get('style')).toBe('这个节点不能作为参考');
    expect(rejections.has('group')).toBe(false);
  });

  it('自己不进拒绝表', () => {
    const { rejections } = collectReferencePickTargets(
      [node('target-video', CANVAS_NODE_TYPES.video, { videoUrl: 'https://x/a.mp4' })],
      'target-video',
      CANVAS_NODE_TYPES.imageGen,
    );

    expect(rejections.size).toBe(0);
  });
});
