// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// 「修改封面」弹窗：从该文件夹自己的图片素材里挑一张当封面。
//
// 只列图片——视频抽帧要解码、音频压根没有画面，都不适合当封面；文件夹里一张图
// 都没有时给一句空态提示，而不是弹一个空网格。封面存的是素材 URL 本身，所以这里
// 不涉及上传，素材被删掉后封面自然回落到默认图标。
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { folderCoverUrl, type AssetFolder } from './assetLibraryItems';

export interface AssetLibraryFolderCoverDialogProps {
  open: boolean;
  folder: AssetFolder | null;
  onClose: () => void;
  /** 抛错即视为失败，错误信息显示在底部，弹窗保持打开。 */
  onSubmit: (cover: string) => Promise<void>;
}

export function AssetLibraryFolderCoverDialog({
  open,
  folder,
  onClose,
  onSubmit,
}: AssetLibraryFolderCoverDialogProps) {
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 每次打开预选当前封面，用户只想换别的时一眼能看出现在是哪张。
  useEffect(() => {
    if (!open) return;
    setPicked(folder ? folderCoverUrl(folder) : null);
    setError(null);
    setSubmitting(false);
  }, [open, folder]);

  if (typeof document === 'undefined' || !open || !folder) return null;

  const images = folder.items.filter(
    (entry) => entry.media === 'image' && entry.url,
  );
  const canSubmit = Boolean(picked) && !submitting;

  const handleSubmit = async () => {
    if (!picked || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(picked);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[320] flex items-center justify-center"
      role="dialog"
      aria-label="修改封面"
    >
      <div className="absolute inset-0 bg-black/55" onClick={onClose} />
      <div className="relative flex max-h-[80vh] w-[min(720px,92vw)] flex-col overflow-hidden rounded-[10px] border border-white/[0.12] bg-[#1b1c22] shadow-[0_18px_48px_rgba(0,0,0,0.5)]">
        <div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-3.5">
          <h3 className="text-sm font-semibold text-text-dark">
            修改封面 · {folder.label}
          </h3>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted/90 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {images.length === 0 ? (
            <div className="py-10 text-center text-xs text-text-muted/70">
              这个文件夹里还没有图片素材，先上传一张再来设封面。
            </div>
          ) : (
            <div
              className="grid gap-3"
              style={{
                gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
              }}
            >
              {images.map((entry, idx) => (
                <button
                  key={entry.id ?? `img-${idx}`}
                  type="button"
                  onClick={() => setPicked(entry.url)}
                  aria-label={`选择封面 ${entry.name}`}
                  className={`relative aspect-square overflow-hidden rounded-[8px] border transition-colors ${
                    picked === entry.url
                      ? 'border-accent/70 ring-1 ring-accent/45'
                      : 'border-white/[0.10] hover:border-white/[0.24]'
                  }`}
                >
                  <img
                    src={resolveImageDisplayUrl(entry.url)}
                    alt={entry.name}
                    className="h-full w-full object-cover"
                    draggable={false}
                  />
                </button>
              ))}
            </div>
          )}
          {error && <div className="mt-3 text-[11px] text-red-400">{error}</div>}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 px-5 pb-4 pt-1">
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
