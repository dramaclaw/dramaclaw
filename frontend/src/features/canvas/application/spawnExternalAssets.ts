// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  CANVAS_NODE_TYPES,
  type CanvasNodeData,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';

/** 与资产库 spawn 同一套名义尺寸(VideoNode.tsx:1575-1578)。 */
const UPLOAD_WIDTH = 320;
const GAP_X = 40;

/** 与资产库的「资产参考组」区分来源。 */
export const EXTERNAL_ASSET_GROUP_LABEL = '外部素材组';

export interface SpawnExternalAssetsTarget {
  id: string;
  position: { x: number; y: number };
  height?: number;
}

export interface SpawnExternalAssetsDeps {
  addNode: (
    type: CanvasNodeType,
    position: { x: number; y: number },
    data?: Partial<CanvasNodeData>,
  ) => string;
  addEdge: (source: string, target: string) => string | null;
  publish: (
    type: 'upload-node/external-file',
    payload: { nodeId: string; file: File },
  ) => void;
  autoGroupSpawn: (
    sourceNodeId: string,
    spawnedNodeIds: string[],
    opts?: { label?: string },
  ) => string | null;
  /** 默认 requestAnimationFrame;测试注入同步执行。 */
  schedule?: (fn: () => void) => void;
}

/**
 * 把本地选中的外部文件接成目标节点的上游素材。
 *
 * 每个文件先落成 upload 节点并连边,再把 File 投给它 —— UploadNode 自己按 MIME
 * 分流:图片留在 upload 节点,视频/音频走 convertNodeType 原地变形成 video/audio
 * 节点。变形不换 id,所以先连的边不会丢。
 *
 * 不传 imageOnly(会让 UploadNode 拒收音视频)、不传 displayName(会顶掉
 * 「用上传文件名作节点标题」的默认行为),只传 user_spawned:true(否则新节点
 * 会被 NodeActionToolbar 当成系统节点锁死)。
 *
 * 投递必须延后一帧(经 schedule 注入),否则新节点还没挂载订阅,事件会被
 * canvasEventBus 的无重放语义直接丢掉。
 *
 * 本函数只做单文件路径:所有新节点暂时叠在同一个 y,也不调用 autoGroupSpawn。
 * 垂直排布与自动编组留给后续任务由测试驱动补上。
 */
export function spawnExternalAssetNodes(
  target: SpawnExternalAssetsTarget,
  files: readonly File[],
  deps: SpawnExternalAssetsDeps,
): string[] {
  const schedule =
    deps.schedule ?? ((fn: () => void) => { requestAnimationFrame(fn); });

  const newIds: string[] = [];
  files.forEach((file) => {
    const nodeId = deps.addNode(
      CANVAS_NODE_TYPES.upload,
      { x: target.position.x - UPLOAD_WIDTH - GAP_X, y: target.position.y },
      { user_spawned: true } as Partial<CanvasNodeData>,
    );
    deps.addEdge(nodeId, target.id);
    schedule(() => {
      deps.publish('upload-node/external-file', { nodeId, file });
    });
    newIds.push(nodeId);
  });

  return newIds;
}
