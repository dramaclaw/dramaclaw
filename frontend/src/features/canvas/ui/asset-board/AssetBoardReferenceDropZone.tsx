// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useCallback,
  useRef,
  useState,
  type DragEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

import { useCanvasStore } from '@/stores/canvasStore';

import {
  hasBoardReferenceDrag,
  readBoardReferenceDragPayload,
} from './boardReferenceDrag';

/** 拖拽悬停时 drop 区的提示文案（对齐参考图 58 的占位文案）。 */
export const REFERENCE_DROP_HINT_TEXT = '可将资产、图片、视频拖拽到此，添加为参考';

/**
 * 故事板详情里包住「图片/视频生成表单」的一层放置区：把左列表拖来的**既有节点卡片**
 * 落成当前详情节点的一条上游引用连线（`addEdge(拖入节点 → 当前节点)`），回流后由
 * 表单既有的 `useUpstreamContents` 派生渲染成参考缩略图 chip——与工作流「手动连线加
 * 引用」完全同口径，不改共用表单、不新增 store 语义。
 *
 * 为什么在宿主包一层、而不是把 drop 加进共用 `ImageGenerationForm`：
 * - 共用表单被工作流的 ImageGenNode 复用，给它加 drop 会波及工作流；
 * - 表单参考区的引用本就来自上游边，这里在宿主侧调同一个 `addEdge` 即可，表单零改动。
 *
 * DnD 逻辑全挂在外层 `relative` 容器上（不在覆盖层）：高亮覆盖层 `pointer-events-none`
 * 纯做视觉，drop 事件照常冒泡到容器统一处理，容器 `preventDefault` 顺带取消
 * contenteditable 提示词框的默认文本插入。
 */
export function AssetBoardReferenceDropZone({
  nodeId,
  children,
}: {
  nodeId: string;
  children: ReactNode;
}): ReactElement {
  const [isDragActive, setIsDragActive] = useState(false);
  // 嵌套子元素会各自冒泡 dragenter/dragleave，用进出计数消抖，避免划过内部元素时闪烁。
  const depthRef = useRef(0);

  const handleDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasBoardReferenceDrag(event.dataTransfer)) return;
    event.preventDefault();
    depthRef.current += 1;
    setIsDragActive(true);
  }, []);

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasBoardReferenceDrag(event.dataTransfer)) return;
    // preventDefault 才能让本容器成为合法放置目标（并接管冒泡上来的子元素 drop）。
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!hasBoardReferenceDrag(event.dataTransfer)) return;
    depthRef.current = Math.max(0, depthRef.current - 1);
    if (depthRef.current === 0) setIsDragActive(false);
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!hasBoardReferenceDrag(event.dataTransfer)) return;
      event.preventDefault();
      depthRef.current = 0;
      setIsDragActive(false);
      const payload = readBoardReferenceDragPayload(event.dataTransfer);
      if (!payload) return;
      // 把当前详情节点自己的卡片拖进自己的表单 → 忽略，不建自环边。
      if (payload.nodeId === nodeId) return;
      // 复用工作流那份建边规则：addEdge 内部做节点存在性 / 连接类型校验，并按确定性
      // id `e-source-target` 去重——重复拖同一节点不会产生第二条边（幂等）。
      useCanvasStore.getState().addEdge(payload.nodeId, nodeId);
    },
    [nodeId],
  );

  return (
    <div
      className="relative"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {children}
      {isDragActive && (
        <div
          role="status"
          aria-label={REFERENCE_DROP_HINT_TEXT}
          className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-[var(--node-radius)] border-2 border-dashed border-primary/70 bg-[#262626]/85 px-4 text-center text-[13px] font-medium text-white/85"
        >
          {REFERENCE_DROP_HINT_TEXT}
        </div>
      )}
    </div>
  );
}
