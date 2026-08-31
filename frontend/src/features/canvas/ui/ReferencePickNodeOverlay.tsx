// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 拾取参考时盖在节点上的遮罩，三种形态：
 * - 可选：hover 出「选择 xxx」，已经连上的出「取消选择」；
 * - 连得上但种类不收（图片节点面对视频 / 音频节点）：整块调暗、光标 not-allowed，
 *   hover 出原因，让「点了没反应」变成「为什么不能点」；
 * - 其余节点（没有输出桩、系统专用边）：不画遮罩，否则整张画布糊成一片。
 *
 * 为什么盖在节点里（withLodShell 注入）而不是画布层的绝对定位：节点可能在分组
 * 里、可能任意缩放，画布层要自己算 positionAbsolute × zoom 才能对齐；而
 * `.react-flow__node` 本身就是定位元素，`inset-0` 天然就是这个节点的盒子。
 *
 * 遮罩吃掉指针事件也是有意的：拾取态下点节点就是「选它」，不该顺手触发节点内部
 * 的按钮，也不该把节点拖走。
 */
import { memo, type MouseEvent, type SyntheticEvent } from 'react';

import { useCanvasStore } from '@/stores/canvasStore';
import { attachReferenceEdge } from '@/features/canvas/application/attachReference';
import { useReferencePickStore } from '@/features/canvas/application/referencePickStore';

/** 遮罩中央那颗提示胶囊，可选态和不可选态共用一套样式。 */
function OverlayHint({ text, always }: { text: string; always: boolean }) {
  return (
    <span
      className={`pointer-events-none absolute left-1/2 top-1/2 max-w-[86%] -translate-x-1/2 -translate-y-1/2 truncate rounded-md bg-[#1b1b1b]/95 px-2.5 py-1 text-[12px] font-medium text-white shadow-[0_8px_20px_rgba(0,0,0,0.45)] ring-1 ring-white/12 transition-opacity ${
        always ? 'opacity-100' : 'opacity-0 group-hover/refpick:opacity-100'
      }`}
    >
      {text}
    </span>
  );
}

function stopEvent(event: SyntheticEvent) {
  event.stopPropagation();
}

function ActiveReferencePickOverlay({
  nodeId,
  targetNodeId,
  label,
}: {
  nodeId: string;
  targetNodeId: string;
  label: string;
}) {
  const connected = useCanvasStore((state) =>
    state.edges.some((edge) => edge.source === nodeId && edge.target === targetNodeId)
  );

  const handleClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const store = useCanvasStore.getState();
    if (connected) {
      store.edges
        .filter((edge) => edge.source === nodeId && edge.target === targetNodeId)
        .forEach((edge) => store.deleteEdge(edge.id));
      return;
    }
    attachReferenceEdge(nodeId, targetNodeId);
  };

  return (
    <div
      role="button"
      tabIndex={-1}
      title={connected ? '取消选择' : `选择 ${label}`}
      className={`nodrag nopan group/refpick absolute inset-0 z-[45] cursor-pointer rounded-[var(--node-radius)] ring-2 transition-[box-shadow] ${
        connected
          ? 'ring-[rgb(var(--accent-rgb))] bg-[rgb(var(--accent-rgb)/0.08)]'
          : 'ring-transparent hover:ring-[rgb(var(--accent-rgb))] hover:bg-[rgb(var(--accent-rgb)/0.08)]'
      }`}
      onClick={handleClick}
      onPointerDown={stopEvent}
      onMouseDown={stopEvent}
      onDoubleClick={stopEvent}
      onContextMenu={stopEvent}
    >
      <OverlayHint text={connected ? '取消选择' : `选择 ${label}`} always={connected} />
    </div>
  );
}

// 不可选的节点：调暗 + hover 出原因。
// 只吃 click / 双击 / 右键，按下不拦、也不加 nopan——拾取态下画布上大半节点都盖着
// 这层遮罩，再把拖动吞掉的话用户就没法拖着画布去找要参考的那个节点了。
function BlockedReferencePickOverlay({ reason }: { reason: string }) {
  return (
    <div
      title={reason}
      className="nodrag group/refpick absolute inset-0 z-[45] cursor-not-allowed rounded-[var(--node-radius)] bg-black/55"
      onClick={stopEvent}
      onDoubleClick={stopEvent}
      onContextMenu={stopEvent}
    >
      <OverlayHint text={reason} always={false} />
    </div>
  );
}

function ReferencePickNodeOverlayImpl({ nodeId }: { nodeId: string }) {
  // 三个 selector 都返回原始值：不在拾取态时它们恒为 null，画布内容怎么变都不会
  // 让任何一个节点因为这个遮罩重渲染。
  const targetNodeId = useReferencePickStore((state) =>
    state.request && state.request.targetNodeId !== nodeId ? state.request.targetNodeId : null
  );
  const label = useReferencePickStore(
    (state) => state.request?.candidates.get(nodeId)?.label ?? null
  );
  const rejection = useReferencePickStore(
    (state) => state.request?.rejections.get(nodeId) ?? null
  );

  if (!targetNodeId) return null;
  if (label !== null) {
    return (
      <ActiveReferencePickOverlay
        nodeId={nodeId}
        targetNodeId={targetNodeId}
        label={label}
      />
    );
  }
  if (rejection !== null) return <BlockedReferencePickOverlay reason={rejection} />;
  return null;
}

export const ReferencePickNodeOverlay = memo(ReferencePickNodeOverlayImpl);
