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
      // 主线预设画布上不带这个标记的新节点会被 NodeActionToolbar 锁死。
      expect(call[2]).toMatchObject({ user_spawned: true });
      // imageOnly 会让 UploadNode 拒收音视频。
      expect(call[2]).not.toHaveProperty('imageOnly');
      // displayName 会顶掉「用上传文件名作节点标题」。
      expect(call[2]).not.toHaveProperty('displayName');
    }
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

  it('先连边再投递,因为变形是原地改类型、要靠既有边存活', () => {
    const order: string[] = [];
    const { deps, addEdge, publish } = makeDeps();
    addEdge.mockImplementation(() => {
      order.push('addEdge');
      return 'edge-1';
    });
    publish.mockImplementation(() => {
      order.push('publish');
    });

    spawnExternalAssetNodes(TARGET, [makeFile('a.mp4', 'video/mp4')], deps);

    expect(order).toEqual(['addEdge', 'publish']);
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
    expect(EXTERNAL_ASSET_GROUP_LABEL).toBe('外部素材组');
  });
});
