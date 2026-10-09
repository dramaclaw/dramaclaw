// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface AssetBoardEditorDialogProps {
  /** 无障碍名（编辑器标题，如「多维度编辑器」）；面板内部已有可见标题，这里只给 a11y。 */
  label: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * 故事板详情里承载「工作流完整编辑器」的居中弹窗外壳。
 *
 * portal 到 document.body 的 z-[300] 全屏层（同 RedrawOverlay / EraseOverlay 的层级
 * 与遮罩配方），高于故事板的 z-30；点遮罩或按 Esc 关闭。
 *
 * 外壳**不加卡片 chrome**：塞进来的编辑器面板（MultiAngleEditorPanel /
 * LightEditorPanel）本身就是自带圆角与背景的 600px 卡片，外壳再包一层会出现
 * 双层边框。视口不够高时整体可滚动，避免 600×~430 的面板被裁切。
 */
/**
 * 把关闭回调包成「本次挂载内只放行一次」。
 *
 * 必需，因为两个编辑器面板自己也带「点击面板外即 onClose」的 document 捕获监听
 * （MultiAngleEditorPanel / LightEditorPanel 都有）：点遮罩会同时命中面板的监听
 * 和外壳的 onClick，不去重宿主就会收到两次关闭。调用方要把**同一个**包装后的
 * 回调同时交给外壳和内容层，否则两条路径各自持有原始回调，去重不生效。
 */
export function useCloseOnce(onClose: () => void): () => void {
  const closedRef = useRef(false);
  return useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose();
  }, [onClose]);
}

export function AssetBoardEditorDialog({
  label,
  onClose,
  children,
}: AssetBoardEditorDialogProps): ReactElement | null {
  useEffect(() => {
    // 两个面板都没有自己的 Esc 关闭，这里补上。
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 z-[300] flex items-center justify-center overflow-y-auto bg-black/72 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="my-auto" onClick={(event) => event.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
