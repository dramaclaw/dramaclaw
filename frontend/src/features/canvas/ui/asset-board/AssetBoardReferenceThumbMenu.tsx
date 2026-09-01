// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { MapPin, PenLine } from 'lucide-react';

import type { AssetBoardReference } from '@/features/canvas/domain/assetBoard';
import { cn } from '@/lib/utils';

// 菜单项样式（与 AssetBoardDetailToolbar 的「...」菜单项同款：rounded-[6px]、
// hover bg-white/5，本分支体系统一）。
const REFERENCE_MENU_ITEM_CLASS =
  'flex w-full items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-left text-[12px] text-white/80 transition-colors hover:bg-white/5 hover:text-white';

const REFERENCE_MENU_CLOSE_DELAY_MS = 140;

interface AssetBoardReferenceThumbMenuProps {
  reference: AssetBoardReference;
  /** 「编辑」→ 打开被引用节点的详情，用户在那里改。 */
  onEdit: () => void;
  /** 「定位」→ 滚到被引用节点的卡片处并高亮；null（自带参考图无对应节点）→ 不渲染该项。 */
  onLocate: (() => void) | null;
  /** 缩略图尺寸等外观覆盖：详情 48px、卡片 40px。 */
  className?: string;
  /**
   * 点击缩略图本身的行为。不传 → 点击切换菜单开关（详情的既有手感）；
   * 传了 → 点击执行它（卡片：开灯箱预览），菜单只由 hover/focus 驱动。
   */
  onThumbClick?: () => void;
}

/**
 * 参考素材缩略图 + 悬停菜单（详情面板与故事板卡片共用，保证两处手感一致）：
 * 缩略图即触发器，hover / 点击展开一个小菜单——
 * - 「编辑」→ onEdit（跨栏 push 该被引用节点的详情去改）；
 * - 「定位」→ onLocate（把故事板列表滚到该被引用节点的卡片处并高亮，非画布定位）。
 *
 * hover 为主：移入缩略图或面板都保持打开，移出延迟 {@link REFERENCE_MENU_CLOSE_DELAY_MS}ms
 * 收起（防抖）。键盘可达：focus 落到触发器/任一项即展开，焦点整体离开则收起，
 * Esc 收起并把焦点还给缩略图。选完任一项即收起菜单。
 *
 * 根节点吞掉 click 冒泡：卡片整体挂着「点开详情」的 onClick，参考素材的菜单交互
 * 不应连带把当前卡片也打开（详情侧无父级点击处理，吞掉无副作用）。
 */
export function AssetBoardReferenceThumbMenu({
  reference,
  onEdit,
  onLocate,
  className,
  onThumbClick,
}: AssetBoardReferenceThumbMenuProps): ReactElement {
  const [open, setOpen] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);
  const openNow = useCallback(() => {
    clearCloseTimer();
    setOpen(true);
  }, [clearCloseTimer]);
  const closeNow = useCallback(() => {
    clearCloseTimer();
    setOpen(false);
  }, [clearCloseTimer]);
  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => setOpen(false), REFERENCE_MENU_CLOSE_DELAY_MS);
  }, [clearCloseTimer]);
  // 卸载/切换详情项（列表按 key 重挂）时清掉未触发的收起定时器。
  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  const handleBlur = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        closeNow();
      }
    },
    [closeNow],
  );
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape' && open) {
        event.stopPropagation();
        closeNow();
        triggerRef.current?.focus();
      }
    },
    [closeNow, open],
  );

  return (
    <div
      // shrink-0：卡片里的参考行是 flex-wrap，缩略图不能被挤扁。
      className="relative shrink-0"
      onMouseEnter={openNow}
      onMouseLeave={scheduleClose}
      onFocus={openNow}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={reference.label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={reference.label}
        onClick={() => {
          if (onThumbClick) {
            onThumbClick();
            return;
          }
          if (open) closeNow();
          else openNow();
        }}
        // 圆角 3px：与提示词内联参考缩略图（AssetBoardPromptText）统一，小缩略图
        // 配近乎直角的小圆角更紧致。
        className={cn(
          'block h-12 w-12 overflow-hidden rounded-[3px] border border-white/10 transition-colors hover:border-white/25',
          className,
        )}
      >
        <img
          src={reference.thumbnailUrl}
          alt={reference.label}
          loading="lazy"
          draggable={false}
          className="h-full w-full object-cover"
        />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={`${reference.label} 操作`}
          className="absolute left-0 top-full z-50 mt-1.5 min-w-[120px] rounded-md border border-white/10 bg-[#2e2e2e] p-1 text-white/85 shadow-xl"
        >
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              onEdit();
              closeNow();
            }}
            className={REFERENCE_MENU_ITEM_CLASS}
          >
            <PenLine className="h-4 w-4 shrink-0" />
            <span className="flex-1">编辑</span>
          </button>
          {onLocate && (
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                onLocate();
                closeNow();
              }}
              className={REFERENCE_MENU_ITEM_CLASS}
            >
              <MapPin className="h-4 w-4 shrink-0" />
              <span className="flex-1">定位</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
