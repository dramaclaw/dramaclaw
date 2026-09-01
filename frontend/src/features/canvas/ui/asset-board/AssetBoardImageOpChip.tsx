// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeftRight,
  FastForward,
  Film,
  Globe,
  Grid2x2,
  Grid3x3,
  LayoutDashboard,
  Mountain,
  Package,
  Rewind,
  User,
  Users,
  type LucideIcon,
} from 'lucide-react';

import {
  ASSET_BOARD_IMAGE_OPS,
  ASSET_BOARD_IMAGE_OP_CATEGORY_LABELS,
  ASSET_BOARD_IMAGE_OP_MAP,
  switchAssetBoardImageOp,
  type AssetBoardImageOpCategoryKey,
  type AssetBoardImageOpKey,
} from '@/features/canvas/application/assetBoardImageOps';
import { NODE_FLOATING_PANEL_SURFACE_CLASS } from '@/features/canvas/ui/nodeControlStyles';

/** 功能 → 图标。与工具条 `GRID_ACTION_DEFS` 同一套图标，换个视图不换认知。 */
export const ASSET_BOARD_IMAGE_OP_ICONS: Record<AssetBoardImageOpKey, LucideIcon> = {
  multiCameraGrid: Grid3x3,
  plotFourGrid: Grid2x2,
  faceThreeView: User,
  productThreeView: Package,
  serialStoryboard25: LayoutDashboard,
  cinematicLightCorrection: Film,
  characterThreeView: Users,
  sceneSettingSheet: Mountain,
  frameProjection3sLater: FastForward,
  frameProjection5sEarlier: Rewind,
  scene360: Globe,
};

/**
 * 功能框的分栏：左栏「分镜叙事 + 质感调节」(4+1)、右栏「空间与机位 + 设定图」
 * (2+4)，左 5 行右 6 行（对标 liblib；加了场景设定图后右栏多出一行，面板本身
 * 可滚动，不影响可达性）。纯排版决策，故功能表里只留分类，怎么摆由这里说了算。
 */
const PANEL_COLUMNS: readonly (readonly AssetBoardImageOpCategoryKey[])[] = [
  ['narrative', 'texture'],
  ['space', 'setting'],
];

const COLUMN_WIDTH_PX = 228;
const PANEL_PADDING_PX = 16;
const PANEL_COLUMN_GAP_PX = 24;
const PANEL_WIDTH_PX =
  COLUMN_WIDTH_PX * PANEL_COLUMNS.length
  + PANEL_COLUMN_GAP_PX * (PANEL_COLUMNS.length - 1)
  + PANEL_PADDING_PX * 2;
const PANEL_MAX_HEIGHT_PX = 460;
const PANEL_GAP_PX = 8;

/**
 * 提示词输入框**里**的功能 chip（对标 liblib 详情输入框里那颗「⬢ 角色设定图 ⇄」）。
 *
 * 它不是输入框上方另起的一行控件，而是 contenteditable 内部的一个内联原子块
 * （由 `PromptMentionEditor` 的 `leadingChip` 插槽 portal 进去），因此：
 * - 功能说明就是输入框的占位文案，接在 chip 右边同一行；
 * - 用户打的字从 chip 后面开始流动；
 * - **像删字符一样退格即可删掉它**（删除由编辑器拦截后回调宿主清 `imageOpKey`），
 *   所以这里不再画一个 × 按钮。
 *
 * 点 chip 展开功能框，按四栏（分镜叙事 / 空间与机位 / 设定图 / 质感调节）列出全部
 * 功能，选一个就地换掉当前功能（节点名跟着换）。功能框走 portal 挂 body，避免被
 * 输入框的 overflow 裁掉。
 */
export function AssetBoardImageOpChip({
  nodeId,
  opKey,
  disabled = false,
}: {
  nodeId: string;
  opKey: AssetBoardImageOpKey;
  /** 生成中锁住换功能：在途任务还会回写这个节点，中途改 key 只会让人看错。 */
  disabled?: boolean;
}): ReactElement {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!anchor) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        panelRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setAnchor(null);
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [anchor]);

  // 功能被切走 / 被删掉时顺手收起面板，避免它挂在原地指向一个已经不在的 chip。
  useEffect(() => setAnchor(null), [opKey]);

  const def = ASSET_BOARD_IMAGE_OP_MAP[opKey];
  const Icon = ASSET_BOARD_IMAGE_OP_ICONS[opKey];

  // 输入框贴在面板底部，往下弹会顶出视口 → 一律往上弹，左边缘对齐 chip 并夹在视口内。
  const panelStyle = anchor
    ? {
        left: Math.max(8, Math.min(anchor.left, window.innerWidth - PANEL_WIDTH_PX - 8)),
        bottom: Math.max(8, window.innerHeight - anchor.top + PANEL_GAP_PX),
        width: PANEL_WIDTH_PX,
        maxHeight: Math.min(PANEL_MAX_HEIGHT_PX, anchor.top - PANEL_GAP_PX - 16),
      }
    : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        title={`${def.label} · 点击切换功能，退格删除`}
        disabled={disabled}
        // 别让 mousedown 走默认行为：那会把光标挪到 chip 上（它是 contenteditable=false
        // 的原子块），用户接着打字会落在意料之外的位置。
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          setAnchor((prev) =>
            prev ? null : (triggerRef.current?.getBoundingClientRect() ?? null),
          );
        }}
        className="prompt-op-chip nodrag"
      >
        <span className="prompt-op-chip-icon">
          <Icon className="h-2.5 w-2.5" strokeWidth={2.5} />
        </span>
        <span className="prompt-op-chip-label">{def.label}</span>
        <ArrowLeftRight className="prompt-op-chip-switch h-3 w-3" />
      </button>
      {panelStyle
        && createPortal(
          <div
            ref={panelRef}
            className={`ui-scrollbar nodrag nowheel fixed z-[10000] flex gap-6 overflow-y-auto p-4 ${NODE_FLOATING_PANEL_SURFACE_CLASS}`}
            style={panelStyle}
            onMouseDown={(event) => event.preventDefault()}
          >
            {PANEL_COLUMNS.map((categories) => (
              <div
                key={categories.join('-')}
                className="flex flex-col gap-4"
                style={{ width: COLUMN_WIDTH_PX }}
              >
                {categories.map((category) => (
                  <div key={category}>
                    <div className="px-2 pb-1.5 text-xs text-white/40">
                      {ASSET_BOARD_IMAGE_OP_CATEGORY_LABELS[category]}
                    </div>
                    <div className="flex flex-col gap-1">
                      {ASSET_BOARD_IMAGE_OPS.filter((op) => op.category === category).map((op) => {
                        const OpIcon = ASSET_BOARD_IMAGE_OP_ICONS[op.key];
                        const isActive = op.key === opKey;
                        return (
                          <button
                            key={op.key}
                            type="button"
                            onClick={() => {
                              switchAssetBoardImageOp(nodeId, op.key);
                              setAnchor(null);
                            }}
                            className={`group flex h-11 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors ${
                              isActive ? 'bg-white/[0.1]' : 'hover:bg-white/[0.06]'
                            }`}
                          >
                            <span
                              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-white transition-colors ${
                                isActive
                                  ? 'bg-white/[0.14]'
                                  : 'bg-white/[0.06] group-hover:bg-white/[0.1]'
                              }`}
                            >
                              <OpIcon className="h-4 w-4" />
                            </span>
                            {/* 行高固定 44px：说明行平时收起、hover/选中才出现，标题
                                随之上移一点，整块面板不会因此跳高。 */}
                            <span className="flex min-w-0 flex-col justify-center gap-0.5">
                              <span className="truncate text-[13px] leading-tight text-white">
                                {op.label}
                              </span>
                              <span
                                className={`truncate text-[11px] leading-tight text-white/40 ${
                                  isActive ? '' : 'hidden group-hover:block'
                                }`}
                              >
                                {op.summary}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
