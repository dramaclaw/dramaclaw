// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { MessageSquarePlus } from 'lucide-react';
import type { ReactElement } from 'react';

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { cn } from '@/lib/utils';

export const ADD_NODE_TO_CHAT_LABEL = '添加到对话';

/**
 * 把节点作为引用加入虾导输入框。画布节点与故事板卡片共用这一个入口：两个视图是
 * 同一份节点数据的两种投影，引用语义必须一致，所以都只发事件、由 FreezoneShell
 * 统一落地（选中 + 展开聊天），避免两边各写一套选中逻辑后行为漂移。
 */
export function addNodesToChat(nodeIds: string[]): void {
  const ids = nodeIds.filter((nodeId) => nodeId.trim().length > 0);
  if (ids.length === 0) return;
  canvasEventBus.publish('freezone/add-nodes-to-chat', { nodeIds: ids });
}

/** 画布节点用：卡片内右上角悬浮，平时透明，hover 节点根（`group`）或键盘聚焦时浮出。 */
const FLOATING_BUTTON_CLASS = cn(
  // nodrag 必须留着，否则按下按钮会被 React Flow 当成拖节点。
  'nodrag absolute right-1.5 top-1.5 z-30 inline-flex h-7 w-7 items-center justify-center rounded-md',
  'bg-black/55 text-white/85 opacity-0 backdrop-blur-sm transition-opacity',
  'hover:bg-black/75 hover:text-white focus-visible:opacity-100',
  'group-hover:opacity-100 group-focus-within:opacity-100',
);

type AddNodeToChatTriggerProps = {
  nodeId: string;
  className: string;
  iconClassName?: string;
  /** 文字提示的方向；默认 top，贴顶边的位置传 bottom 免得提示被裁。 */
  side?: 'top' | 'bottom' | 'left' | 'right';
};

/**
 * 按钮本体。文字提示走 shadcn Tooltip 而不是原生 title：原生的要悬停约一秒才出，
 * 样式也和产品其它悬浮说明不统一。因此这里只留 aria-label 给读屏，不再挂 title
 * ——两者并存会同时冒出两个提示。
 */
function AddNodeToChatTrigger({
  nodeId,
  className,
  iconClassName,
  side = 'top',
}: AddNodeToChatTriggerProps): ReactElement {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={ADD_NODE_TO_CHAT_LABEL}
              onClick={(event) => {
                // 不冒泡到节点根 / 卡片：它们的 onClick 会把选中重置成「只选这一个」
                // 或直接打开详情，而这里要的是累加引用（连点几个节点攒一组上下文）。
                event.stopPropagation();
                addNodesToChat([nodeId]);
              }}
              onPointerDown={(event) => event.stopPropagation()}
              className={className}
            />
          }
        >
          <MessageSquarePlus className={cn('h-4 w-4', iconClassName)} />
        </TooltipTrigger>
        <TooltipContent side={side}>{ADD_NODE_TO_CHAT_LABEL}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

type AddNodeToChatButtonProps = {
  nodeId: string;
  /** 追加/覆盖定位样式；默认是画布节点用的「卡片内右上角悬浮」。 */
  className?: string;
  iconClassName?: string;
  side?: AddNodeToChatTriggerProps['side'];
};

/** 画布节点右上角的「添加到对话」。 */
export function AddNodeToChatButton({
  nodeId,
  className,
  iconClassName,
  // 默认朝左：节点的浮动标题栏和分辨率徽标都挂在 -top-7 的同一个右上角，
  // 提示朝上会正好糊在它们身上。
  side = 'left',
}: AddNodeToChatButtonProps): ReactElement {
  return (
    <AddNodeToChatTrigger
      nodeId={nodeId}
      className={cn(FLOATING_BUTTON_CLASS, className)}
      iconClassName={iconClassName}
      side={side}
    />
  );
}

/**
 * 故事板用：不带自己的定位/配色，样式完全由调用方给（卡片右上角动作组、详情头部
 * 图标按钮各有各的既有类），但共用同一份行为与文字提示。
 */
export function AddNodeToChatIconButton({
  nodeId,
  className,
  iconClassName,
  side,
}: AddNodeToChatButtonProps & { className: string }): ReactElement {
  return (
    <AddNodeToChatTrigger
      nodeId={nodeId}
      className={className}
      iconClassName={iconClassName}
      side={side}
    />
  );
}
