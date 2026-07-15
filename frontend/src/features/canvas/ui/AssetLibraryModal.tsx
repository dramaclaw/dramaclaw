// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  Loader2,
  Music,
  RefreshCw,
  Trash2,
  Upload,
  Video as VideoIcon,
  X,
} from 'lucide-react';

import {
  deleteFreezoneVideoCharacterLibraryItem,
  fetchFreezoneVideoCharacterLibrary,
  submitFreezoneAddVideoCharacterLibraryItem,
  syncFreezoneAssetLibraryFromMainline,
  uploadFreezoneImage,
  uploadFreezoneVideo,
  type FreezoneAssetLibraryMedia,
  type FreezoneAssetLibrarySource,
} from '@/api/ops';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { Button } from '@/components/ui/button';

const ASSET_LIBRARY_MODAL_CLASS =
  'relative flex h-[min(720px,82vh)] w-[min(1120px,92vw)] flex-col overflow-hidden rounded-[10px] border border-white/[0.12] bg-[#15161b]/96 shadow-[0_18px_48px_rgba(0,0,0,0.45)] backdrop-blur-md';
const ASSET_LIBRARY_CARD_CLASS =
  'overflow-hidden rounded-[12px] border border-white/[0.10] bg-white/[0.04] transition-colors';
const ASSET_LIBRARY_CARD_HOVER_CLASS =
  'hover:border-white/[0.18] hover:bg-white/[0.06]';
const ASSET_LIBRARY_UPLOAD_CARD_CLASS =
  'flex aspect-square flex-col items-center justify-center gap-3 rounded-[12px] border border-dashed border-white/[0.12] bg-white/[0.04] px-4 text-text-dark transition-colors hover:border-white/[0.18] hover:bg-white/[0.06]';

export type AssetLibraryMedia = FreezoneAssetLibraryMedia;

interface PendingUpload {
  id: string;
  fileName: string;
  previewUrl: string;
  media: AssetLibraryMedia;
  status: 'uploading' | 'failed';
  error?: string;
}

interface LibraryItem {
  id: string | null;
  name: string;
  media: AssetLibraryMedia;
  source: FreezoneAssetLibrarySource;
  /** 该条目在其 media 类型下的主展示 / 引用地址。 */
  url: string;
  raw: Record<string, unknown>;
}

export interface AssetLibrarySelection {
  media: AssetLibraryMedia;
  url: string;
  name: string;
}

export interface AssetLibraryModalProps {
  open: boolean;
  project: string | null;
  onClose: () => void;
  onSuccess?: () => void;
  onConfirm?: (selections: AssetLibrarySelection[]) => void;
  maxSelectable?: number;
  /** 允许的媒体类型 Tab;缺省三类都开。生图/图片编辑节点只传 ['image']。 */
  allowedMedia?: AssetLibraryMedia[];
}

type AssetTabKey = 'image' | 'scene' | 'video' | 'audio';

interface AssetTab {
  key: AssetTabKey;
  label: string;
  /** 该 Tab 对应的媒体类型——决定上传接口、卡片渲染与 accept。 */
  media: AssetLibraryMedia;
  accept: string;
  /** 是否允许在该 Tab 本地上传。场景为主线同步的只读类目。 */
  allowUpload: boolean;
  /** 该 Tab 展示哪些库条目。 */
  matches: (entry: LibraryItem) => boolean;
}

// 场景在数据上仍是 image（master 静帧），但按产品要求单独成一个浏览 Tab；
// 「图片」Tab 因此要排除掉场景条目，避免场景静帧混在人物/道具参考图里。
const ASSET_TABS: AssetTab[] = [
  {
    key: 'image',
    label: '图片',
    media: 'image',
    accept: 'image/*',
    allowUpload: true,
    matches: (e) => e.media === 'image' && e.source !== 'scene',
  },
  {
    key: 'scene',
    label: '场景',
    media: 'image',
    accept: 'image/*',
    allowUpload: false,
    matches: (e) => e.media === 'image' && e.source === 'scene',
  },
  {
    key: 'video',
    label: '视频',
    media: 'video',
    accept: 'video/*',
    allowUpload: true,
    matches: (e) => e.media === 'video',
  },
  {
    key: 'audio',
    label: '音频',
    media: 'audio',
    accept: 'audio/*',
    allowUpload: true,
    matches: (e) => e.media === 'audio',
  },
];

const SOURCE_LABEL: Record<FreezoneAssetLibrarySource, string> = {
  upload: '上传',
  character: '人物',
  scene: '场景',
  prop: '道具',
};

function makeId(): string {
  return `al_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function itemUrl(media: AssetLibraryMedia, it: Record<string, unknown>): string {
  if (media === 'video') return typeof it.video_url === 'string' ? it.video_url : '';
  if (media === 'audio') return typeof it.audio_url === 'string' ? it.audio_url : '';
  const urls = it.image_urls ?? it.imageUrls ?? it.images;
  if (Array.isArray(urls)) {
    const first = urls.find((u): u is string => typeof u === 'string');
    if (first) return first;
  }
  return typeof it.cover_url === 'string' ? it.cover_url : '';
}

function normalizeLibraryList(payload: unknown): LibraryItem[] {
  let arr: unknown[] = [];
  if (Array.isArray(payload)) {
    arr = payload;
  } else if (payload && typeof payload === 'object') {
    const rec = payload as Record<string, unknown>;
    for (const key of ['items', 'data', 'characters', 'list', 'records']) {
      if (Array.isArray(rec[key])) {
        arr = rec[key] as unknown[];
        break;
      }
    }
  }
  return arr
    .filter(
      (it): it is Record<string, unknown> =>
        Boolean(it && typeof it === 'object' && !Array.isArray(it)),
    )
    .map((it) => {
      const idRaw = it.id ?? it.item_id ?? it.itemId ?? null;
      const id =
        typeof idRaw === 'string' ? idRaw : idRaw != null ? String(idRaw) : null;
      const name = typeof it.name === 'string' ? it.name : '';
      // 缺省 image 兼容老数据（历史条目没有 media 字段）。
      const mediaRaw = typeof it.media === 'string' ? it.media : 'image';
      const media: AssetLibraryMedia =
        mediaRaw === 'video' || mediaRaw === 'audio' ? mediaRaw : 'image';
      const sourceRaw = typeof it.source === 'string' ? it.source : 'upload';
      const source: FreezoneAssetLibrarySource =
        sourceRaw === 'character' ||
        sourceRaw === 'scene' ||
        sourceRaw === 'prop'
          ? sourceRaw
          : 'upload';
      return { id, name, media, source, url: itemUrl(media, it), raw: it };
    })
    .filter((it) => Boolean(it.url));
}

export function AssetLibraryModal({
  open,
  project,
  onClose,
  onSuccess,
  onConfirm,
  maxSelectable = 9,
  allowedMedia,
}: AssetLibraryModalProps) {
  const tabs = useMemo(
    () =>
      ASSET_TABS.filter(
        (tab) => !allowedMedia || allowedMedia.includes(tab.media),
      ),
    [allowedMedia],
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // 把 onSuccess 收进 ref，避免它进 initializeLibrary 依赖后，父组件每次渲染换新
  // 函数身份就触发「打开自动同步」effect 反复重跑。
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const pendingRef = useRef<PendingUpload[]>([]);
  pendingRef.current = pendingUploads;
  const [isDragging, setIsDragging] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [activeTabKey, setActiveTabKey] = useState<AssetTabKey>(
    tabs[0]?.key ?? 'image',
  );
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.key === activeTabKey) ?? tabs[0],
    [tabs, activeTabKey],
  );
  const activeMedia = activeTab?.media ?? 'image';

  // allowedMedia 变了(不同节点复用同一弹窗)时，把当前 Tab 收敛回允许集合。
  useEffect(() => {
    if (!tabs.some((tab) => tab.key === activeTabKey)) {
      setActiveTabKey(tabs[0]?.key ?? 'image');
    }
  }, [tabs, activeTabKey]);

  // 纯加载已有库：失败不弹红条(缺库文件/后端未就绪都当空处理)，返回加载到的条目。
  const refreshLibrary = useCallback(async (): Promise<LibraryItem[]> => {
    if (!project) return [];
    try {
      const payload = await fetchFreezoneVideoCharacterLibrary(project);
      const items = normalizeLibraryList(payload);
      setLibrary(items);
      return items;
    } catch (err) {
      console.warn('[asset-library] load failed, treat as empty', err);
      setLibrary([]);
      return [];
    }
  }, [project]);

  // 打开即自动同步：先加载已有库(静默兜底)，再从主线自动同步合并。只有当
  // 既无已有库、同步又失败时，才提示错误(通常代表后端还没重启/路由缺失)。
  const initializeLibrary = useCallback(
    async (isCancelled?: () => boolean) => {
      if (!project) return;
      setIsLoadingLibrary(true);
      setLibraryError(null);
      const base = await refreshLibrary();
      if (isCancelled?.()) return;
      setIsSyncing(true);
      try {
        const items = await syncFreezoneAssetLibraryFromMainline(project);
        if (isCancelled?.()) return;
        setLibrary(normalizeLibraryList(items));
        onSuccessRef.current?.();
      } catch (err) {
        if (isCancelled?.()) return;
        console.warn('[asset-library] auto sync failed', err);
        if (base.length === 0) {
          setLibraryError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!isCancelled?.()) {
          setIsSyncing(false);
          setIsLoadingLibrary(false);
        }
      }
    },
    [project, refreshLibrary],
  );

  useEffect(() => {
    if (!open || !project) return;
    // 弹窗在自动同步 resolve 前就关闭时，用 cancelled 丢弃过期结果，避免关闭态回填 library
    // 与 240ms 关闭重置 effect 打架。
    let cancelled = false;
    void initializeLibrary(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [open, project, initializeLibrary]);

  useEffect(() => {
    if (open) return;
    const timer = window.setTimeout(() => {
      pendingRef.current.forEach((p) => URL.revokeObjectURL(p.previewUrl));
      setPendingUploads([]);
      setLibrary([]);
      setLibraryError(null);
      setDeletingId(null);
      setIsDragging(false);
      setIsSyncing(false);
      setSelectedKeys([]);
    }, 240);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    return () => {
      pendingRef.current.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    };
  }, []);

  const handleSyncFromMainline = useCallback(async () => {
    if (!project || isSyncing) return;
    setIsSyncing(true);
    setLibraryError(null);
    try {
      const items = await syncFreezoneAssetLibraryFromMainline(project);
      setLibrary(normalizeLibraryList(items));
      onSuccess?.();
    } catch (err) {
      console.error('[asset-library] sync failed', err);
      setLibraryError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSyncing(false);
    }
  }, [project, isSyncing, onSuccess]);

  const removePending = useCallback((id: string) => {
    setPendingUploads((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }, []);

  const uploadOne = useCallback(
    async (entry: PendingUpload, file: File) => {
      if (!project) return;
      try {
        const uploaded =
          entry.media === 'image'
            ? await uploadFreezoneImage(project, file, file.name)
            : await uploadFreezoneVideo(project, file, file.name);
        const cleanUrl = uploaded.url.split('?')[0];
        await submitFreezoneAddVideoCharacterLibraryItem(project, {
          name: stripExtension(file.name),
          media: entry.media,
          imageUrls: entry.media === 'image' ? [cleanUrl] : undefined,
          videoUrl: entry.media === 'video' ? cleanUrl : undefined,
          audioUrl: entry.media === 'audio' ? cleanUrl : undefined,
        });
        URL.revokeObjectURL(entry.previewUrl);
        setPendingUploads((prev) => prev.filter((p) => p.id !== entry.id));
        await refreshLibrary();
        onSuccess?.();
      } catch (err) {
        console.error('[asset-library] upload failed', err);
        const message = err instanceof Error ? err.message : String(err);
        setPendingUploads((prev) =>
          prev.map((p) =>
            p.id === entry.id ? { ...p, status: 'failed', error: message } : p,
          ),
        );
      }
    },
    [project, refreshLibrary, onSuccess],
  );

  const acceptsFile = useCallback(
    (file: File, media: AssetLibraryMedia) => {
      if (media === 'image') return file.type.startsWith('image/');
      if (media === 'video') return file.type.startsWith('video/');
      return file.type.startsWith('audio/');
    },
    [],
  );

  const handleFiles = useCallback(
    (files: FileList | File[]) => {
      if (!project || !activeTab?.allowUpload) return;
      const media = activeMedia;
      const accepted: { entry: PendingUpload; file: File }[] = [];
      Array.from(files).forEach((file) => {
        if (!acceptsFile(file, media)) return;
        const entry: PendingUpload = {
          id: makeId(),
          fileName: file.name,
          previewUrl: URL.createObjectURL(file),
          media,
          status: 'uploading',
        };
        accepted.push({ entry, file });
      });
      if (accepted.length === 0) return;
      setPendingUploads((prev) => [...prev, ...accepted.map((a) => a.entry)]);
      accepted.forEach(({ entry, file }) => {
        void uploadOne(entry, file);
      });
    },
    [project, activeMedia, activeTab, acceptsFile, uploadOne],
  );

  const handleDeleteEntry = useCallback(
    async (entry: LibraryItem) => {
      if (!project || !entry.id) return;
      const confirmed = window.confirm(
        `确定要删除「${entry.name || entry.id}」？`,
      );
      if (!confirmed) return;
      setDeletingId(entry.id);
      try {
        await deleteFreezoneVideoCharacterLibraryItem(project, entry.id);
        await refreshLibrary();
      } catch (err) {
        console.error('[asset-library] delete failed', err);
        setLibraryError(err instanceof Error ? err.message : String(err));
      } finally {
        setDeletingId(null);
      }
    },
    [project, refreshLibrary],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);
      if (event.dataTransfer?.files?.length) {
        handleFiles(event.dataTransfer.files);
      }
    },
    [handleFiles],
  );

  const visibleItems = useMemo(
    () => (activeTab ? library.filter((entry) => activeTab.matches(entry)) : []),
    [library, activeTab],
  );
  const visiblePending = useMemo(
    () =>
      activeTab && activeTab.allowUpload
        ? pendingUploads.filter((p) => p.media === activeTab.media)
        : [],
    [pendingUploads, activeTab],
  );

  const isSelected = useCallback(
    (key: string) => selectedKeys.includes(key),
    [selectedKeys],
  );

  const selectionKey = useCallback(
    (entry: LibraryItem) =>
      `${entry.media}:${entry.id ?? `url:${entry.url}`}`,
    [],
  );

  const toggleSelect = useCallback(
    (key: string) => {
      setSelectedKeys((prev) => {
        if (prev.includes(key)) return prev.filter((k) => k !== key);
        // 每种媒介各自独立的选择配额：切 Tab 时不会被别的媒介占满 maxSelectable
        // 而卡住当前媒介的勾选（selectionKey 前缀即 media）。
        const media = key.split(':', 1)[0];
        const sameMediaCount = prev.filter((k) =>
          k.startsWith(`${media}:`),
        ).length;
        if (sameMediaCount >= maxSelectable) return prev;
        return [...prev, key];
      });
    },
    [maxSelectable],
  );

  const handleConfirm = useCallback(() => {
    if (selectedKeys.length === 0) {
      onClose();
      return;
    }
    if (onConfirm) {
      const byKey = new Map(library.map((entry) => [selectionKey(entry), entry]));
      const selections: AssetLibrarySelection[] = [];
      for (const key of selectedKeys) {
        const entry = byKey.get(key);
        if (entry && entry.url) {
          selections.push({ media: entry.media, url: entry.url, name: entry.name });
        }
      }
      onConfirm(selections);
    }
    onClose();
  }, [library, onClose, onConfirm, selectedKeys, selectionKey]);

  if (typeof document === 'undefined' || !open) return null;

  const totalCount = library.length + pendingUploads.length;
  const selectedCount = selectedKeys.length;
  // 当前 Tab（媒介）内已选数量，用于配额显示与「选满禁选」判断；确定按钮仍看全局。
  const activeSelectedCount = selectedKeys.filter((k) =>
    k.startsWith(`${activeMedia}:`),
  ).length;
  const hasSelection = selectedCount > 0;

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/65 backdrop-blur-sm" onClick={onClose} />
      <div
        className={ASSET_LIBRARY_MODAL_CLASS}
        onClick={(event) => event.stopPropagation()}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget === event.target) setIsDragging(false);
        }}
        onDrop={handleDrop}
      >
        {/* Title bar */}
        <div className="flex shrink-0 items-center justify-between px-5 py-4">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-text-dark">资产库</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleSyncFromMainline()}
              disabled={!project || isSyncing}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-white/[0.08] px-3 text-xs font-medium text-text-dark transition-colors hover:bg-white/[0.14] disabled:cursor-not-allowed disabled:opacity-50"
              title="打开时已自动同步；如主线新增了人物 / 场景 / 道具，可点此重新同步"
            >
              {isSyncing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              重新同步
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-text-muted/90 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
              title="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Tabs + counter */}
        <div className="flex shrink-0 items-center justify-between px-5 pb-4">
          <div className="flex items-center gap-1 rounded-lg bg-white/[0.04] p-0.5">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTabKey(tab.key)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  tab.key === activeTabKey
                    ? 'bg-white/[0.12] text-text-dark'
                    : 'text-text-muted/80 hover:text-text-dark'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3 text-xs text-text-muted/85">
            <span>
              已录入 <span className="text-text-dark">{totalCount}</span> 个
            </span>
            <span className="h-3 w-px bg-white/10" />
            <span>
              已选{' '}
              <span
                className={
                  activeSelectedCount > 0 ? 'text-primary' : 'text-text-dark'
                }
              >
                {activeSelectedCount}
              </span>
              /{maxSelectable}
            </span>
            {isLoadingLibrary && (
              <Loader2 className="ml-1 inline h-3.5 w-3.5 animate-spin text-text-muted" />
            )}
          </div>
        </div>

        {/* Grid */}
        <div className="ui-scrollbar relative flex-1 overflow-y-auto px-5 pb-2">
          {isDragging && activeTab?.allowUpload && (
            <div className="pointer-events-none absolute inset-x-5 inset-y-0 z-10 flex items-center justify-center rounded-[8px] border border-dashed border-accent/60 bg-accent/10 text-sm text-text-dark">
              松开以上传{activeTab?.label ?? '文件'}
            </div>
          )}
          {libraryError && (
            <div className="mb-3 rounded-md bg-red-500/10 px-3 py-2 text-[12px] text-red-400">
              加载失败：{libraryError}
            </div>
          )}
          <div
            className="grid gap-3.5"
            style={{
              gridTemplateColumns: 'repeat(auto-fill, minmax(176px, 176px))',
            }}
          >
            {/* Upload card — 场景等只读类目不显示 */}
            {activeTab?.allowUpload && (
              <>
                <div className={ASSET_LIBRARY_UPLOAD_CARD_CLASS}>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={!project}
                    className="inline-flex h-8 items-center justify-center rounded-md bg-white/[0.10] px-4 text-xs font-medium text-text-dark transition-colors hover:bg-white/[0.16] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Upload className="mr-1.5 h-3.5 w-3.5" />
                    本地上传
                  </button>
                  <div className="text-[11px] text-text-muted/75">
                    {activeMedia === 'image'
                      ? '支持 PNG / JPG / WebP，可拖入'
                      : activeMedia === 'video'
                        ? '支持 MP4 / MOV 等，可拖入'
                        : '支持 MP3 / WAV / M4A，可拖入'}
                  </div>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={activeTab?.accept ?? 'image/*'}
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    if (event.target.files) handleFiles(event.target.files);
                    event.target.value = '';
                  }}
                />
              </>
            )}

            {/* In-flight uploads */}
            {visiblePending.map((p) => (
              <div
                key={p.id}
                className={`group relative aspect-square ${ASSET_LIBRARY_CARD_CLASS}`}
              >
                {p.media === 'image' ? (
                  <img
                    src={p.previewUrl}
                    alt=""
                    className="h-full w-full object-cover opacity-70"
                    draggable={false}
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-white/[0.03] text-text-muted/50">
                    {p.media === 'video' ? (
                      <VideoIcon className="h-8 w-8" />
                    ) : (
                      <Music className="h-8 w-8" />
                    )}
                  </div>
                )}
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/45">
                  {p.status === 'uploading' ? (
                    <>
                      <Loader2 className="h-5 w-5 animate-spin text-white" />
                      <div className="text-[11px] text-white/90">上传中…</div>
                    </>
                  ) : (
                    <>
                      <div className="text-[11px] text-red-300">上传失败</div>
                      {p.error && (
                        <div className="px-2 text-[10px] text-red-200/80 line-clamp-2 text-center">
                          {p.error}
                        </div>
                      )}
                    </>
                  )}
                </div>
                {p.status === 'failed' && (
                  <button
                    type="button"
                    onClick={() => removePending(p.id)}
                    className="absolute right-2 bottom-2 inline-flex h-7 w-7 items-center justify-center rounded-md bg-black/55 text-white transition-colors hover:bg-black/75"
                    title="移除"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}

            {/* Existing items */}
            {visibleItems.map((entry, idx) => {
              const isDeleting = deletingId != null && entry.id === deletingId;
              const key = selectionKey(entry);
              const selected = isSelected(key);
              const disabledSelect =
                !selected && activeSelectedCount >= maxSelectable;
              return (
                <div
                  key={entry.id ?? `idx-${idx}`}
                  className={`group relative aspect-square ${ASSET_LIBRARY_CARD_CLASS} ${
                    selected
                      ? 'border-accent/70 ring-1 ring-accent/45'
                      : ASSET_LIBRARY_CARD_HOVER_CLASS
                  } cursor-pointer`}
                  onClick={() => {
                    if (disabledSelect) return;
                    toggleSelect(key);
                  }}
                >
                  {entry.media === 'image' ? (
                    <img
                      src={resolveImageDisplayUrl(entry.url)}
                      alt={entry.name}
                      className="h-full w-full object-cover"
                      draggable={false}
                    />
                  ) : entry.media === 'video' ? (
                    <video
                      src={resolveImageDisplayUrl(entry.url)}
                      className="h-full w-full object-cover"
                      muted
                      playsInline
                      preload="metadata"
                    />
                  ) : (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-white/[0.03] text-text-muted/70">
                      <Music className="h-9 w-9" />
                      <audio
                        src={resolveImageDisplayUrl(entry.url)}
                        controls
                        className="w-[86%]"
                        onClick={(event) => event.stopPropagation()}
                      />
                    </div>
                  )}

                  {/* Checkbox top-left */}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      if (disabledSelect) return;
                      toggleSelect(key);
                    }}
                    disabled={disabledSelect}
                    title={
                      disabledSelect
                        ? `最多可选 ${maxSelectable} 个`
                        : selected
                          ? '取消选择'
                          : '选择'
                    }
                    className={`absolute left-2 top-2 inline-flex h-5 w-5 items-center justify-center rounded-full border transition-colors ${
                      selected
                        ? 'border-accent bg-accent text-white'
                        : 'border-white/70 bg-black/35 text-transparent hover:border-white'
                    } ${disabledSelect ? 'cursor-not-allowed opacity-40' : ''}`}
                  >
                    <Check className="h-3 w-3" strokeWidth={3} />
                  </button>

                  {/* Source badge top-right */}
                  {entry.source !== 'upload' && (
                    <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white/90">
                      {SOURCE_LABEL[entry.source]}
                    </span>
                  )}

                  <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 py-2 text-xs text-white">
                    <div className="truncate">{entry.name || '(未命名)'}</div>
                  </div>
                  {/* 只有本地上传的条目可删；主线同步来的条目删了也会在下次打开自动同步时
                      重新出现，所以不提供删除入口，避免「删不掉」的误导。 */}
                  {entry.source === 'upload' && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleDeleteEntry(entry);
                      }}
                      disabled={!entry.id || isDeleting}
                      className="absolute right-2 bottom-2 inline-flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-white opacity-0 transition-[opacity,background-color] hover:bg-black/80 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
                      title={entry.id ? '删除' : '该条目缺少 id，无法删除'}
                    >
                      {isDeleting ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {!isLoadingLibrary &&
            visibleItems.length === 0 &&
            visiblePending.length === 0 &&
            !libraryError && (
              <div className="mt-3 text-center text-[11px] text-text-muted/70">
                {activeTab?.allowUpload
                  ? '该类目暂无素材，可点击「本地上传」添加；主线资产已自动同步，也可点右上角「重新同步」。'
                  : '主线暂无场景，或已自动同步为空；可点右上角「重新同步」重试。'}
              </div>
            )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-end gap-3 px-5 pb-3 pt-2">
          <Button
            size="sm"
            className="bg-white px-4 text-[#15161b] hover:bg-white/90"
            disabled={!hasSelection}
            onClick={handleConfirm}
          >
            确定
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
