// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { CANVAS_NODE_OPS_PANEL_CLASS } from '@/features/canvas/ui/nodeFrameStyles';

interface OperationPanelShellProps {
  /** 展开时改用 body 级居中弹窗展示，收起时是节点下方的浮动面板。 */
  expanded: boolean;
  /** 关闭弹窗（点遮罩 / Esc / 再点收起按钮）。 */
  onCollapse: () => void;
  /** 收起态：节点下方浮动面板的定位 class。 */
  inlineClassName: string;
  /** 收起态：浮动面板的定位/尺寸 style（top/left/right/width/height）。 */
  inlineStyle: CSSProperties;
  /** 展开态：弹窗盒子的尺寸 style（width/height，可只给 width 让高度随内容）。 */
  modalStyle?: CSSProperties;
  children: ReactNode;
}

function stopPropagation(event: { stopPropagation: () => void }): void {
  event.stopPropagation();
}

// 节点激活时，操作区从节点下方淡入+轻微下滑出现（而非生硬地直接出现）。
// 收起态浮动面板挂在节点下方，故从上方滑入读起来像「从节点里展开」。
// motion-reduce 下不做位移/缩放动画，尊重系统的「减弱动态效果」。
//
// 导出供节点下方的「历史记录」面板复用同一套入场动画，使三块（顶部工具栏 /
// 操作区 / 历史记录）激活时同向同时长地浮现、视觉对齐，不再各跳各的。
export const NODE_OPS_PANEL_ENTER_CLASS =
  'animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-200 ease-out motion-reduce:animate-none';
const INLINE_ENTER_CLASS = NODE_OPS_PANEL_ENTER_CLASS;

/**
 * 节点操作区的「外壳」：收起时就是节点下方的浮动面板；点「放大」后改为
 * document.body 级的居中弹窗展示同一份内容。
 *
 * 为什么必须 portal 到 body —— React Flow 给画布 viewport 加了 CSS transform，
 * 面板若用 `position: fixed` 会相对「被 transform 的祖先」定位而不是视口，无法
 * 真正居中；createPortal 到 body 才能脱离这个 transform 上下文。
 */
export function OperationPanelShell({
  expanded,
  onCollapse,
  inlineClassName,
  inlineStyle,
  modalStyle,
  children,
}: OperationPanelShellProps) {
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCollapse();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [expanded, onCollapse]);

  if (!expanded) {
    return (
      <div
        data-slot="node-operation-panel"
        className={`${inlineClassName} ${INLINE_ENTER_CLASS}`}
        style={inlineStyle}
        onClick={stopPropagation}
      >
        {children}
      </div>
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
      onClick={onCollapse}
      onPointerDown={stopPropagation}
    >
      <div
        className={`nodrag nowheel relative flex max-h-full max-w-full flex-col rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS}`}
        style={modalStyle}
        onClick={stopPropagation}
        onPointerDown={stopPropagation}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
