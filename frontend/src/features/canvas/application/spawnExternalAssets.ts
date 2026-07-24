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
const UPLOAD_HEIGHT = 240;
const GAP_X = 40;
const GAP_Y = 24;

/** 对齐 VideoNode.tsx 的 DEFAULT_HEIGHT,target 没给 height 时的兜底值。 */
const FALLBACK_TARGET_HEIGHT = 380;

/** 与资产库的「资产参考组」区分来源。 */
export const EXTERNAL_ASSET_GROUP_LABEL = '外部素材组';

export interface SpawnExternalAssetsTarget {
  id: string;
  position: { x: number; y: number };
  /** 用于让竖排的素材节点与目标节点垂直居中;缺省或 0 时按 380 兜底。 */
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
  /** 用于把新建的素材节点自动编成一组。 */
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
 * 「用上传文件名作节点标题」的默认行为),只传 user_spawned:true —— 它是
 * nodeMainlineFlags 的分类依据,也是后端 _merge_restored_preset_canvas
 * (freezone.py 的 _is_replaceable_projection_node)判断「刷新预设画布时别覆盖
 * 这个节点」的依据。
 *
 * 别照抄 Canvas.tsx 落文件处那句「不传就会被 NodeActionToolbar 的 canvas 级兜底
 * 锁死」—— 那个兜底已经没了。NodeActionToolbar.tsx:1043 起 isPresetLocked 只看
 * isPresetManaged,不带任何标记的 {} 节点判定为 ordinary、不锁(有测试钉着:
 * system-managed-node-data.test.ts 的 isSystemManagedNodeData({}) === false)。
 *
 * target 是调用方传入的快照,函数内部不现读 store —— 调用方必须在调用那一刻从
 * store 取最新的 position/height,别塞一个可能过期的闭包值。
 *
 * 本模块形状上像「从已有节点派生新节点」,但语义上是全新导入的外部素材、没有
 * provenance 可继承,所以故意不走 domain/inheritMainlineFields.ts —— 那条 helper
 * 是给「从已有节点/记录派生」的路径准备的,走它会把 slot_target 之类的血统字段
 * 错误地继承进来。手写 user_spawned 与 Canvas.tsx 落文件、assetDrag.ts 同构。
 *
 * 投递必须延后一帧(经 schedule 注入),否则新节点还没挂载订阅,事件会被
 * canvasEventBus 的无重放语义直接丢掉。
 *
 * 多文件竖直排布、与目标节点垂直居中,口径对齐 VideoNode.tsx 的
 * spawnCharacterLibraryReferences:同一套 UPLOAD_WIDTH/UPLOAD_HEIGHT/GAP_X/GAP_Y,
 * 目标节点没给 height 时按 FALLBACK_TARGET_HEIGHT(=VideoNode 的 DEFAULT_HEIGHT)
 * 兜底。新建的节点最后会被 autoGroupSpawn 编成一组。
 */
export function spawnExternalAssetNodes(
  target: SpawnExternalAssetsTarget,
  files: readonly File[],
  deps: SpawnExternalAssetsDeps,
): string[] {
  // 非媒体文件必须先在这里挡掉:UploadNode.handleMediaFile 对既非图片、也非
  // 视频/音频的文件是静默 return(没有 else 分支),放进来就会留下一个连着线
  // 却永远空着的 upload 节点。
  const accepted = files.filter(isSupportedMediaFile);

  // 短路必须落在 accepted 算出来之后、判断 accepted.length —— 如果改成在过滤
  // 之前判断 files.length,「选中的全是非媒体文件」这种情况会绕开短路、走到底,
  // 然后 autoGroupSpawn(target.id, []) 编出一个空组。
  if (accepted.length === 0) return [];

  const schedule =
    deps.schedule ?? ((fn: () => void) => { requestAnimationFrame(fn); });

  const baseX = target.position.x - UPLOAD_WIDTH - GAP_X;
  const totalH =
    UPLOAD_HEIGHT * accepted.length + GAP_Y * (accepted.length - 1);
  // 用 || 而不是 ??:0 和 NaN 也该走兜底。参照实现写的是 ??,那样 height 为 0 时
  // 会按 0 高度居中、把整组往上推出目标节点范围 —— 这个洞不跟。
  const startY =
    target.position.y + ((target.height || FALLBACK_TARGET_HEIGHT) - totalH) / 2;

  const newIds: string[] = [];
  accepted.forEach((file, idx) => {
    const y = startY + idx * (UPLOAD_HEIGHT + GAP_Y);
    const nodeId = deps.addNode(
      CANVAS_NODE_TYPES.upload,
      { x: baseX, y },
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

  deps.autoGroupSpawn(target.id, newIds, { label: EXTERNAL_ASSET_GROUP_LABEL });

  return newIds;
}
