// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useRef, type ChangeEvent } from 'react';
import { Loader2, Upload } from 'lucide-react';

import { ASSET_COMMIT_DRAG_HINT } from '@/features/canvas/ui/useAssetCommitDrag';

/**
 * 结果卡片右上角的「替换素材」按钮：拉起本地文件选择器，把选中的文件交回调用方
 * 上传（各节点用自己那条上传路径 —— 图片/音频走通用 upload，视频要先过一遍
 * Web 兼容转码），成功后替换该节点的媒体。
 *
 * 只放在**已经有内容**的卡片上：空态节点各自有自己的上传入口（NodeSideActionRail
 * 那条「上传」按钮栏），两者不叠。
 *
 * accept 只是选择器提示 —— 用户切「所有文件」照样能塞进别的类型，硬校验必须留在
 * 调用方的 onPick 里。
 *
 * 传了 onCommitDragStart 时这颗按钮同时是「拖到左侧素材库替换」的抓手：点一下拉
 * 本地文件，按住拖走则提交到素材库。合成一颗是因为两者在用户眼里都叫「替换」，
 * 各给一颗会在同一个角上摞出两个一样的图标。
 *
 * 点击换本地文件是主动作，所有有内容的卡片都该给 —— 只挂拖拽、点击不做事的话，
 * 按钮长得和能点的一模一样，用户点下去没反应只会当成坏了。
 */
interface NodeMediaReplaceButtonProps {
  accept?: string;
  /** 上传中：按钮转圈并禁用，避免连点堆出多次上传。 */
  busy?: boolean;
  title: string;
  /** 不传则这颗按钮只承接拖拽（点击不做事）——见上，别再这么用。 */
  onPick?: (file: File) => void | Promise<void>;
  /** 按住拖动超过阈值时触发（拖到左侧素材库替换同类型素材）。 */
  onCommitDragStart?: () => void;
}

/** 小于这个位移仍算点击 —— 手抖不该把「换本地文件」变成「拖去素材库」。 */
const DRAG_THRESHOLD_PX = 4;

export function NodeMediaReplaceButton({
  accept,
  busy = false,
  title,
  onPick,
  onCommitDragStart,
}: NodeMediaReplaceButtonProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // 本次手势已经升级成拖拽 → 松手时别再把它当点击去拉文件选择器。
  const draggedRef = useRef(false);
  // 两种手势都在时 title 得同时说清，不然「按住拖」这层没有任何提示。
  const fullTitle =
    onPick && onCommitDragStart ? `${title}（${ASSET_COMMIT_DRAG_HINT}）` : title;

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // 先清 value 再处理：选同一个文件第二次时 change 不会再触发，清空才能重选。
    event.target.value = '';
    if (file) void onPick?.(file);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    // nodrag 已经挡住 React Flow 拖节点，这里只需要拦住画布的框选/取消选中。
    event.stopPropagation();
    draggedRef.current = false;
    if (!onCommitDragStart || busy || event.button !== 0) return;

    const startX = event.clientX;
    const startY = event.clientY;
    const onMove = (moveEvent: PointerEvent) => {
      if (
        Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) <
        DRAG_THRESHOLD_PX
      ) {
        return;
      }
      cleanup();
      draggedRef.current = true;
      // 越过阈值才开拖：startDrag 会自己接管后续 pointermove / pointerup。
      onCommitDragStart();
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanup);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanup);
  };

  return (
    <>
      <button
        type="button"
        disabled={busy}
        title={fullTitle}
        aria-label={title}
        // nodrag：不然按下就变成拖节点，点击永远到不了。
        className="nodrag absolute right-2 top-2 z-20 inline-flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-black/55 text-white/85 backdrop-blur-sm transition-colors hover:border-white/25 hover:bg-black/80 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
        style={onCommitDragStart ? { cursor: 'grab' } : undefined}
        onPointerDown={handlePointerDown}
        onClick={(event) => {
          event.stopPropagation();
          if (draggedRef.current || !onPick) return;
          inputRef.current?.click();
        }}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Upload className="h-3.5 w-3.5" />
        )}
      </button>
      {onPick && (
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={handleChange}
        />
      )}
    </>
  );
}
