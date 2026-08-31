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
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronUp,
  FolderPlus,
  Music,
  Plus,
  UploadCloud,
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
  const { t } = useTranslation();
  const [isDragging, setIsDragging] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);

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
    setNewFolderOpen(false);
    setIsDragging(false);
    setFileError(null);
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

  useEffect(() => {
    if (!open || newFolderOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (folderOpen || categoryOpen) {
        setFolderOpen(false);
        setCategoryOpen(false);
      } else {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [categoryOpen, folderOpen, newFolderOpen, onClose, open]);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const next: PickedFile[] = [];
      let rejected = 0;
      const known = new Set(
        pickedRef.current.map(
          (pick) => `${pick.file.name}:${pick.file.size}:${pick.file.lastModified}`,
        ),
      );
      Array.from(files).forEach((file) => {
        const kind = mediaOfFile(file);
        const signature = `${file.name}:${file.size}:${file.lastModified}`;
        if (!kind || !media.includes(kind)) {
          rejected += 1;
          return;
        }
        if (known.has(signature)) return;
        known.add(signature);
        next.push({
          id: pickId(),
          file,
          media: kind,
          previewUrl: URL.createObjectURL(file),
        });
      });
      if (next.length > 0) setPicked((prev) => [...prev, ...next]);
      setFileError(
        rejected > 0
          ? t('canvas.assetLibrary.upload.unsupportedRejected', { count: rejected })
          : null,
      );
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
    'flex h-10 w-full items-center justify-between rounded-sm border border-[var(--ui-border-soft)] bg-[rgba(var(--bg-rgb)/0.5)] px-3 text-xs transition-[border-color,background-color] hover:border-[var(--ui-border-strong)] hover:bg-[rgba(var(--bg-rgb)/0.65)]';

  return createPortal(
    <div
      className="fixed inset-0 z-[310] flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={t('canvas.assetLibrary.upload.title')}
    >
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="ui-scrollbar relative flex max-h-[88vh] w-[min(860px,92vw)] flex-col overflow-y-auto rounded-xl border border-[var(--ui-border-strong)] bg-[var(--ui-surface-modal)] shadow-[0_18px_48px_rgba(0,0,0,0.5)]">
        <div className="flex items-start justify-between gap-4 px-5 pb-3 pt-5">
          <div>
            <h3 className="text-lg font-semibold text-foreground">{t('canvas.assetLibrary.upload.title')}</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('canvas.assetLibrary.upload.subtitle')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title={t('canvas.assetLibrary.close')}
            aria-label={t('canvas.assetLibrary.close')}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-[rgba(var(--bg-rgb)/0.5)] hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 gap-4 px-5 pb-4 md:grid-cols-[minmax(0,1fr)_260px]">
          {/* ── 左：选文件 ── */}
          <div
            className={`ui-scrollbar flex h-[260px] min-w-0 flex-col overflow-y-auto rounded-lg border bg-[rgba(var(--bg-rgb)/0.36)] transition-[border-color,background-color] md:h-[340px] ${
              isDragging
                ? 'border-primary bg-primary/5'
                : 'border-[var(--ui-border-soft)]'
            }`}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={(event) => {
              if (event.currentTarget === event.target) setIsDragging(false);
            }}
            onDrop={(event) => {
              event.preventDefault();
              setIsDragging(false);
              if (event.dataTransfer?.files?.length) {
                addFiles(event.dataTransfer.files);
              }
            }}
          >
            <input
              ref={fileInputRef}
              type="file"
              aria-label={t('canvas.assetLibrary.upload.pickLocalFiles')}
              accept={accept}
              multiple
              className="hidden"
              onChange={(event) => {
                if (event.target.files) addFiles(event.target.files);
                event.target.value = '';
              }}
            />
            {picked.length === 0 ? (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label={t('canvas.assetLibrary.upload.pickFiles')}
                className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground transition-colors hover:text-foreground"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[rgba(var(--bg-rgb)/0.55)] text-primary">
                  <UploadCloud className="h-5 w-5" />
                </span>
                <span>
                  <span className="block text-sm font-medium text-foreground">
                    {t('canvas.assetLibrary.upload.dropHint')}
                  </span>
                  <span className="mt-1.5 block text-xs text-muted-foreground">
                    {t('canvas.assetLibrary.upload.supports', { list: media.map((kind) => MEDIA_HINT[kind]).join(t('canvas.assetLibrary.upload.listSeparator')) })}
                  </span>
                </span>
              </button>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-3">
                  <span className="text-xs text-muted-foreground">
                    {t('canvas.assetLibrary.upload.selectedCount', { count: picked.length })}
                  </span>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-xs text-primary transition-colors hover:bg-secondary"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t('canvas.assetLibrary.upload.addMore')}
                  </button>
                </div>
                <div className="flex flex-wrap gap-2.5 px-4 pb-4">
                  {picked.map((p) => (
                    <div
                      key={p.id}
                      className="group relative h-[104px] w-[104px] overflow-hidden rounded-sm border border-[var(--ui-border-soft)] bg-[rgba(var(--bg-rgb)/0.55)]"
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
                        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                          <Music className="h-8 w-8" />
                        </div>
                      )}
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/85 to-black/30 px-2 pb-1.5 pt-5 text-xs text-white/90">
                        {p.file.name}
                      </div>
                      <button
                        type="button"
                        onClick={() => removePicked(p.id)}
                        aria-label={t('canvas.assetLibrary.upload.removeFile', { name: p.file.name })}
                        className="absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity hover:bg-black/80 group-hover:opacity-100 focus:opacity-100"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
            {fileError ? (
              <div
                role="alert"
                className="mx-4 mb-3 flex items-center gap-1.5 text-xs text-destructive"
              >
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                {fileError}
              </div>
            ) : null}
          </div>

          {/* ── 右：保存位置 + 标签 ── */}
          <div className="rounded-lg border border-[var(--ui-border-soft)] bg-[rgba(var(--bg-rgb)/0.28)] p-4">
            <h4 className="text-sm font-semibold text-foreground">{t('canvas.assetLibrary.upload.settings')}</h4>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('canvas.assetLibrary.upload.settingsHint')}
            </p>
            <div className="mt-4 space-y-4">
              <div className="relative">
                <div className="mb-1.5 text-xs font-medium text-foreground">
                  {t('canvas.assetLibrary.upload.destination')} <span className="text-destructive">*</span>
                </div>
                <button
                  type="button"
                  aria-label={t('canvas.assetLibrary.upload.pickDestination')}
                  onClick={() => {
                    setFolderOpen((prev) => !prev);
                    setCategoryOpen(false);
                  }}
                  className={fieldButtonClass}
                >
                  <span
                    className={
                      selectedFolder
                        ? 'text-foreground'
                        : 'text-muted-foreground'
                    }
                  >
                    {selectedFolder?.label ?? t('canvas.assetLibrary.upload.chooseFolder')}
                  </span>
                  {folderOpen ? (
                    <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </button>
                {folderOpen && (
                  <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-[var(--ui-border-soft)] bg-[rgba(var(--surface-rgb)/0.99)] py-1 shadow-[0_12px_28px_rgba(0,0,0,0.45)]">
                    <div className="flex items-center justify-between px-3 py-2 text-xs font-medium text-foreground">
                      {t('canvas.assetLibrary.upload.projectLibrary')}
                      <button
                        type="button"
                        aria-label={t('canvas.assetLibrary.newFolder')}
                        title={t('canvas.assetLibrary.newFolder')}
                        onClick={() => setNewFolderOpen(true)}
                        className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-primary transition-colors hover:bg-secondary"
                      >
                        <FolderPlus className="h-3.5 w-3.5" />
                        <span>{t('canvas.assetLibrary.upload.create')}</span>
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
                          className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-accent ${
                            folder.key === folderKey
                              ? 'text-foreground'
                              : 'text-muted-foreground'
                          }`}
                        >
                          <span className="truncate">{folder.label}</span>
                          {folder.key === folderKey ? (
                            <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                          ) : null}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="relative">
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-foreground">
                  {t('canvas.assetLibrary.upload.tag')}{' '}
                  <span className="font-normal text-muted-foreground">{t('canvas.assetLibrary.upload.optional')}</span>
                </div>
                <button
                  type="button"
                  aria-label={t('canvas.assetLibrary.upload.pickTag')}
                  onClick={() => {
                    setCategoryOpen((prev) => !prev);
                    setFolderOpen(false);
                  }}
                  className={fieldButtonClass}
                >
                  <span
                    className={
                      selectedCategory
                        ? 'text-foreground'
                        : 'text-muted-foreground'
                    }
                  >
                    {selectedCategory?.label ?? t('canvas.assetLibrary.upload.choose')}
                  </span>
                  {categoryOpen ? (
                    <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </button>
                {categoryOpen && (
                  <div className="ui-scrollbar absolute z-10 mt-1 max-h-[180px] w-full overflow-y-auto rounded-lg border border-[var(--ui-border-soft)] bg-[rgba(var(--surface-rgb)/0.99)] py-1 shadow-[0_12px_28px_rgba(0,0,0,0.45)]">
                    {categories.map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => {
                          setCategory(item.key);
                          setCategoryOpen(false);
                        }}
                        className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-accent ${
                          item.key === category
                            ? 'text-foreground'
                            : 'text-muted-foreground'
                        }`}
                      >
                        <span>{item.label}</span>
                        {item.key === category ? (
                          <Check className="h-3.5 w-3.5 text-primary" />
                        ) : null}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 pb-5">
          <Button
            size="sm"
            variant="ghost"
            className="px-4 text-muted-foreground hover:text-foreground"
            onClick={onClose}
          >
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            className="bg-primary px-4 text-primary-foreground hover:bg-primary/90"
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {picked.length > 0 ? t('canvas.assetLibrary.upload.submitCount', { count: picked.length }) : t('canvas.assetLibrary.upload.submit')}
          </Button>
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
