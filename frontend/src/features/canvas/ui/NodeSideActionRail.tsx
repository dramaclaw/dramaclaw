// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { NodeToolbar as ReactFlowNodeToolbar, Position, useStore } from '@xyflow/react';
import { useState, type ReactNode } from 'react';

import { useCanvasStore } from '@/stores/canvasStore';
import { ZoomScaledToolbar } from '@/features/canvas/ui/ZoomScaledToolbar';

interface NodeSideActionRailProps {
  nodeId: string;
  position?: Position.Left | Position.Right;
  children: ReactNode;
  /**
   * 仅在节点被 hover 或选中时显示这条按钮栏（默认 false = 恒显示，保持
   * 上传/音频节点把上传当主操作的原有行为）。视频/图片节点的上传按钮接入它，
   * 避免在画布上一直显眼。
   */
  autoHide?: boolean;
  /** 节点是否被选中（autoHide 时用于「选中也显示」）。 */
  selected?: boolean;
  /**
   * 贴住节点的角向下展开，而不是抬到顶边之上。右栏默认抬起是为了避开右边缘居中的
   * spawn「+」，但抬起后会撞上同样悬在节点上方、且比节点更宽的顶部操作工具条 ——
   * 只在选中态出现的按钮（如替换素材把手）必须贴角，否则一选中就和工具条叠在一起。
   */
  anchorAtCorner?: boolean;
}

// NodeToolbar 默认恒定屏幕尺寸（不随缩放变化），于是整理画布缩小后节点变成缩略图、
// 这条上传/替换按钮栏却仍是原大小，显得格外突兀。改用 ZoomScaledToolbar 跟随画布
// zoom：不再夹上限（之前夹 1 导致放大态不跟着变大、和其余 UI 脱节），放大时与顶部
// 操作工具条一致地一起变大；仅保留 min=0.6 下限，避免缩到 minZoom(0.1) 时点不准。

export const NODE_SIDE_ACTION_BUTTON_CLASS =
  'nodrag inline-flex h-8 items-center gap-1.5 rounded-[12px] border border-white/10 bg-[#242426]/95 px-3 text-xs font-medium text-text-dark backdrop-blur-xl transition-colors hover:border-white/18 hover:bg-[#29292b]/95 hover:text-white disabled:cursor-not-allowed disabled:opacity-50';

/** 无文案版本：正方形、去掉给标签留的 px-3/gap，只放一个图标。 */
export const NODE_SIDE_ACTION_ICON_BUTTON_CLASS =
  'nodrag inline-flex h-8 w-8 items-center justify-center rounded-[12px] border border-white/10 bg-[#242426]/95 text-text-dark backdrop-blur-xl transition-colors hover:border-white/18 hover:bg-[#29292b]/95 hover:text-white disabled:cursor-not-allowed disabled:opacity-50';

export const NODE_SIDE_ACTION_ICON_CLASS = 'h-3.5 w-3.5 text-text-muted/90';

export function NodeSideActionRail({
  nodeId,
  position = Position.Right,
  children,
  autoHide = false,
  selected = false,
  anchorAtCorner = false,
}: NodeSideActionRailProps) {
  const isLeft = position === Position.Left;
  // 左栏从来不抬（见下方注释）；右栏默认抬起避开居中的「+」，anchorAtCorner 关掉它。
  const lifted = !isLeft && !anchorAtCorner;
  // Canvas 维护的节点 hover（离开带 400ms 延迟，桥接「从节点移到上方按钮」的
  // 空隙）；railHovered 进一步保证鼠标停在按钮栏上时不被那个延迟清掉而隐藏。
  const nodeHovered = useCanvasStore((state) => state.hoveredNodeId === nodeId);
  const [railHovered, setRailHovered] = useState(false);
  const isVisible = !autoHide || selected || nodeHovered || railHovered;
  // 把这条按钮栏抬到同节点的 spawn「+」(NodeSpawnPlusOverlay) 之上。两者都是
  // 同一节点的 NodeToolbar，xyflow 给它们同一个 zIndex(node.internals.z + 1);
  // 「+」在 Canvas 层后渲染，平局时 DOM 顺序更靠后而盖在上面，它那块 80px 的隐形
  // 磁吸命中区会压住「上传」按钮、把点击吃掉(磁吸还会把「+」吸到按钮上)。这里给
  // 按钮栏 +2,确保按钮永远在「+」之上接收 hover/点击(光标落到按钮上时「+」自动退回)。
  const nodeZ = useStore((state) => state.nodeLookup.get(nodeId)?.internals.z ?? 0);
  return (
    <ReactFlowNodeToolbar
      nodeId={nodeId}
      isVisible={isVisible}
      position={position}
      align="start"
      offset={18}
      className="pointer-events-auto"
      style={{ zIndex: nodeZ + 2 }}
    >
      {/*
        Right rail (upload): lift it just above the node's top-right corner. The
        spawn "+" (NodeSpawnPlusOverlay) lives on the same right edge but
        vertically centered, so a top-aligned rail collides with it on short
        nodes (audio) — worse now that the "+" scales with zoom. Anchoring above
        the top edge keeps it clear of the centered "+" at any zoom/height.

        Left rail: never lifted. This rail AND the centered top action toolbar
        both scale with zoom, so a lifted rail grows up into the toolbar's band
        and overlaps it at high zoom (the toolbar is wider than the node, so its
        ends reach past both side columns). Anchoring at the node's corner and
        growing downward keeps the rail below the toolbar — which sits entirely
        above the node's top edge — at any zoom.

        anchorAtCorner opts a right rail out of the lift for that same reason —
        used by the 替换素材 handle, which only appears on selection, i.e. exactly
        when the toolbar is on screen. Safe only where the node is taller than
        the rail (the centered "+" is what the lift exists to dodge).
      */}
      <div
        style={lifted ? { transform: "translateY(calc(-100% - 2px))" } : undefined}
        onMouseEnter={() => setRailHovered(true)}
        onMouseLeave={() => setRailHovered(false)}
      >
        {/* 跟随画布缩放，与顶部操作工具条同一套逻辑。锚点贴住靠节点的那个角
            （抬起的右栏 bottom-left 朝上，贴角的左/右栏 top-* 朝下），缩放时
            朝远离节点方向展开，始终贴在节点角上。 */}
        <ZoomScaledToolbar
          origin={isLeft ? 'top right' : lifted ? 'bottom left' : 'top left'}
          min={0.6}
        >
          <div className={`flex flex-col gap-2 ${isLeft ? 'items-end' : 'items-start'}`}>
            {children}
          </div>
        </ZoomScaledToolbar>
      </div>
    </ReactFlowNodeToolbar>
  );
}
