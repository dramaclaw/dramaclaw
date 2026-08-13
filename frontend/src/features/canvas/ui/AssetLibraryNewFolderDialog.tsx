// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// 「新建文件夹」弹窗。只收一个名字，重名/超长由后端判定并回显在输入框下方。
// 它可能开在「上传资产」弹窗之上（保存位置那里也能现建文件夹），所以 z-index
// 通过 layer 拉高，不写死。
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FOLDER_NAME_MAX_LEN } from './assetLibraryItems';

export interface AssetLibraryNewFolderDialogProps {
  open: boolean;
  onClose: () => void;
  /** 抛错即视为失败，错误信息直接显示在输入框下方，弹窗保持打开。 */
  onSubmit: (name: string) => Promise<void>;
  /** 叠在上传弹窗之上时传更高的层级。 */
  z?: number;
  /** 重命名复用同一个弹窗，只换标题与初始值。 */
  title?: string;
  initialName?: string;
}

export function AssetLibraryNewFolderDialog({
  open,
  onClose,
  onSubmit,
  z = 320,
  title = '新建文件夹',
  initialName = '',
}: AssetLibraryNewFolderDialogProps) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setError(null);
      setSubmitting(false);
    }
  }, [open, initialName]);

  if (typeof document === 'undefined' || !open) return null;

  const clean = name.trim();
  const canSubmit = clean.length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(clean);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // 必须在 finally 里复位：成功时弹窗会被关掉，这次 setState 无关紧要；但
      // handler 也可能什么都没做就 return（比如 project 还是 null），那时只在
      // catch 里复位就等于把「保存」永久按灰，用户连错误提示都看不到。
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: z }}
      role="dialog"
      aria-label={title}
    >
      <div className="absolute inset-0 bg-black/55" onClick={onClose} />
      <div className="relative w-[min(600px,90vw)] overflow-hidden rounded-[10px] border border-white/[0.12] bg-[#1b1c22] shadow-[0_18px_48px_rgba(0,0,0,0.5)]">
        <div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-3.5">
          <h3 className="text-sm font-semibold text-text-dark">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted/90 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4">
          <label
            htmlFor="asset-folder-name"
            className="mb-2 block text-xs text-text-muted/90"
          >
            文件夹名称 <span className="text-red-400">*</span>
          </label>
          {/* 全局 --radius 是 1rem，rounded-md 落在 36px 高的输入框上会圆成胶囊，
              所以这里按项目里输入类控件的惯例写死 6px。 */}
          <div className="flex items-center rounded-[6px] border border-white/[0.10] bg-white/[0.04] px-3 focus-within:border-white/[0.22]">
            <input
              id="asset-folder-name"
              value={name}
              autoFocus
              maxLength={FOLDER_NAME_MAX_LEN}
              placeholder="请输入文件夹名称"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleSubmit();
              }}
              className="h-9 flex-1 bg-transparent text-sm text-text-dark outline-none placeholder:text-text-muted/50"
            />
            <span className="ml-2 shrink-0 text-[11px] text-text-muted/60">
              {name.length}/{FOLDER_NAME_MAX_LEN}
            </span>
          </div>
          {error && (
            <div className="mt-2 text-[11px] text-red-400">{error}</div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 pb-4">
          <Button
            size="sm"
            variant="ghost"
            className="px-4 text-text-muted hover:text-text-dark"
            onClick={onClose}
          >
            取消
          </Button>
          <Button
            size="sm"
            className="bg-white px-4 text-[#15161b] hover:bg-white/90"
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
          >
            {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            保存
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
