// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import { buildAssetBoard, modelBadgeLabel } from '@/features/canvas/domain/assetBoard';
import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '@/features/canvas/domain/canvasNodes';

function node(id: string, type: string, data: Record<string, unknown>): CanvasNode {
  return { id, type, position: { x: 0, y: 0 }, data } as unknown as CanvasNode;
}

function edge(source: string, target: string): CanvasEdge {
  return { id: `${source}->${target}`, source, target } as CanvasEdge;
}

describe('buildAssetBoard', () => {
  it('把节点按媒介类型分进 text/image/video/audio 四桶，忽略分组等结构节点', () => {
    const board = buildAssetBoard(
      [
        node('t1', CANVAS_NODE_TYPES.textAnnotation, { content: '广告分镜脚本正文' }),
        node('i1', CANVAS_NODE_TYPES.imageGen, { imageUrl: '/static/i1.png' }),
        node('v1', CANVAS_NODE_TYPES.video, { videoUrl: '/static/v1.mp4' }),
        node('a1', CANVAS_NODE_TYPES.audio, { audioUrl: '/static/a1.mp3' }),
        node('g1', CANVAS_NODE_TYPES.group, { label: '组' }),
        node('s1', CANVAS_NODE_TYPES.skill, {}),
      ],
      [],
    );
    expect(board.text.map((i) => i.nodeId)).toEqual(['t1']);
    expect(board.image.map((i) => i.nodeId)).toEqual(['i1']);
    expect(board.video.map((i) => i.nodeId)).toEqual(['v1']);
    expect(board.audio.map((i) => i.nodeId)).toEqual(['a1']);
  });

  it('视频合成节点标记为成片(final)，普通视频节点为片段(clip)', () => {
    const board = buildAssetBoard(
      [
        node('vc', CANVAS_NODE_TYPES.videoCompose, { resultVideoUrl: '/static/final.mp4' }),
        node('v1', CANVAS_NODE_TYPES.video, { videoUrl: '/static/v1.mp4' }),
      ],
      [],
    );
    const roles = Object.fromEntries(board.video.map((i) => [i.nodeId, i.videoRole]));
    expect(roles).toEqual({ vc: 'final', v1: 'clip' });
  });

  it('徽标元数据：model / durationSec / widthPx / heightPx；音频 durationMs 换算成秒', () => {
    const board = buildAssetBoard(
      [
        node('v1', CANVAS_NODE_TYPES.video, {
          videoUrl: '/static/v1.mp4',
          model: 'wan2.5',
          durationSec: 5,
          widthPx: 720,
          heightPx: 1280,
        }),
        node('a1', CANVAS_NODE_TYPES.audio, { audioUrl: '/static/a1.mp3', durationMs: 101402 }),
      ],
      [],
    );
    const v = board.video[0];
    expect(v.model).toBe('wan2.5');
    expect(v.durationSec).toBe(5);
    expect(v.widthPx).toBe(720);
    expect(v.heightPx).toBe(1280);
    expect(board.audio[0].durationSec).toBe(101);
  });

  it('参考素材按连线顺序取上游、referenceOrder 可重排、无缩略图的上游被丢弃', () => {
    const nodes = [
      node('img-a', CANVAS_NODE_TYPES.imageGen, { imageUrl: '/static/a.png', displayName: '角色图A' }),
      node('img-b', CANVAS_NODE_TYPES.imageGen, { imageUrl: '/static/b.png', displayName: '道具图B' }),
      node('txt', CANVAS_NODE_TYPES.textAnnotation, { content: '纯文本上游，无缩略图' }),
      node('v1', CANVAS_NODE_TYPES.video, {
        videoUrl: '/static/v1.mp4',
        referenceOrder: ['img-b', 'img-a'],
      }),
    ];
    const edges = [edge('img-a', 'v1'), edge('img-b', 'v1'), edge('txt', 'v1')];
    const board = buildAssetBoard(nodes, edges);
    expect(board.video[0].references.map((r) => r.nodeId)).toEqual(['img-b', 'img-a']);
    expect(board.video[0].references.map((r) => r.label)).toEqual(['道具图B', '角色图A']);
  });

  it('自带参考图（imageGen 的 referenceImageUrl，无上游连线）纳入参考素材，排第 1、nodeId 为 null', () => {
    const board = buildAssetBoard(
      [
        node('gen', CANVAS_NODE_TYPES.imageGen, {
          imageUrl: '/static/gen.png',
          referenceImageUrl: '/static/own-ref.png',
        }),
      ],
      [],
    );
    const refs = board.image[0].references;
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ nodeId: null, thumbnailUrl: '/static/own-ref.png' });
    // 口径与 @图片N 一致：自带图作为一条独立参考出现，即便节点本体主图是生成结果。
    expect(refs[0].label).toBe('参考图');
  });

  it('自带参考图 + 上游图：自带图排第 1、上游按连线顺序顺延（口径同 orderedReferenceUrlsWithOwnFirst）', () => {
    const nodes = [
      node('up-a', CANVAS_NODE_TYPES.upload, { imageUrl: '/static/up-a.png', displayName: '上游A' }),
      node('up-b', CANVAS_NODE_TYPES.upload, { imageUrl: '/static/up-b.png', displayName: '上游B' }),
      node('gen', CANVAS_NODE_TYPES.imageGen, {
        imageUrl: '/static/gen.png',
        referenceImageUrl: '/static/own.png',
      }),
    ];
    const edges = [edge('up-a', 'gen'), edge('up-b', 'gen')];
    const board = buildAssetBoard(nodes, edges);
    const refs = board.image.find((i) => i.nodeId === 'gen')?.references ?? [];
    expect(refs.map((r) => r.thumbnailUrl)).toEqual([
      '/static/own.png',
      '/static/up-a.png',
      '/static/up-b.png',
    ]);
    expect(refs.map((r) => r.nodeId)).toEqual([null, 'up-a', 'up-b']);
  });

  it('自带参考图与某上游图 URL 相同 → 去重，只保留自带图那条（排第 1）', () => {
    const nodes = [
      node('up-same', CANVAS_NODE_TYPES.upload, { imageUrl: '/static/shared.png', displayName: '同图上游' }),
      node('up-other', CANVAS_NODE_TYPES.upload, { imageUrl: '/static/other.png', displayName: '另一上游' }),
      node('gen', CANVAS_NODE_TYPES.imageGen, {
        imageUrl: '/static/gen.png',
        referenceImageUrl: '/static/shared.png',
      }),
    ];
    const board = buildAssetBoard(nodes, [edge('up-same', 'gen'), edge('up-other', 'gen')]);
    const refs = board.image.find((i) => i.nodeId === 'gen')?.references ?? [];
    // shared.png 只出现一次（自带图那条），other.png 顺延。
    expect(refs.map((r) => r.thumbnailUrl)).toEqual(['/static/shared.png', '/static/other.png']);
    expect(refs.map((r) => r.nodeId)).toEqual([null, 'up-other']);
  });

  it('纯上游 imageGen（无自带参考图）参考素材保持不变（回归）', () => {
    const nodes = [
      node('up-a', CANVAS_NODE_TYPES.upload, { imageUrl: '/static/a.png', displayName: 'A' }),
      node('up-b', CANVAS_NODE_TYPES.upload, { imageUrl: '/static/b.png', displayName: 'B' }),
      node('gen', CANVAS_NODE_TYPES.imageGen, { imageUrl: '/static/gen.png' }),
    ];
    const board = buildAssetBoard(nodes, [edge('up-a', 'gen'), edge('up-b', 'gen')]);
    const refs = board.image.find((i) => i.nodeId === 'gen')?.references ?? [];
    expect(refs.map((r) => r.nodeId)).toEqual(['up-a', 'up-b']);
  });

  it('非 imageGen 节点的 referenceImageUrl 不进参考素材（自带参考图是 imageGen 专属概念）', () => {
    const board = buildAssetBoard(
      [
        node('up', CANVAS_NODE_TYPES.upload, {
          imageUrl: '/static/up.png',
          referenceImageUrl: '/static/should-not-appear.png',
        }),
      ],
      [],
    );
    expect(board.image[0].references).toEqual([]);
  });

  it('栏内按创建顺序（nodes 数组序）新→旧排列，最新建的节点在最上面', () => {
    const board = buildAssetBoard(
      [
        node('first', CANVAS_NODE_TYPES.imageGen, { imageUrl: '/static/first.png' }),
        node('second', CANVAS_NODE_TYPES.imageGen, { imageUrl: '/static/second.png' }),
        node('third', CANVAS_NODE_TYPES.imageGen, { imageUrl: '/static/third.png' }),
      ],
      [],
    );
    // addNode append 到末尾 → 数组序 first→second→third；倒序 = 最新建的 third 置顶。
    expect(board.image.map((i) => i.nodeId)).toEqual(['third', 'second', 'first']);
  });

  it('刚生成完（generationStartedAt 已清空、无 committed_at）的节点仍排在老节点上面', () => {
    const board = buildAssetBoard(
      [
        node('old-committed', CANVAS_NODE_TYPES.imageGen, {
          imageUrl: '/static/old.png',
          committed_at: '2026-07-01T00:00:00Z',
        }),
        // 后建的空节点里生成出图：完成后 generationStartedAt 被清成 null、也没有 committed_at。
        node('fresh-gen', CANVAS_NODE_TYPES.imageGen, { imageUrl: '/static/fresh.png' }),
      ],
      [],
    );
    // 时间戳排序会让 fresh-gen（无戳）沉底；改用创建顺序后，后建的 fresh-gen 置顶。
    expect(board.image.map((i) => i.nodeId)).toEqual(['fresh-gen', 'old-committed']);
  });

  it('keyElementCategory：从节点 data 读关键元素分类，合法值透传、非法/缺失为 null', () => {
    const board = buildAssetBoard(
      [
        node('tagged', CANVAS_NODE_TYPES.imageGen, {
          imageUrl: '/static/a.png',
          keyElementCategory: 'character',
        }),
        node('bad', CANVAS_NODE_TYPES.imageGen, {
          imageUrl: '/static/b.png',
          keyElementCategory: '乱填',
        }),
        node('untagged', CANVAS_NODE_TYPES.imageGen, { imageUrl: '/static/c.png' }),
      ],
      [],
    );
    const byId = Object.fromEntries(board.image.map((i) => [i.nodeId, i.keyElementCategory]));
    expect(byId.tagged).toBe('character');
    expect(byId.bad).toBeNull();
    expect(byId.untagged).toBeNull();
  });

  it('文本预览：content 截断 80 字；分镜表显示镜头数；标题走 resolveNodeDisplayName 默认名', () => {
    const long = 'x'.repeat(100);
    const board = buildAssetBoard(
      [
        node('t1', CANVAS_NODE_TYPES.textAnnotation, { content: long }),
        node('vs', CANVAS_NODE_TYPES.videoStory, { rows: [{}, {}, {}] }),
      ],
      [],
    );
    expect(board.text.find((i) => i.nodeId === 't1')?.textPreview).toBe(`${'x'.repeat(80)}…`);
    expect(board.text.find((i) => i.nodeId === 'vs')?.textPreview).toBe('分镜表 · 3 个镜头');
    expect(board.text.find((i) => i.nodeId === 't1')?.title).toBe('文本');
  });

  it('videoCompose 的 mediaUrl 回退到 resultVideoUrl', () => {
    const board = buildAssetBoard(
      [node('vc', CANVAS_NODE_TYPES.videoCompose, { resultVideoUrl: '/static/final.mp4' })],
      [],
    );
    expect(board.video.find((i) => i.nodeId === 'vc')?.mediaUrl).toBe('/static/final.mp4');
  });

  it('script 节点 textPreview 走 scriptTitle，无 scriptTitle 时回退 prompt', () => {
    const board = buildAssetBoard(
      [
        node('s-title', CANVAS_NODE_TYPES.script, { scriptTitle: '第一集：破晓', prompt: '写一个开场' }),
        node('s-prompt', CANVAS_NODE_TYPES.script, { prompt: '写一个结尾' }),
      ],
      [],
    );
    expect(board.text.find((i) => i.nodeId === 's-title')?.textPreview).toBe('第一集：破晓');
    expect(board.text.find((i) => i.nodeId === 's-prompt')?.textPreview).toBe('写一个结尾');
  });

  it('视频 durationSec 向下取整', () => {
    const board = buildAssetBoard(
      [node('v1', CANVAS_NODE_TYPES.video, { videoUrl: '/static/v1.mp4', durationSec: 5.9 })],
      [],
    );
    expect(board.video[0].durationSec).toBe(5);
  });

  it('isGenerating：isGenerating/isUploading/isAnalyzing 任一为真即进行中，Boolean 归一', () => {
    const board = buildAssetBoard(
      [
        node('gen', CANVAS_NODE_TYPES.imageGen, { imageUrl: null, isGenerating: true }),
        node('up', CANVAS_NODE_TYPES.video, { videoUrl: null, isUploading: true }),
        node('ana', CANVAS_NODE_TYPES.video, { videoUrl: '/static/v.mp4', isAnalyzing: 1 }),
      ],
      [],
    );
    expect(board.image.find((i) => i.nodeId === 'gen')?.isGenerating).toBe(true);
    expect(board.video.find((i) => i.nodeId === 'up')?.isGenerating).toBe(true);
    // 非布尔 truthy 值被 Boolean() 归一成 true（而非透传原值）。
    expect(board.video.find((i) => i.nodeId === 'ana')?.isGenerating).toBe(true);
  });

  it('generationError 回退链：generationError ?? analysisError ?? uploadError', () => {
    const board = buildAssetBoard(
      [
        node('e1', CANVAS_NODE_TYPES.video, {
          videoUrl: null,
          generationError: '生成失败',
          analysisError: '解析失败',
          uploadError: '上传失败',
        }),
        node('e2', CANVAS_NODE_TYPES.video, { videoUrl: null, analysisError: '解析失败' }),
        node('e3', CANVAS_NODE_TYPES.upload, { imageUrl: null, uploadError: '上传失败' }),
      ],
      [],
    );
    expect(board.video.find((i) => i.nodeId === 'e1')?.generationError).toBe('生成失败');
    expect(board.video.find((i) => i.nodeId === 'e2')?.generationError).toBe('解析失败');
    expect(board.image.find((i) => i.nodeId === 'e3')?.generationError).toBe('上传失败');
  });

  it('无任何进行中/失败标记时 isGenerating=false、generationError=null（空串错误视同无）', () => {
    const board = buildAssetBoard(
      [
        node('idle', CANVAS_NODE_TYPES.imageGen, { imageUrl: '/static/i.png' }),
        node('blank', CANVAS_NODE_TYPES.imageGen, { imageUrl: '/static/j.png', generationError: '  ' }),
      ],
      [],
    );
    expect(board.image.find((i) => i.nodeId === 'idle')?.isGenerating).toBe(false);
    expect(board.image.find((i) => i.nodeId === 'idle')?.generationError).toBeNull();
    expect(board.image.find((i) => i.nodeId === 'blank')?.generationError).toBeNull();
  });

  it('generationStartedAt：数字原样透传，非数字/缺失归一成 null（卡片进度估算的输入）', () => {
    const board = buildAssetBoard(
      [
        node('gen', CANVAS_NODE_TYPES.imageGen, {
          imageUrl: null,
          isGenerating: true,
          generationStartedAt: 1700000000000,
        }),
        node('idle', CANVAS_NODE_TYPES.imageGen, { imageUrl: '/static/i.png' }),
        node('bad', CANVAS_NODE_TYPES.imageGen, {
          imageUrl: null,
          isGenerating: true,
          generationStartedAt: '2026-01-01T00:00:00Z',
        }),
      ],
      [],
    );
    expect(board.image.find((i) => i.nodeId === 'gen')?.generationStartedAt).toBe(1700000000000);
    expect(board.image.find((i) => i.nodeId === 'idle')?.generationStartedAt).toBeNull();
    expect(board.image.find((i) => i.nodeId === 'bad')?.generationStartedAt).toBeNull();
  });
});

describe('modelBadgeLabel', () => {
  it('剥掉渠道前缀，只留模型名', () => {
    expect(modelBadgeLabel('newapi_seedance-2.0-value')).toBe('seedance-2.0-value');
    expect(modelBadgeLabel('newapi_happyhorse-1.0')).toBe('happyhorse-1.0');
  });

  it('没有前缀 / 前缀畸形的 id 原样返回（不吞成空串）', () => {
    expect(modelBadgeLabel('wan2.5')).toBe('wan2.5');
    expect(modelBadgeLabel('_leading')).toBe('_leading');
    expect(modelBadgeLabel('trailing_')).toBe('trailing_');
  });
});
