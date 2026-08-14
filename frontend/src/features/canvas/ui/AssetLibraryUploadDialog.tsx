// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// 「上传资产」弹窗：左边挑文件，右边选保存位置（必填）和标签（可选）。
//
// 保存位置 = 文件夹，标签 = 类目，两者独立——同一个文件夹里可以放不同标签的素材，
// 顶部类目 tab 按标签筛。这里只负责收集参数，真正的上传仍由 AssetLibraryModal
// 执行（进度条和失败重试都在那边的卡片上）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown,
  ChevronUp,
  Image as ImageIcon,
  Music,
  Plus,
  Video as VideoIcon,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { AssetLibraryNewFolderDialog } from './AssetLibraryNewFolderDialog';
import {
  mediaOfFile,
  type AssetCategory,
  type AssetCategoryDef,
  type AssetFolder,
  type AssetFolderKey,
  type AssetLibraryMedia,
} from './assetLibraryItems';

export interface AssetLibraryUploadPick {
  file: File;
  media: AssetLibraryMedia;
}

export interface AssetLibraryUploadDialogProps {
  open: boolean;
  /** 可作为保存位置的文件夹（主线已被调用方剔除）。 */
  folders: AssetFolder[];
  /** 打开时默认选中的保存位置，通常是当前正在看的文件夹。 */
  defaultFolderKey?: AssetFolderKey | null;
  /** 标签选项，已按 allowedMedia 过滤。 */
  categories: AssetCategoryDef[];
  /** 调用方允许的媒介，决定 accept 与提示文案。 */
  allowedMedia?: AssetLibraryMedia[];
  /** 现场新建文件夹，返回新文件夹的 key，弹窗会直接选中它。 */
  onCreateFolder: (name: string) => Promise<AssetFolderKey>;
  onSubmit: (
    picks: AssetLibraryUploadPick[],
    folder: AssetFolderKey,
    category: AssetCategory | null,
  ) => void;
  onClose: () => void;
}

interface PickedFile extends AssetLibraryUploadPick {
  id: string;
  previewUrl: string;
}

const MEDIA_ACCEPT: Record<AssetLibraryMedia, string> = {
  image: 'image/*',
  video: 'video/*',
  audio: 'audio/*',
};
const MEDIA_HINT: Record<AssetLibraryMedia, string> = {
  image: 'jpg/jpeg/png/webp',
  video: 'mp4',
  audio: 'mp3/wav',
};
const MEDIA_ICON = {
  image: ImageIcon,
  video: VideoIcon,
  audio: Music,
} as const;

function pickId(): string {
  return `pick_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function AssetLibraryUploadDialog({
  open,
  folders,
  defaultFolderKey,
  categories,
  allowedMedia,
  onCreateFolder,
  onSubmit,
  onClose,
}: AssetLibraryUploadDialogProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const pickedRef = useRef<PickedFile[]>([]);
  pickedRef.current = picked;
  const [folderKey, setFolderKey] = useState<AssetFolderKey | null>(null);
  const [category, setCategory] = useState<AssetCategory | null>(null);
  const [folderOpen, setFolderOpen] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);

  const media = useMemo<AssetLibraryMedia[]>(
    () => allowedMedia ?? ['image', 'video', 'audio'],
    [allowedMedia],
  );
  const accept = media.map((m) => MEDIA_ACCEPT[m]).join(',');

  // 每次打开都从干净状态起：保存位置带上当前正在看的文件夹，标签留空（不猜）。
  useEffect(() => {
    if (!open) return;
    setFolderKey(defaultFolderKey ?? null);
    setCategory(null);
    setFolderOpen(false);
    setCategoryOpen(false);
  }, [open, defaultFolderKey]);

  useEffect(() => {
    if (open) return;
    pickedRef.current.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    setPicked([]);
  }, [open]);

  useEffect(
    () => () => {
      pickedRef.current.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    },
    [],
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const next: PickedFile[] = [];
      Array.from(files).forEach((file) => {
        const kind = mediaOfFile(file);
        if (!kind || !media.includes(kind)) return;
        next.push({
          id: pickId(),
          file,
          media: kind,
          previewUrl: URL.createObjectURL(file),
        });
      });
      if (next.length > 0) setPicked((prev) => [...prev, ...next]);
    },
    [media],
  );

  const removePicked = useCallback((id: string) => {
    setPicked((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }, []);

  if (typeof document === 'undefined' || !open) return null;

  const selectedFolder = folders.find((folder) => folder.key === folderKey);
  const selectedCategory = categories.find((c) => c.key === category);
  const canSubmit = picked.length > 0 && Boolean(folderKey);

  const handleSubmit = () => {
    if (!canSubmit || !folderKey) return;
    onSubmit(
      picked.map(({ file, media: kind }) => ({ file, media: kind })),
      folderKey,
      category,
    );
    onClose();
  };

  const fieldButtonClass =
    'flex h-9 w-full items-center justify-between rounded-[6px] border border-white/[0.10] bg-white/[0.04] px-3 text-xs transition-colors hover:border-white/[0.20]';

  return createPortal(
    <div
      className="fixed inset-0 z-[310] flex items-center justify-center"
      role="dialog"
      aria-label="上传资产"
    >
      <div className="absolute inset-0 bg-black/55" onClick={onClose} />
      <div className="relative flex w-[min(940px,92vw)] flex-col overflow-hidden rounded-[10px] border border-white/[0.12] bg-[#1b1c22] shadow-[0_18px_48px_rgba(0,0,0,0.5)]">
        <div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-3.5">
          <h3 className="text-sm font-semibold text-text-dark">上传资产</h3>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-muted/90 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex gap-6 px-5 py-4">
          {/* ── 左：选文件 ── */}
          <div
            className="ui-scrollbar h-[320px] flex-1 overflow-y-auto rounded-md border border-white/[0.08] bg-white/[0.02] p-4"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (event.dataTransfer?.files?.length) {
                addFiles(event.dataTransfer.files);
              }
            }}
          >
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label="选择文件"
                className="flex h-[120px] w-[120px] items-center justify-center rounded-md border border-dashed border-white/[0.16] text-text-muted/60 transition-colors hover:border-white/[0.30] hover:text-text-dark"
              >
                <Plus className="h-7 w-7" strokeWidth={1.5} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept={accept}
                multiple
                className="hidden"
                onChange={(event) => {
                  if (event.target.files) addFiles(event.target.files);
                  event.target.value = '';
                }}
              />
              {picked.map((p) => (
                <div
                  key={p.id}
                  className="group relative h-[120px] w-[120px] overflow-hidden rounded-md border border-white/[0.10] bg-white/[0.04]"
                  title={p.file.name}
                >
                  {p.media === 'image' ? (
                    <img
                      src={p.previewUrl}
                      alt=""
                      className="h-full w-full object-cover"
                      draggable={false}
                    />
                  ) : p.media === 'video' ? (
                    <video
                      src={p.previewUrl}
                      className="h-full w-full object-cover"
                      muted
                      playsInline
                      preload="metadata"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-text-muted/60">
                      <Music className="h-8 w-8" />
                    </div>
                  )}
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/65 px-1.5 py-1 text-[10px] text-white/85">
                    {p.file.name}
                  </div>
                  <button
                    type="button"
                    onClick={() => removePicked(p.id)}
                    aria-label={`移除 ${p.file.name}`}
                    className="absolute right-1 top-1 inline-flex h-5 w-5 items-center justify-center rounded bg-black/60 text-white opacity-0 transition-opacity hover:bg-black/80 group-hover:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* ── 右：保存位置 + 标签 ── */}
          <div className="w-[240px] shrink-0 space-y-4">
            <div className="relative">
              <div className="mb-1.5 text-xs text-text-muted/90">
                保存位置 <span className="text-red-400">*</span>
              </div>
              <button
                type="button"
                aria-label="选择保存位置"
                onClick={() => {
                  setFolderOpen((prev) => !prev);
                  setCategoryOpen(false);
                }}
                className={fieldButtonClass}
              >
                <span
                  className={
                    selectedFolder ? 'text-text-dark' : 'text-text-muted/55'
                  }
                >
                  {selectedFolder?.label ?? '请选择文件夹'}
                </span>
                {folderOpen ? (
                  <ChevronUp className="h-3.5 w-3.5 text-text-muted/70" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 text-text-muted/70" />
                )}
              </button>
              {folderOpen && (
                <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-[6px] border border-white/[0.12] bg-[#232429] py-1 shadow-[0_12px_28px_rgba(0,0,0,0.45)]">
                  <div className="flex items-center justify-between border-b border-white/[0.08] px-3 py-1.5 text-xs text-text-dark">
                    项目资产库
                    <button
                      type="button"
                      aria-label="新建文件夹"
                      title="新建文件夹"
                      onClick={() => setNewFolderOpen(true)}
                      className="inline-flex h-5 w-5 items-center justify-center rounded text-text-muted/80 transition-colors hover:bg-white/[0.10] hover:text-text-dark"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="ui-scrollbar max-h-[180px] overflow-y-auto">
                    {folders.map((folder) => (
                      <button
                        key={folder.key}
                        type="button"
                        onClick={() => {
                          setFolderKey(folder.key);
                          setFolderOpen(false);
                        }}
                        className={`block w-full truncate px-5 py-1.5 text-left text-xs transition-colors hover:bg-white/[0.08] ${
                          folder.key === folderKey
                            ? 'text-text-dark'
                            : 'text-text-muted/85'
                        }`}
                      >
                        {folder.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="relative">
              <div className="mb-1.5 text-xs text-text-muted/90">标签</div>
              <button
                type="button"
                aria-label="选择标签"
                onClick={() => {
                  setCategoryOpen((prev) => !prev);
                  setFolderOpen(false);
                }}
                className={fieldButtonClass}
              >
                <span
                  className={
                    selectedCategory ? 'text-text-dark' : 'text-text-muted/55'
                  }
                >
                  {selectedCategory?.label ?? '请选择'}
                </span>
                {categoryOpen ? (
                  <ChevronUp className="h-3.5 w-3.5 text-text-muted/70" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 text-text-muted/70" />
                )}
              </button>
              {categoryOpen && (
                <div className="ui-scrollbar absolute z-10 mt-1 max-h-[180px] w-full overflow-y-auto rounded-[6px] border border-white/[0.12] bg-[#232429] py-1 shadow-[0_12px_28px_rgba(0,0,0,0.45)]">
                  {categories.map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => {
                        setCategory(item.key);
                        setCategoryOpen(false);
                      }}
                      className={`block w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-white/[0.08] ${
                        item.key === category
                          ? 'text-text-dark'
                          : 'text-text-muted/85'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-end justify-between gap-4 px-5 pb-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-muted/60">
            <span>支持的文件格式</span>
            {media.map((kind) => {
              const Icon = MEDIA_ICON[kind];
              return (
                <span key={kind} className="inline-flex items-center gap-1">
                  <Icon className="h-3.5 w-3.5" />
                  {MEDIA_HINT[kind]}
                </span>
              );
            })}
          </div>
          <div className="flex shrink-0 items-center gap-2">
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
              onClick={handleSubmit}
            >
              保存
            </Button>
          </div>
        </div>
      </div>

      <AssetLibraryNewFolderDialog
        open={newFolderOpen}
        z={330}
        onClose={() => setNewFolderOpen(false)}
        onSubmit={async (name) => {
          const key = await onCreateFolder(name);
          setFolderKey(key);
          setNewFolderOpen(false);
          setFolderOpen(false);
        }}
      />
    </div>,
    document.body,
  );
}
