// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText } from 'lucide-react';

import { ReferenceDetachButton } from './ReferenceDetachButton';

interface ReferenceTextChipProps {
  /** 上游文本节点 id（连线的 source） */
  nodeId: string;
  /** 被引用的文本内容 */
  text: string;
  /** 来源标签（displayName / nodeType），展示在预览浮层标题处 */
  sourceLabel?: string;
  /** 取消引用回调 */
  onDetach: (nodeId: string) => void;
  /** 点击 chip 时聚焦上游节点（可选，仅部分节点需要） */
  onFocus?: (nodeId: string) => void;
  /** 双击 chip 时把视口跳到上游节点所在位置（可选） */
  onJump?: (nodeId: string) => void;
  /** 覆盖触发器方块的样式（默认 h-9 w-9 圆角方块） */
  triggerClassName?: string;
}

/**
 * 引用文本的统一展示：一个文本图标方块，hover 时在上方浮出完整文本预览。
 *
 * 取代之前各处「图标 + 截断文字 + 原生 title」的 chip——只露图标，省横向空间，
 * 完整内容靠样式化的 hover 浮层呈现（参考音乐节点的引用预览）。
 *
 * 预览浮层用 portal + fixed 定位渲染到 body：节点工具条普遍带 `overflow-x-auto`
 * （会一并裁掉纵向溢出），若用 absolute 浮层会被裁切看不见，portal 可绕开。
 */
export function ReferenceTextChip({
  nodeId,
  text,
  sourceLabel,
  onDetach,
  onFocus,
  onJump,
  triggerClassName,
}: ReferenceTextChipProps) {
  const trimmed = (text ?? '').trim();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [previewAnchor, setPreviewAnchor] = useState<{ top: number; left: number } | null>(null);

  const showPreview = () => {
    if (trimmed.length === 0) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // 贴着图标上沿，留 8px 间距；浮层自身用 translateY(-100%) 上移。
    setPreviewAnchor({ top: rect.top - 8, left: rect.left });
  };
  const hidePreview = () => setPreviewAnchor(null);

  return (
    <div
      className="group/reftext relative shrink-0"
      onMouseEnter={showPreview}
      onMouseLeave={hidePreview}
    >
      <button
        ref={triggerRef}
        type="button"
        title={sourceLabel}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onFocus?.(nodeId);
        }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          // 跳走之后这颗 chip 连同整个面板都不在视口里了，浮层留着会飘在半空。
          hidePreview();
          onJump?.(nodeId);
        }}
        className={
          triggerClassName ??
          'nodrag flex h-9 w-9 items-center justify-center rounded-lg bg-white/12 transition-colors hover:bg-white/20'
        }
      >
        <FileText className="h-4 w-4 text-white" />
      </button>
      <ReferenceDetachButton
        nodeId={nodeId}
        onDetach={onDetach}
        className="nodrag absolute right-0 top-0 z-10 hidden h-4 w-4 items-center justify-center rounded-bl-md rounded-tr-md bg-black/75 text-white transition-colors hover:bg-red-500 group-hover/reftext:flex"
      />
      {previewAnchor &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              top: previewAnchor.top,
              left: previewAnchor.left,
              transform: 'translateY(-100%)',
            }}
            className="canvas-node-transient-ui pointer-events-none z-[2000] w-max max-w-[280px] rounded-lg bg-black px-3 py-2.5 text-xs leading-relaxed text-white shadow-[0_10px_24px_rgba(0,0,0,0.45)]"
          >
            <div className="max-h-[220px] overflow-y-auto whitespace-pre-wrap break-words">
              {trimmed}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
