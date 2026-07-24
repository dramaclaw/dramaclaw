// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  CANVAS_NODE_TYPES,
  type CanvasNodeData,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';
import { isSupportedMediaFile } from '@/features/canvas/application/videoFileTypes';
import type { CanvasEventMap } from '@/features/canvas/application/ports';

/** 与 VideoNode 的 spawnCharacterLibraryReferences 同一套名义尺寸。 */
const UPLOAD_WIDTH = 320;
const GAP_X = 40;

/** 与资产库的「资产参考组」区分来源。 */
export const EXTERNAL_ASSET_GROUP_LABEL = '外部素材组';

export interface SpawnExternalAssetsTarget {
  id: string;
  position: { x: number; y: number };
  /** Task 2 起用于垂直居中多节点排布。 */
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
    payload: CanvasEventMap['upload-node/external-file'],
  ) => void;
  /** Task 2 起用于自动编组。 */
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
 * 本模块形状上像「从已有节点派生新节点」,但语义上是全新导入的外部素材、没有
 * provenance 可继承,所以故意不走 domain/inheritMainlineFields.ts —— 那条 helper
 * 是给「从已有节点/记录派生」的路径准备的,走它会把 slot_target 之类的血统字段
 * 错误地继承进来。手写 user_spawned 与 Canvas.tsx 落文件、assetDrag.ts 同构。
 *
 * 投递必须延后一帧(经 schedule 注入),否则新节点还没挂载订阅,事件会被
 * canvasEventBus 的无重放语义直接丢掉。
 *
 * 尚未做垂直排布与编组:多文件会全部叠在同一个 y。留给后续任务由测试驱动补上。
 */
export function spawnExternalAssetNodes(
  target: SpawnExternalAssetsTarget,
  files: readonly File[],
  deps: SpawnExternalAssetsDeps,
): string[] {
  // 非媒体文件必须先在这里挡掉:UploadNode.handleMediaFile 对既非图片、也非
  // 视频/音频的文件是静默 return(没有 else 分支),放进来就会留下一个连着线
  // 却永远空着的 upload 节点。
  //
  // 顺序要求:这一步必须在函数里任何「短路」之前跑。以后如果要加「空列表/空
  // 选择直接返回 []」之类的早退,那个判断必须落在 accepted 算出来之后 —— 否则
  // 「选中的全是非媒体文件」这种情况会绕开短路、把这个洞重新放回来。
  const accepted = files.filter(isSupportedMediaFile);

  const schedule =
    deps.schedule ?? ((fn: () => void) => { requestAnimationFrame(fn); });

  const newIds: string[] = [];
  accepted.forEach((file) => {
    const nodeId = deps.addNode(
      CANVAS_NODE_TYPES.upload,
      { x: target.position.x - UPLOAD_WIDTH - GAP_X, y: target.position.y },
      { user_spawned: true } as Partial<CanvasNodeData>,
    );
    const edgeId = deps.addEdge(nodeId, target.id);
    if (edgeId === null) {
      // 节点建好了、线没连上、文件还是会照投——这是最难排查的静默失败,先打
      // 一句警告。口径参照 UploadNode.tsx 的 `[upload-node] …`。
      console.warn(
        `[spawn-external-assets] addEdge(${nodeId} -> ${target.id}) returned null; node created without an edge`,
      );
    }
    schedule(() => {
      deps.publish('upload-node/external-file', { nodeId, file });
    });
    newIds.push(nodeId);
  });

  return newIds;
}
