// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 图片 / 视频节点提示词栏上的「＋参考」入口。
 *
 * 两种参考在用户眼里是一回事——「给这次生成一个参照物」——只是素材从哪来不同：
 * 画布上已有的节点，或者本地文件。所以它们合并成同一颗 chip，点开是个二选一的
 * 下拉；顶排 chip 也因此少一颗，给输入区腾出横向空间。
 *
 * 「画布参考」走拾取态：用户直接在画布上点一个节点，选中的结果就是一条上游连线，
 * 参考 chip 与提交载荷都由既有的上游推导链路自动跟上（见 [[referencePick]]）。
 * 「外部参考」把文件选择交回宿主节点（各节点接受的文件类型不一样）。
 *
 * 没有传 onPickExternal 的节点（如图片生成节点，它本来就没有外部素材入口）保持
 * 单击直接进拾取态，不平白多一层菜单。
 */
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { MousePointerClick, Plus, Upload } from 'lucide-react';
import { toast } from 'sonner';

import { useCanvasStore } from '@/stores/canvasStore';
import type { CanvasNodeType } from '@/features/canvas/domain/canvasNodes';
import { collectReferencePickTargets } from '@/features/canvas/application/referencePick';
import { useReferencePickStore } from '@/features/canvas/application/referencePickStore';
import { placeAnchoredMenu } from '@/features/canvas/nodes/shared/anchoredMenuPlacement';
import {
  NODE_FLOATING_PANEL_SURFACE_CLASS,
  NODE_TEXT_CONTROL_ICON_CLASS,
  NODE_TEXT_CONTROL_TRIGGER_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';

const MENU_WIDTH = 208;
const MENU_GAP = 6;
/** 两条固定菜单项撑满时的高度，用来判断下方放不放得下。 */
const MENU_HEIGHT = 108;

/**
 * 进入画布拾取态。可选目标为空时不进入——拾取态下整张画布都会变样，
 * 进去了却一个能点的都没有，只会让用户以为功能坏了。
 */
function startCanvasPick(nodeId: string, nodeType: CanvasNodeType): void {
  // 视口从 store 读而不是 useReactFlow()：这个 chip 活在节点组件里，节点组件的
  // 单测普遍只 mock 了 @xyflow/react 的一小撮导出，多要一个 hook 就会把它们全部
  // 拖下水；currentViewport 本来就是 store 维护的（见 BackToNodesHint）。
  const { nodes, currentViewport } = useCanvasStore.getState();
  const { candidates, rejections } = collectReferencePickTargets(nodes, nodeId, nodeType);
  if (candidates.size === 0) {
    toast.info('画布上还没有可以作为参考的节点');
    return;
  }
  useReferencePickStore.getState().start({
    targetNodeId: nodeId,
    targetNodeType: nodeType,
    originViewport: currentViewport ?? null,
    candidates,
    rejections,
  });
}

function ReferenceSourceMenuItem({
  icon,
  label,
  hint,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/[0.09]"
    >
      <span className="mt-[3px] shrink-0 text-text-muted/90">{icon}</span>
      <span className="min-w-0">
        <span className="block text-[13px] leading-tight text-text-dark">{label}</span>
        <span className="mt-0.5 block text-[11px] leading-tight text-text-muted/80">
          {hint}
        </span>
      </span>
    </button>
  );
}

export function ReferencePickChip({
  nodeId,
  nodeType,
  onPickExternal,
}: {
  nodeId: string;
  nodeType: CanvasNodeType;
  /** 选择「外部参考」时的回调；不传则本 chip 单击直接进画布拾取态。 */
  onPickExternal?: () => void;
}) {
  const active = useReferencePickStore((state) => state.request?.targetNodeId === nodeId);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{
    left: number;
    top: number;
    maxHeight: number;
  } | null>(null);

  // 菜单走 portal + fixed，理由同 CameraMovementChip：chip 所在的那行是
  // overflow-x-auto（纵向也会跟着裁），而且节点自带 transform 会把 absolute 浮层
  // 关进它自己的层叠上下文里，盖不过画布上的其它东西。
  useEffect(() => {
    if (!anchor) return;
    const close = (event: globalThis.MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        menuRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setAnchor(null);
    };
    document.addEventListener('mousedown', close, true);
    return () => document.removeEventListener('mousedown', close, true);
  }, [anchor]);

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // 操作面板常年贴在视口下沿，这颗 chip 离底边往往只剩几十像素：只往下开会把整个
    // 菜单顶到视口外，看起来就像点了没反应。见 [[placeAnchoredMenu]]。
    const { top, left, maxHeight } = placeAnchoredMenu({
      anchorRect: rect,
      width: MENU_WIDTH,
      preferredHeight: MENU_HEIGHT,
      gap: MENU_GAP,
    });
    setAnchor({ left, top, maxHeight });
  };

  const handleClick = (event: MouseEvent) => {
    event.stopPropagation();
    // 已经在拾取态：这一下是「算了，不选了」，不该再弹菜单。
    if (active) {
      useReferencePickStore.getState().stop();
      return;
    }
    if (!onPickExternal) {
      startCanvasPick(nodeId, nodeType);
      return;
    }
    if (anchor) setAnchor(null);
    else openMenu();
  };

  const highlighted = active || anchor !== null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleClick}
        className={`${NODE_TEXT_CONTROL_TRIGGER_CLASS} group/refpick shrink-0 px-1.5 ${
          highlighted ? 'text-[rgb(var(--accent-rgb))]' : ''
        }`}
        title={
          onPickExternal
            ? '添加参考：画布上的节点，或本地文件'
            : '在画布上选择一个节点作为参考'
        }
      >
        <Plus
          className={`${NODE_TEXT_CONTROL_ICON_CLASS} ${
            highlighted
              ? 'text-[rgb(var(--accent-rgb))]'
              : 'group-hover/refpick:text-text-dark'
          }`}
        />
        <span>参考</span>
      </button>
      {anchor &&
        onPickExternal &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuRef}
            style={{
              left: anchor.left,
              top: anchor.top,
              width: MENU_WIDTH,
              maxHeight: anchor.maxHeight,
            }}
            className={`nodrag nowheel ui-scrollbar fixed z-[10000] overflow-y-auto p-1 ${NODE_FLOATING_PANEL_SURFACE_CLASS}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <ReferenceSourceMenuItem
              icon={<MousePointerClick className="h-3.5 w-3.5" />}
              label="画布参考"
              hint="在画布上点选一个节点"
              onSelect={() => {
                setAnchor(null);
                startCanvasPick(nodeId, nodeType);
              }}
            />
            <ReferenceSourceMenuItem
              icon={<Upload className="h-3.5 w-3.5" />}
              label="外部参考"
              hint="从本地上传素材文件"
              onSelect={() => {
                setAnchor(null);
                onPickExternal();
              }}
            />
          </div>,
          document.body,
        )}
    </>
  );
}
