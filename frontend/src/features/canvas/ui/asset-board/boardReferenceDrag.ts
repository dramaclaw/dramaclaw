// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 故事板左列表卡片 →（详情里）生成表单参考区的拖拽 MIME。
 *
 * 用专属类型而非 text/plain 或工作流的 `CANVAS_ASSET_DRAG_MIME`：
 * - 与系统文件 / 纯文本拖放互不误伤；
 * - 与工作流「侧栏素材拖进画布新建节点」的 payload 区分——那份带 url、落点会
 *   `spawnAssetNode` 新建一个节点；本 payload 只带一个**既有节点 id**，落在详情
 *   表单参考区时语义是「给当前详情节点加一条上游引用连线」(addEdge)，不新建任何节点。
 */
export const BOARD_REFERENCE_DRAG_MIME = 'application/x-freezone-board-ref';

export interface BoardReferenceDragPayload {
  /** 被拖拽卡片对应的既有画布节点 id（作为上游源接入当前详情节点）。 */
  nodeId: string;
}

/** 把「引用某既有节点」序列化进 dataTransfer（拖拽源 = 左列表卡片）。 */
export function writeBoardReferenceDragPayload(
  dataTransfer: DataTransfer,
  payload: BoardReferenceDragPayload,
): void {
  dataTransfer.setData(BOARD_REFERENCE_DRAG_MIME, JSON.stringify(payload));
  dataTransfer.effectAllowed = 'copy';
}

/** 从 dataTransfer 解析引用拖拽 payload；非本类拖拽或缺 nodeId 返回 null。 */
export function readBoardReferenceDragPayload(
  dataTransfer: DataTransfer,
): BoardReferenceDragPayload | null {
  const raw = dataTransfer.getData(BOARD_REFERENCE_DRAG_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as BoardReferenceDragPayload;
    if (!parsed || typeof parsed.nodeId !== 'string' || !parsed.nodeId) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 拖拽过程中（dragenter / dragover）判断这是否是一次「引用拖拽」。
 * 注意：dragover 阶段浏览器不允许读 getData，只能看 `types`，故用它做高亮门控。
 */
export function hasBoardReferenceDrag(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types ?? []).includes(BOARD_REFERENCE_DRAG_MIME);
}
