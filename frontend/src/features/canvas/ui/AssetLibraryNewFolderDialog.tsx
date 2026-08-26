// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// 「新建文件夹」弹窗。只收一个名字，重名/超长由后端判定并回显在输入框下方。
// 它可能开在「上传资产」弹窗之上（保存位置那里也能现建文件夹），所以 z-index
// 通过 layer 拉高，不写死。
//
// 文件夹改名、素材改名也复用这一个：都是「弹个框收一个名字」，差别只在标题、
// 字段名和长度上限，各自传进来即可。
import { useEffect, useId, useState } from 'react';
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
  /** 输入框上方的字段名。改素材名时传「资产名称」。 */
  fieldLabel?: string;
  placeholder?: string;
  /** 字数上限，与后端校验保持一致。 */
  maxLength?: number;
}

export function AssetLibraryNewFolderDialog({
  open,
  onClose,
  onSubmit,
  z = 320,
  title = '新建文件夹',
  initialName = '',
  fieldLabel = '文件夹名称',
  placeholder = '请输入文件夹名称',
  maxLength = FOLDER_NAME_MAX_LEN,
}: AssetLibraryNewFolderDialogProps) {
  // 素材改名弹窗和文件夹弹窗可能同时挂在树上，写死 id 会重复。
  const inputId = useId();
  const errorId = useId();
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

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose, submitting]);

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
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="absolute inset-0 bg-black/60"
        onClick={() => {
          if (!submitting) onClose();
        }}
      />
      <div className="relative w-[min(420px,90vw)] overflow-hidden rounded-xl border border-[var(--ui-border-strong)] bg-[var(--ui-surface-modal)] shadow-[0_18px_48px_rgba(0,0,0,0.5)]">
        <div className="flex items-start justify-between gap-4 px-5 pb-2 pt-5">
          <div>
            <h3 className="text-lg font-semibold text-foreground">{title}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {title === '新建文件夹'
                ? '创建后可立即用于归档和上传资产'
                : '修改后会同步更新资产库中的显示名称'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            aria-label="关闭"
            disabled={submitting}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-[rgba(var(--bg-rgb)/0.5)] hover:text-foreground disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 pb-4 pt-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <label
              htmlFor={inputId}
              className="text-xs font-medium text-foreground"
            >
              {fieldLabel} <span className="text-destructive">*</span>
            </label>
            <span className="text-xs text-muted-foreground">
              {name.length}/{maxLength}
            </span>
          </div>
          <div className="flex items-center rounded-sm border border-[var(--ui-border-soft)] bg-[rgba(var(--bg-rgb)/0.5)] px-3 transition-[border-color,box-shadow] focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15">
            <input
              id={inputId}
              value={name}
              autoFocus
              maxLength={maxLength}
              placeholder={placeholder}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleSubmit();
              }}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? errorId : undefined}
              className="h-10 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
            />
          </div>
          {error && (
            <div
              id={errorId}
              role="alert"
              className="mt-2 text-xs text-destructive"
            >
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 pb-5">
          <Button
            size="sm"
            variant="ghost"
            className="px-4 text-muted-foreground hover:text-foreground"
            onClick={onClose}
          >
            取消
          </Button>
          <Button
            size="sm"
            className="bg-primary px-4 text-primary-foreground hover:bg-primary/90"
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
