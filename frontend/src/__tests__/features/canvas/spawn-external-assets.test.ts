// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from 'vitest';

import {
  EXTERNAL_ASSET_GROUP_LABEL,
  spawnExternalAssetNodes,
  type SpawnExternalAssetsDeps,
} from '@/features/canvas/application/spawnExternalAssets';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';

const TARGET = { id: 'video-1', position: { x: 1000, y: 500 }, height: 380 };

function makeFile(name: string, type: string): File {
  return new File(['x'], name, { type });
}

/** 假依赖。schedule 同步执行,好让投递在函数返回前就完成、便于断言。 */
function makeDeps() {
  let seq = 0;
  const addNode = vi.fn<SpawnExternalAssetsDeps['addNode']>(() => `up-${seq++}`);
  const addEdge = vi.fn<SpawnExternalAssetsDeps['addEdge']>(() => 'edge-1');
  const publish = vi.fn<SpawnExternalAssetsDeps['publish']>();
  const autoGroupSpawn = vi.fn<SpawnExternalAssetsDeps['autoGroupSpawn']>(() => 'group-1');
  const deps: SpawnExternalAssetsDeps = {
    addNode,
    addEdge,
    publish,
    autoGroupSpawn,
    schedule: (fn) => fn(),
  };
  return { deps, addNode, addEdge, publish, autoGroupSpawn };
}

describe('spawnExternalAssetNodes', () => {
  it('图片/视频/音频一律先落成 upload 节点,由 UploadNode 自行分流', () => {
    const { deps, addNode } = makeDeps();
    const files = [
      makeFile('a.png', 'image/png'),
      makeFile('b.mp4', 'video/mp4'),
      makeFile('c.mp3', 'audio/mpeg'),
    ];

    spawnExternalAssetNodes(TARGET, files, deps);

    expect(addNode).toHaveBeenCalledTimes(3);
    for (const call of addNode.mock.calls) {
      expect(call[0]).toBe(CANVAS_NODE_TYPES.upload);
      // 唯一允许出现的 data 字段是 user_spawned(否则新节点会被
      // NodeActionToolbar 当成系统节点锁死)。imageOnly 会让 UploadNode 拒收
      // 音视频,displayName 会顶掉「用上传文件名作节点标题」——两者、以及任何
      // 其它未预期字段都不该出现。
      expect(call[2]).toEqual({ user_spawned: true });
    }
  });

  it('非媒体文件被挡在建节点之前,不留空节点', () => {
    const { deps, addNode, addEdge, publish } = makeDeps();
    const files = [
      new File(['x'], 'doc.pdf', { type: 'application/pdf' }),
      makeFile('a.png', 'image/png'),
    ];

    const ids = spawnExternalAssetNodes(TARGET, files, deps);

    // 只有图片那个进来了。UploadNode 对非媒体文件是静默 return,放进来就会留下
    // 一个连着线却永远空着的节点。
    expect(ids).toEqual(['up-0']);
    expect(addNode).toHaveBeenCalledOnce();
    expect(addEdge).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
  });

  it('.mxf 这类 MIME 为空串的专业容器仍然收下', () => {
    const { deps, addNode } = makeDeps();

    spawnExternalAssetNodes(TARGET, [new File(['x'], 'clip.mxf', { type: '' })], deps);

    expect(addNode).toHaveBeenCalledOnce();
  });

  it('每个新节点连一条指向目标节点的边,方向为 新节点 → 目标', () => {
    const { deps, addEdge } = makeDeps();

    spawnExternalAssetNodes(TARGET, [makeFile('a.png', 'image/png')], deps);

    expect(addEdge).toHaveBeenCalledExactlyOnceWith('up-0', 'video-1');
  });

  it('把原 File 对象投给对应的新节点', () => {
    const { deps, publish } = makeDeps();
    const file = makeFile('a.png', 'image/png');

    const ids = spawnExternalAssetNodes(TARGET, [file], deps);

    expect(ids).toEqual(['up-0']);
    expect(publish).toHaveBeenCalledExactlyOnceWith('upload-node/external-file', {
      nodeId: 'up-0',
      file,
    });
  });

  it('多文件时每个节点各收到自己的那个文件、各连自己的边', () => {
    const { deps, addEdge, publish } = makeDeps();
    const files = [makeFile('a.png', 'image/png'), makeFile('b.mp4', 'video/mp4')];

    spawnExternalAssetNodes(TARGET, files, deps);

    // 把 file 写成 files[0]、或把 nodeId 提到循环外,都会让这条断言炸——单文件
    // 用例测不出这两种回归。
    expect(addEdge.mock.calls).toEqual([
      ['up-0', 'video-1'],
      ['up-1', 'video-1'],
    ]);
    expect(publish.mock.calls.map((c) => [c[1].nodeId, c[1].file])).toEqual([
      ['up-0', files[0]],
      ['up-1', files[1]],
    ]);
  });

  it('投递发生时边已经连好了,变形才有边可继承', () => {
    const { deps, addEdge } = makeDeps();
    const scheduled: Array<() => void> = [];
    deps.schedule = (fn) => {
      scheduled.push(fn);
    };

    spawnExternalAssetNodes(TARGET, [makeFile('a.mp4', 'video/mp4')], deps);

    expect(addEdge).toHaveBeenCalledOnce(); // 还没投递,边就已经在了
    scheduled.forEach((fn) => fn());
  });

  it('投递被推迟到调度器里,等新节点挂载并订阅', () => {
    const { deps, publish } = makeDeps();
    const scheduled: Array<() => void> = [];
    deps.schedule = (fn) => {
      scheduled.push(fn);
    };

    spawnExternalAssetNodes(TARGET, [makeFile('a.png', 'image/png')], deps);

    // 还没跑调度器 → 一个事件都不该发出去。
    expect(publish).not.toHaveBeenCalled();
    scheduled.forEach((fn) => fn());
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe('EXTERNAL_ASSET_GROUP_LABEL', () => {
  it('与资产库的编组标签区分开', () => {
    expect(EXTERNAL_ASSET_GROUP_LABEL).not.toBe('资产参考组');
  });
});
