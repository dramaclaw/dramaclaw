// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Folder,
  FolderPlus,
  Loader2,
  Maximize2,
  MoreHorizontal,
  Music,
  RefreshCw,
  Search,
  Send,
  Upload,
  Video as VideoIcon,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  createFreezoneAssetLibraryFolder,
  deleteFreezoneAssetLibraryFolder,
  deleteFreezoneVideoCharacterLibraryItem,
  fetchFreezoneAssetLibraryFolders,
  fetchFreezoneVideoCharacterLibrary,
  submitFreezoneAddVideoCharacterLibraryItem,
  syncFreezoneAssetLibraryFromMainline,
  updateFreezoneAssetLibraryFolder,
  uploadFreezoneImage,
  uploadFreezoneVideo,
  type FreezoneAssetLibraryFolder,
} from '@/api/ops';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { downloadUrlAsFile } from '@/lib/browserDownload';
import { AssetLibraryItemMedia } from './AssetLibraryItemMedia';
import { AssetLibraryPreviewDialog } from './AssetLibraryPreviewDialog';
import { Button } from '@/components/ui/button';
import { confirmDialog } from '@/components/confirm-dialog-host';
import { AssetLibraryFolderCoverDialog } from './AssetLibraryFolderCoverDialog';
import { AssetLibraryNewFolderDialog } from './AssetLibraryNewFolderDialog';
import {
  AssetLibraryUploadDialog,
  type AssetLibraryUploadPick,
} from './AssetLibraryUploadDialog';
// 条目模型与类目定义和左侧面板的「资产库」tab 共用，见 ./assetLibraryItems
import {
  ALL_CATEGORY_KEY,
  ASSET_CATEGORIES,
  ASSET_LIBRARY_CARD_CLASS,
  ASSET_LIBRARY_CARD_HOVER_CLASS,
  SOURCE_LABEL,
  buildAssetFolders,
  folderCoverUrl,
  formatFolderDate,
  libraryItemDownloadFilename,
  normalizeLibraryList,
  systemFolderLabel,
  type AssetCategory,
  type AssetFolder,
  type AssetFolderKey,
  type AssetLibraryCategoryFilterKey,
  type AssetLibraryMedia,
  type LibraryItem,
} from './assetLibraryItems';

/** 每页条数可选档位，第一个是默认值。 */
const ASSET_LIBRARY_PAGE_SIZES = [20, 40, 80, 100] as const;

const ASSET_LIBRARY_MODAL_CLASS =
  'relative flex h-[min(780px,88vh)] w-[min(1180px,94vw)] flex-col overflow-hidden rounded-xl border border-[var(--ui-border-soft)] bg-[rgba(var(--surface-rgb)/0.96)] shadow-[0_18px_48px_rgba(0,0,0,0.45)]';

export type { AssetLibraryMedia };

interface PendingUpload {
  id: string;
  fileName: string;
  previewUrl: string;
  media: AssetLibraryMedia;
  /** 标签可以不选，后端会按媒介兜底推一个。 */
  category: AssetCategory | null;
  folder: AssetFolderKey;
  status: 'uploading' | 'failed';
  error?: string;
}

export interface AssetLibrarySelection {
  media: AssetLibraryMedia;
  url: string;
  name: string;
}

export interface AssetLibraryModalProps {
  /** 管理态负责查看/维护资产；选材态只负责把素材交给节点。 */
  mode: 'manage' | 'pick';
  open: boolean;
  project: string | null;
  onClose: () => void;
  onSuccess?: () => void;
  onConfirm?: (selections: AssetLibrarySelection[]) => void;
  /** 管理态下把单条素材发送到当前画布。 */
  onSendItemToCanvas?: (entry: LibraryItem) => void;
  maxSelectable?: number;
  /** 允许的媒介类型；缺省三类都开。生图/图片编辑节点只传 ['image']。 */
  allowedMedia?: AssetLibraryMedia[];
  /**
   * 把整个文件夹的素材发到画布并编成一组（组名 = 文件夹名）。不传时文件夹卡片上
   * 不出现「发送到画布」——节点里打开的选素材弹窗没有「发到画布」这个语义。
   */
  onSendFolderToCanvas?: (folder: AssetFolder) => void;
}

function makeId(): string {
  return `al_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export function AssetLibraryModal({
  mode,
  open,
  project,
  onClose,
  onSuccess,
  onConfirm,
  onSendItemToCanvas,
  maxSelectable = 9,
  allowedMedia,
  onSendFolderToCanvas,
}: AssetLibraryModalProps) {
  // 类目（标签）按用途分，不按媒介分；allowedMedia 只在两个地方起作用：整类都装
  // 不下的类目（如只收音频的「音效」在只要图片的节点里）不出现在筛选条上，条目
  // 本身再过滤一遍。
  const categories = useMemo(
    () =>
      ASSET_CATEGORIES.filter(
        (category) =>
          !allowedMedia || category.media.some((m) => allowedMedia.includes(m)),
      ),
    [allowedMedia],
  );
  // 把 onSuccess 收进 ref，避免它进 initializeLibrary 依赖后，父组件每次渲染换新
  // 函数身份就触发「打开自动同步」effect 反复重跑。
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [customFolders, setCustomFolders] = useState<FreezoneAssetLibraryFolder[]>([]);
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const pendingRef = useRef<PendingUpload[]>([]);
  pendingRef.current = pendingUploads;
  const [isDragging, setIsDragging] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [previewEntry, setPreviewEntry] = useState<LibraryItem | null>(null);
  // 文件夹是资产的存放范围，类目是当前范围内的筛选条件：两个维度分别存状态，
  // 避免把「全部资产」和「人物 / 场景」伪装成同级 Tab。
  const [activeCategoryKey, setActiveCategoryKey] =
    useState<AssetLibraryCategoryFilterKey>(ALL_CATEGORY_KEY);
  // null 表示真正的全部资产；有值表示只浏览该文件夹。
  const [activeFolderKey, setActiveFolderKey] =
    useState<AssetFolderKey | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  // 批量删除只属于管理态；选材态的选择只服务于节点确认，两种任务不复用状态。
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkIds, setBulkIds] = useState<string[]>([]);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  // 文件夹卡片上的「…」菜单与它派生的两个弹窗。都按 key 存而不是存整个 folder
  // 对象——folders 每次刷新都是新对象，存 key 才能跟着最新数据走。
  const [folderMenuKey, setFolderMenuKey] = useState<AssetFolderKey | null>(null);
  const [renameFolderKey, setRenameFolderKey] = useState<AssetFolderKey | null>(
    null,
  );
  const [coverFolderKey, setCoverFolderKey] = useState<AssetFolderKey | null>(
    null,
  );
  // 分页只管当前资产网格。切换文件夹 / 类目或改每页条数都回到第一页——留在
  // 第 3 页看一个只有 2 页的结果集没有意义。
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(ASSET_LIBRARY_PAGE_SIZES[0]);
  const [assetQuery, setAssetQuery] = useState('');

  useEffect(() => {
    if (
      !open ||
      newFolderOpen ||
      uploadOpen ||
      renameFolderKey ||
      coverFolderKey
    ) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (previewEntry) {
        setPreviewEntry(null);
        return;
      }
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [
    coverFolderKey,
    newFolderOpen,
    onClose,
    open,
    previewEntry,
    renameFolderKey,
    uploadOpen,
  ]);

  useEffect(() => {
    setPage(1);
  }, [activeCategoryKey, activeFolderKey, assetQuery, pageSize]);

  // allowedMedia 变了(不同节点复用同一弹窗)时，把类目筛选收敛回允许集合。
  useEffect(() => {
    if (
      activeCategoryKey !== ALL_CATEGORY_KEY &&
      !categories.some((category) => category.key === activeCategoryKey)
    ) {
      setActiveCategoryKey(ALL_CATEGORY_KEY);
    }
  }, [categories, activeCategoryKey]);

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

  // 自建文件夹是后加的路由，老后端会 404；当成「还没有自建文件夹」处理，系统
  // 文件夹照常可用，不要因此整个弹窗报错。
  const refreshFolders = useCallback(async () => {
    if (!project) return;
    try {
      const folders = await fetchFreezoneAssetLibraryFolders(project);
      setCustomFolders(Array.isArray(folders) ? folders : []);
    } catch (err) {
      console.warn('[asset-library] load folders failed, treat as empty', err);
      setCustomFolders([]);
    }
  }, [project]);

  // 打开即自动同步：先加载已有库(静默兜底)，再从主线自动同步合并。只有当
  // 既无已有库、同步又失败时，才提示错误(通常代表后端还没重启/路由缺失)。
  const initializeLibrary = useCallback(
    async (isCancelled?: () => boolean) => {
      if (!project) return;
      setIsLoadingLibrary(true);
      setLibraryError(null);
      const [base] = await Promise.all([refreshLibrary(), refreshFolders()]);
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
    [project, refreshLibrary, refreshFolders],
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
      setCustomFolders([]);
      setLibraryError(null);
      setIsDragging(false);
      setIsSyncing(false);
      setSelectedKeys([]);
      setPreviewEntry(null);
      setActiveCategoryKey(ALL_CATEGORY_KEY);
      setActiveFolderKey(null);
      setNewFolderOpen(false);
      setUploadOpen(false);
      setBulkMode(false);
      setBulkIds([]);
      setAssetQuery('');
    }, 240);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (mode === 'manage') {
      setSelectedKeys([]);
      return;
    }
    setBulkMode(false);
    setBulkIds([]);
  }, [mode]);

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

  const handleCreateFolder = useCallback(
    async (name: string): Promise<AssetFolderKey> => {
      if (!project) throw new Error('项目未就绪');
      const folder = await createFreezoneAssetLibraryFolder(project, name);
      await refreshFolders();
      return folder.id;
    },
    [project, refreshFolders],
  );

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
          category: entry.category ?? undefined,
          folder: entry.folder,
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

  const startUploads = useCallback(
    (
      picks: AssetLibraryUploadPick[],
      folder: AssetFolderKey,
      category: AssetCategory | null,
    ) => {
      if (!project || picks.length === 0) return;
      const accepted = picks.map(({ file, media }) => ({
        file,
        entry: {
          id: makeId(),
          fileName: file.name,
          previewUrl: URL.createObjectURL(file),
          media,
          category,
          folder,
          status: 'uploading' as const,
        },
      }));
      setPendingUploads((prev) => [...prev, ...accepted.map((a) => a.entry)]);
      // 把范围切到目标文件夹，并保留本次指定的类目，确保上传进度立刻可见。
      setActiveCategoryKey(category ?? ALL_CATEGORY_KEY);
      setActiveFolderKey(folder);
      accepted.forEach(({ entry, file }) => {
        void uploadOne(entry, file);
      });
    },
    [project, uploadOne],
  );

  const handleDeleteEntry = useCallback(
    async (entry: LibraryItem) => {
      if (!project || !entry.id) return;
      const confirmed = await confirmDialog({
        title: '删除素材',
        description: `确定要删除「${entry.name || entry.id}」？删了找不回来。`,
        confirmText: '删除',
        confirmVariant: 'destructive',
      });
      if (!confirmed) return;
      try {
        await deleteFreezoneVideoCharacterLibraryItem(project, entry.id);
        await refreshLibrary();
      } catch (err) {
        console.error('[asset-library] delete failed', err);
        setLibraryError(err instanceof Error ? err.message : String(err));
      }
    },
    [project, refreshLibrary],
  );

  const handleDownloadEntry = useCallback(async (entry: LibraryItem) => {
    try {
      await downloadUrlAsFile(
        resolveImageDisplayUrl(entry.url),
        libraryItemDownloadFilename(entry),
      );
    } catch (err) {
      toast.error(`下载失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const handleBulkDelete = useCallback(async () => {
    if (!project || bulkIds.length === 0 || isBulkDeleting) return;
    const confirmed = await confirmDialog({
      title: '批量删除',
      description: `确定要删除选中的 ${bulkIds.length} 项素材？删了找不回来。`,
      confirmText: '删除',
      confirmVariant: 'destructive',
    });
    if (!confirmed) return;
    setIsBulkDeleting(true);
    // 一条失败不能把剩下的也拦住——最常见的是这个 id 已经被别处删掉了，为它把
    // 另外几十项的删除全放弃说不过去。逐条来，记下失败的，成功的照删。
    const failed: string[] = [];
    let lastError: unknown = null;
    try {
      for (const id of bulkIds) {
        try {
          await deleteFreezoneVideoCharacterLibraryItem(project, id);
        } catch (err) {
          console.error('[asset-library] bulk delete failed', id, err);
          failed.push(id);
          lastError = err;
        }
      }
      // 已删掉的那些要从视图里消失，所以失败了照样刷一次。
      const remaining = await refreshLibrary();
      // 失败的留在选中态里方便重试，但只留后端确认还在的——已经不存在的 id 留着
      // 只会让下一次「删除所选」重复撞同一个 404，永远删不完。
      const alive = new Set(remaining.map((entry) => entry.id));
      setBulkIds(failed.filter((id) => alive.has(id)));
      if (lastError) {
        const message =
          lastError instanceof Error ? lastError.message : String(lastError);
        setLibraryError(`${failed.length} 项删除失败：${message}`);
      }
    } finally {
      setIsBulkDeleting(false);
    }
  }, [project, bulkIds, isBulkDeleting, refreshLibrary]);

  // 调用方（生图/图片编辑节点只要图片）不要的媒介，在任何视图里都不出现。
  const allowedItems = useMemo(
    () =>
      allowedMedia
        ? library.filter((entry) => allowedMedia.includes(entry.media))
        : library,
    [library, allowedMedia],
  );

  // 左侧文件夹导航与常驻面板「资产库」tab 共用同一套分法（见 buildAssetFolders）。
  const folders = useMemo(
    () => buildAssetFolders(allowedItems, customFolders),
    [allowedItems, customFolders],
  );
  const uploadableFolders = useMemo(
    () => folders.filter((folder) => folder.uploadable),
    [folders],
  );

  const activeFolder = useMemo(() => {
    if (!activeFolderKey) return null;
    const found = folders.find((folder) => folder.key === activeFolderKey);
    if (found) return found;
    // 空的系统类目文件夹是「有内容才出现」的（见 buildAssetFolders），所以往一个
    // 还没有素材的类目里传第一个文件时，它并不在 folders 里。这时若照常回落到
    // 文件夹网格，上传中的卡片就没地方落——进度看不见，失败了连「移除」也点不到。
    // 给个同 key 的空壳兜住。只在确实有上传要落进来时才造，免得把刚删掉的文件夹
    // 又变出来。
    if (!pendingUploads.some((p) => p.folder === activeFolderKey)) return null;
    const placeholder: AssetFolder = {
      key: activeFolderKey,
      label: systemFolderLabel(activeFolderKey) ?? activeFolderKey,
      items: [],
      system: true,
      uploadable: true,
    };
    return placeholder;
  }, [folders, activeFolderKey, pendingUploads]);
  const renameFolder = useMemo(
    () => folders.find((folder) => folder.key === renameFolderKey) ?? null,
    [folders, renameFolderKey],
  );
  const coverFolder = useMemo(
    () => folders.find((folder) => folder.key === coverFolderKey) ?? null,
    [folders, coverFolderKey],
  );

  const handleDeleteFolder = useCallback(
    async (folder: AssetFolder) => {
      if (!project || folder.system) return;
      // 后端删的是这个 folder 下的所有素材，不看当前弹窗只准显示哪种媒介，所以
      // 数数要用没过滤的 library。用 folder.items 会少报——只收图片的节点里，一个
      // 装满视频的文件夹会显示成 0 项，等于一句数据丢失的警告都不给。
      const doomed = library.filter(
        (entry) => entry.folder === folder.key,
      ).length;
      const confirmed = await confirmDialog({
        title: '删除文件夹',
        description:
          doomed > 0
            ? `确定要删除文件夹「${folder.label}」？里面的 ${doomed} 项素材会一起删掉，删了找不回来。`
            : `确定要删除文件夹「${folder.label}」？`,
        confirmText: '删除',
        confirmVariant: 'destructive',
      });
      if (!confirmed) return;
      try {
        await deleteFreezoneAssetLibraryFolder(project, folder.key);
      } catch (err) {
        console.error('[asset-library] delete folder failed', err);
        setLibraryError(err instanceof Error ? err.message : String(err));
      }
      // 删的是「文件夹 + 里面的素材」，两份数据都得重拉；失败也刷，避免视图停在
      // 一个可能已经被删掉的文件夹上。
      if (activeFolderKey === folder.key) setActiveFolderKey(null);
      await Promise.all([refreshLibrary(), refreshFolders()]);
    },
    [project, library, activeFolderKey, refreshLibrary, refreshFolders],
  );
  // 直接拖文件时，文件夹决定保存位置，类目筛选决定标签。全部资产 + 全部类别时
  // 默认落到「待分类资产」，避免一个没有存放位置的上传入口。
  const dropTarget = useMemo<
    { folder: AssetFolderKey; category: AssetCategory | null; label: string } | null
  >(() => {
    const category =
      activeCategoryKey === ALL_CATEGORY_KEY
        ? null
        : categories.find((entry) => entry.key === activeCategoryKey) ?? null;
    if (activeFolder?.uploadable) {
      return {
        folder: activeFolder.key,
        category: category?.key ?? null,
        label: activeFolder.label,
      };
    }
    if (activeFolder) return null;
    if (category) {
      return { folder: category.key, category: category.key, label: category.label };
    }
    return { folder: 'other', category: 'other', label: '待分类资产' };
  }, [activeCategoryKey, activeFolder, categories]);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);
      const files = event.dataTransfer?.files;
      if (!files?.length || !dropTarget) return;
      const picks: AssetLibraryUploadPick[] = [];
      Array.from(files).forEach((file) => {
        const media = file.type.startsWith('image/')
          ? ('image' as const)
          : file.type.startsWith('video/')
            ? ('video' as const)
            : file.type.startsWith('audio/')
              ? ('audio' as const)
              : null;
        if (!media) return;
        if (allowedMedia && !allowedMedia.includes(media)) return;
        picks.push({ file, media });
      });
      startUploads(picks, dropTarget.folder, dropTarget.category);
    },
    [dropTarget, allowedMedia, startUploads],
  );

  const visibleItems = useMemo(() => {
    const scopedItems = activeFolder ? activeFolder.items : allowedItems;
    const categorizedItems =
      activeCategoryKey === ALL_CATEGORY_KEY
        ? scopedItems
        : scopedItems.filter((entry) => entry.category === activeCategoryKey);
    const normalizedQuery = assetQuery.trim().toLowerCase();
    if (!normalizedQuery) return categorizedItems;
    return categorizedItems.filter((entry) =>
      (entry.name || '').toLowerCase().includes(normalizedQuery),
    );
  }, [activeCategoryKey, activeFolder, allowedItems, assetQuery]);

  const visiblePending = useMemo(() => {
    const scopedPending = activeFolder
      ? pendingUploads.filter((entry) => entry.folder === activeFolder.key)
      : pendingUploads;
    const categorizedPending =
      activeCategoryKey === ALL_CATEGORY_KEY
        ? scopedPending
        : scopedPending.filter((entry) => entry.category === activeCategoryKey);
    const normalizedQuery = assetQuery.trim().toLowerCase();
    if (!normalizedQuery) return categorizedPending;
    return categorizedPending.filter((entry) =>
      entry.fileName.toLowerCase().includes(normalizedQuery),
    );
  }, [activeCategoryKey, activeFolder, assetQuery, pendingUploads]);

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
        // 每种媒介各自独立的选择配额：切筛选时不会被别的媒介占满 maxSelectable
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

  const toggleBulk = useCallback((id: string) => {
    setBulkIds((prev) =>
      prev.includes(id) ? prev.filter((k) => k !== id) : [...prev, id],
    );
  }, []);

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

  // 分页只作用在当前范围和类目过滤后的资产。上传中的占位卡不参与分页——它们
  // 几秒后就变成正式条目，被翻到后面反而看不到进度。
  const pagedTotal = visibleItems.length;
  const pageCount = Math.max(1, Math.ceil(pagedTotal / pageSize));
  // 删素材会让总页数缩水，停在已经不存在的页上就成空白了，这里兜一下。
  const safePage = Math.min(page, pageCount);
  const pageStart = (safePage - 1) * pageSize;
  const pagedItems = visibleItems.slice(pageStart, pageStart + pageSize);
  const selectedCount = selectedKeys.length;
  // 配额按媒介算（selectionKey 前缀即 media），所以「选满禁选」也得按条目自己的
  // 媒介判断——文件夹里图片和视频是混着的。
  const selectedCountOf = (media: AssetLibraryMedia) =>
    selectedKeys.filter((k) => k.startsWith(`${media}:`)).length;
  const hasSelection = selectedCount > 0;
  const categoryFilters: Array<{
    key: AssetLibraryCategoryFilterKey;
    label: string;
  }> = [
    { key: ALL_CATEGORY_KEY, label: '全部类别' },
    ...categories.map((category) => ({
      key: category.key,
      label: category.label,
    })),
  ];
  const activeScopeLabel = activeFolder?.label ?? '全部资产';

  const headerButtonLayout =
    'inline-flex h-7 items-center gap-1.5 rounded-[8px] px-2.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40';
  const headerButtonClass = `${headerButtonLayout} border border-[var(--ui-border-soft)] bg-[rgba(var(--bg-rgb)/0.34)] font-medium text-foreground hover:border-[var(--ui-border-strong)] hover:bg-[rgba(var(--surface-rgb)/0.88)]`;

  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={onClose} />
      <div
        className={ASSET_LIBRARY_MODAL_CLASS}
        role="dialog"
        aria-modal="true"
        aria-label="资产库"
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
        {/* 标题与高频操作同层：上传和建夹直接暴露，避免为了两个选项再开一层菜单。 */}
        <div className="flex shrink-0 flex-col items-stretch justify-between gap-3 px-5 pb-3 pt-5 sm:flex-row sm:items-center sm:gap-4">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-foreground">资产库</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              整理、复用并上传项目素材
            </p>
          </div>
          <div className="ui-scrollbar-hidden flex shrink-0 items-center gap-2 overflow-x-auto pb-0.5 sm:pb-0">
            <button
              type="button"
              onClick={() => void handleSyncFromMainline()}
              disabled={!project || isSyncing}
              className={headerButtonClass}
              title="打开时已自动同步；如主线新增了人物 / 场景 / 道具，可点此重新同步"
            >
              {isSyncing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              同步主线
            </button>
            {mode === 'manage' && (
              <button
                type="button"
                onClick={() => {
                  setBulkMode((prev) => !prev);
                  setBulkIds([]);
                }}
                className={`${headerButtonClass} ${
                  bulkMode ? 'bg-white/[0.18] text-text-dark' : ''
                }`}
                title={bulkMode ? '退出批量删除' : '选择多个本地上传资产进行删除'}
              >
                {bulkMode ? '退出批量删除' : '批量删除'}
              </button>
            )}
            <button
              type="button"
              onClick={() => setNewFolderOpen(true)}
              disabled={!project}
              className={headerButtonClass}
            >
              <FolderPlus className="h-3.5 w-3.5" />
              新建文件夹
            </button>
            <button
              type="button"
              onClick={() => setUploadOpen(true)}
              disabled={!project}
              className={`${headerButtonLayout} bg-primary font-semibold text-primary-foreground hover:bg-primary/90`}
            >
              <Upload className="h-3.5 w-3.5" />
              上传资产
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-[rgba(var(--surface-rgb)/0.88)] hover:text-foreground"
              title="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 bg-[rgba(var(--bg-rgb)/0.16)]">
          {/* 位置导航：只表达资产存放范围，不再与人物 / 场景等类目混为同级 Tab。 */}
          <aside className="ui-scrollbar flex w-52 shrink-0 flex-col overflow-y-auto bg-black/10 p-3">
            <button
              type="button"
              onClick={() => {
                setActiveFolderKey(null);
                setActiveCategoryKey(ALL_CATEGORY_KEY);
              }}
              aria-label="全部资产"
              aria-pressed={!activeFolder}
              className={`flex h-9 w-full items-center gap-2 rounded-sm px-2.5 text-left text-xs font-medium transition-colors ${
                !activeFolder
                  ? 'bg-secondary text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              }`}
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-sm bg-current/10">
                <Folder className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1 truncate">全部资产</span>
              <span className="text-xs font-normal opacity-70">
                {allowedItems.length}
              </span>
            </button>
            <div className="mb-1 mt-4 px-2.5 text-xs font-medium text-muted-foreground">
              文件夹
            </div>
            <div className="space-y-1">
              {folders.map((folder) => (
                <FolderCard
                  key={folder.key}
                  folder={folder}
                  active={activeFolder?.key === folder.key}
                  menuOpen={folderMenuKey === folder.key}
                  onToggleMenu={() =>
                    setFolderMenuKey((prev) =>
                      prev === folder.key ? null : folder.key,
                    )
                  }
                  onOpen={() => {
                    setActiveFolderKey(folder.key);
                    setActiveCategoryKey(ALL_CATEGORY_KEY);
                  }}
                  onSend={
                    onSendFolderToCanvas
                      ? () => {
                          onSendFolderToCanvas(folder);
                          onClose();
                        }
                      : undefined
                  }
                  onEditCover={() => {
                    setFolderMenuKey(null);
                    setCoverFolderKey(folder.key);
                  }}
                  onRename={() => {
                    setFolderMenuKey(null);
                    setRenameFolderKey(folder.key);
                  }}
                  onDelete={() => {
                    setFolderMenuKey(null);
                    void handleDeleteFolder(folder);
                  }}
                />
              ))}
            </div>
          </aside>

          <section className="flex min-w-0 flex-1 flex-col">
            <div className="shrink-0 px-5 pb-3 pt-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-foreground">
                    {activeScopeLabel}
                  </h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {visibleItems.length} 项资产
                  </p>
                </div>
                {isLoadingLibrary && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-text-muted" />
                )}
                <div className="relative ml-auto w-48 shrink-0">
                  <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                  <input
                    type="search"
                    value={assetQuery}
                    onChange={(event) => setAssetQuery(event.target.value)}
                    aria-label="搜索资产"
                    placeholder="搜索当前范围"
                    className="h-8 w-full rounded-sm border border-[var(--ui-border-soft)] bg-[rgba(var(--bg-rgb)/0.34)] pl-8 pr-7 text-xs text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus:border-accent focus:shadow-[0_0_0_2px_rgba(var(--accent-rgb),0.12)] [&::-webkit-search-cancel-button]:appearance-none"
                  />
                  {assetQuery && (
                    <button
                      type="button"
                      onClick={() => setAssetQuery('')}
                      aria-label="清空搜索"
                      className="absolute right-2 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>
              <div
                className="ui-scrollbar-hidden flex min-w-0 items-center gap-1 overflow-x-auto"
                aria-label="资产分类"
              >
                {categoryFilters.map((filter) => (
                  <button
                    key={filter.key}
                    type="button"
                    onClick={() => setActiveCategoryKey(filter.key)}
                    aria-label={`分类 ${filter.label}`}
                    aria-pressed={filter.key === activeCategoryKey}
                    className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                      filter.key === activeCategoryKey
                        ? 'bg-secondary text-primary'
                        : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    }`}
                  >
                    {filter.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 当前范围内的资产网格 */}
            <div className="ui-scrollbar relative flex-1 overflow-y-auto px-5 pb-2 [scrollbar-gutter:stable]">
          {isDragging && dropTarget && (
            <div className="pointer-events-none absolute inset-x-5 inset-y-0 z-10 flex items-center justify-center rounded-sm border border-dashed border-primary/60 bg-primary/10 text-sm text-foreground">
              松开以上传到「{dropTarget.label}」
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
            {pagedItems.map((entry, idx) => {
              const key = selectionKey(entry);
              const pickMode = mode === 'pick';
              // 批量删除只给本地上传资产显示复选框；主线资产仍保持可查看，不伪装成
              // 一张“坏掉、点不了”的卡片。
              const bulkEligible =
                mode === 'manage' && bulkMode && entry.source === 'upload' && !!entry.id;
              const selected = pickMode
                ? isSelected(key)
                : Boolean(bulkEligible && entry.id && bulkIds.includes(entry.id));
              const disabledPick =
                pickMode && !selected && selectedCountOf(entry.media) >= maxSelectable;
              const openDetails = () => setPreviewEntry(entry);
              const activateCard = () => {
                if (pickMode) {
                  if (!disabledPick) toggleSelect(key);
                  return;
                }
                openDetails();
              };
              return (
                <div
                  key={entry.id ?? `idx-${idx}`}
                  className={`group relative aspect-square ${ASSET_LIBRARY_CARD_CLASS} ${
                    selected
                      ? bulkMode
                        ? 'border-red-400/70 ring-1 ring-red-400/45'
                        : 'border-primary/70 ring-1 ring-primary/45'
                      : ASSET_LIBRARY_CARD_HOVER_CLASS
                  } ${disabledPick ? 'cursor-default' : 'cursor-pointer'}`}
                  onClick={activateCard}
                  title={pickMode ? undefined : '打开资产详情'}
                >
                  <AssetLibraryItemMedia entry={entry} />

                  {(pickMode || bulkEligible) && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        if (bulkEligible && entry.id) {
                          toggleBulk(entry.id);
                        } else if (pickMode && !disabledPick) {
                          toggleSelect(key);
                        }
                      }}
                      disabled={disabledPick}
                      title={
                        bulkEligible
                          ? selected
                            ? '取消选择'
                            : '选中待删除'
                          : disabledPick
                            ? `最多可选 ${maxSelectable} 个`
                            : selected
                              ? '取消选择'
                              : '选择'
                      }
                      className={`absolute left-2 top-2 z-10 inline-flex h-5 w-5 items-center justify-center rounded-full border transition-colors ${
                        selected
                          ? bulkMode
                            ? 'border-red-400 bg-red-500 text-white'
                            : 'border-primary bg-primary text-primary-foreground'
                          : 'border-white/70 bg-black/35 text-transparent hover:border-white'
                      } ${disabledPick ? 'cursor-not-allowed opacity-40' : ''}`}
                    >
                      <Check className="h-3 w-3" strokeWidth={3} />
                    </button>
                  )}

                  {mode === 'manage' && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        openDetails();
                      }}
                      className={`absolute top-2 z-10 inline-flex h-6 w-6 items-center justify-center rounded-md border border-white/15 bg-black/45 text-white/80 transition-colors hover:bg-black/65 hover:text-white ${
                        bulkEligible ? 'right-2' : 'left-2'
                      }`}
                      title="查看资产详情"
                      aria-label={`查看 ${entry.name || '资产'} 详情`}
                    >
                      <Maximize2 className="h-3.5 w-3.5" />
                    </button>
                  )}

                  {/* Source badge top-right */}
                  {entry.source !== 'upload' && (
                    <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white/90">
                      {SOURCE_LABEL[entry.source]}
                    </span>
                  )}

                  <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-3 py-2 text-xs text-white">
                    <div className="truncate">{entry.name || '(未命名)'}</div>
                  </div>
                </div>
              );
            })}
          </div>

          {!isLoadingLibrary &&
            visibleItems.length === 0 &&
            visiblePending.length === 0 &&
            !libraryError && (
              <div className="absolute inset-0 flex -translate-y-[56px] flex-col items-center justify-center gap-3 text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Upload className="h-4 w-4" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {assetQuery
                      ? '没有匹配的资产'
                      : activeCategoryKey === ALL_CATEGORY_KEY
                        ? '这里还没有素材'
                        : '当前分类下没有素材'}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {assetQuery
                      ? '尝试更换关键词，或清空搜索查看全部资产'
                      : activeCategoryKey === ALL_CATEGORY_KEY
                        ? '上传文件，或同步主线中的人物、场景和道具'
                        : '切换分类，或上传符合当前分类的资产'}
                  </p>
                </div>
                {assetQuery ? (
                  <button
                    type="button"
                    onClick={() => setAssetQuery('')}
                    className="inline-flex h-8 items-center rounded-full bg-white/[0.08] px-3 text-xs font-medium text-foreground transition-colors hover:bg-white/[0.12]"
                  >
                    清空搜索
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setUploadOpen(true)}
                    className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
                  >
                    <Upload className="h-3.5 w-3.5" />
                    上传第一个资产
                  </button>
                )}
              </div>
            )}
            </div>

            {/* Footer */}
            <div className="flex shrink-0 items-center justify-end gap-3 px-5 pb-3 pt-2">
          {bulkMode ? (
            <>
              <span className="mr-auto text-xs text-text-muted/85">
                已选 <span className="text-text-dark">{bulkIds.length}</span> 项
                （只能删除本地上传的素材）
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="px-4 text-text-muted hover:text-text-dark"
                onClick={() => {
                  setBulkMode(false);
                  setBulkIds([]);
                }}
              >
                退出批量删除
              </Button>
              <Button
                size="sm"
                className="bg-red-500 px-4 text-white hover:bg-red-500/90"
                disabled={bulkIds.length === 0 || isBulkDeleting}
                onClick={() => void handleBulkDelete()}
              >
                {isBulkDeleting && (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                )}
                删除所选
              </Button>
            </>
          ) : (
            <>
              <AssetLibraryPagination
                page={safePage}
                pageCount={pageCount}
                pageSize={pageSize}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
              />
              {/* 「确定」只在挑素材给节点用时才有意义；侧栏点开的资产管理态没有
                  接收方，那儿的底部就只剩分页。 */}
              {mode === 'pick' && onConfirm && (
                <Button
                  size="sm"
                  className="bg-white px-4 text-[#15161b] hover:bg-white/90"
                  disabled={!hasSelection}
                  onClick={handleConfirm}
                >
                  确定
                </Button>
              )}
            </>
          )}
            </div>
          </section>
        </div>
      </div>

      {previewEntry && (
        <AssetLibraryPreviewDialog
          entry={previewEntry}
          onClose={() => setPreviewEntry(null)}
          onDownload={() => void handleDownloadEntry(previewEntry)}
          onSend={
            onSendItemToCanvas
              ? () => {
                  onSendItemToCanvas(previewEntry);
                  setPreviewEntry(null);
                  onClose();
                }
              : undefined
          }
          onDelete={
            previewEntry.source === 'upload' && previewEntry.id
              ? () => {
                  const entry = previewEntry;
                  setPreviewEntry(null);
                  void handleDeleteEntry(entry);
                }
              : undefined
          }
        />
      )}

      <AssetLibraryNewFolderDialog
        open={newFolderOpen}
        onClose={() => setNewFolderOpen(false)}
        onSubmit={async (name) => {
          const key = await handleCreateFolder(name);
          setNewFolderOpen(false);
          // 建完直接把左侧范围切到新文件夹，省得用户回头再找。
          setActiveCategoryKey(ALL_CATEGORY_KEY);
          setActiveFolderKey(key);
        }}
      />

      <AssetLibraryUploadDialog
        open={uploadOpen}
        folders={uploadableFolders}
        defaultFolderKey={activeFolder?.uploadable ? activeFolder.key : null}
        categories={categories}
        allowedMedia={allowedMedia}
        onCreateFolder={handleCreateFolder}
        onSubmit={startUploads}
        onClose={() => setUploadOpen(false)}
      />

      <AssetLibraryNewFolderDialog
        open={Boolean(renameFolder)}
        title="重命名"
        initialName={renameFolder?.label ?? ''}
        onClose={() => setRenameFolderKey(null)}
        onSubmit={async (name) => {
          if (!renameFolder || !project) return;
          await updateFreezoneAssetLibraryFolder(project, renameFolder.key, {
            name,
          });
          setRenameFolderKey(null);
          await refreshFolders();
        }}
      />

      <AssetLibraryFolderCoverDialog
        open={Boolean(coverFolder)}
        folder={coverFolder}
        onClose={() => setCoverFolderKey(null)}
        onSubmit={async (cover) => {
          if (!coverFolder || !project) return;
          await updateFreezoneAssetLibraryFolder(project, coverFolder.key, {
            cover,
          });
          setCoverFolderKey(null);
          await refreshFolders();
        }}
      />
    </div>,
    document.body,
  );
}

/** 左侧文件夹导航项：位置入口、数量与文件夹操作保持在同一行。 */
function FolderCard({
  folder,
  active,
  menuOpen,
  onToggleMenu,
  onOpen,
  onSend,
  onEditCover,
  onRename,
  onDelete,
}: {
  folder: AssetFolder;
  active: boolean;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onOpen: () => void;
  /** 不传表示当前场景没有画布可发（如节点里打开的选素材弹窗）。 */
  onSend?: () => void;
  onEditCover: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const cover = folderCoverUrl(folder);
  const created = formatFolderDate(folder.createdAt);
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onOpen}
        aria-label={`文件夹 ${folder.label}`}
        aria-pressed={active}
        className={`flex min-h-10 w-full items-center gap-2 rounded-sm px-2 py-1.5 pr-14 text-left transition-colors ${
          active
            ? 'bg-secondary text-primary'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
        }`}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-black/15">
          {cover ? (
            <img
              src={resolveImageDisplayUrl(cover)}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          ) : (
            <Folder className="h-4 w-4" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className="block truncate text-xs font-medium"
            title={folder.label}
          >
            {folder.label}
          </span>
          {created && (
            <span className="mt-0.5 block text-xs font-normal opacity-60">
              {created}
            </span>
          )}
        </span>
        <span className="text-xs font-normal opacity-60">
          {folder.items.length}
        </span>
      </button>

      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center">
        {onSend && folder.items.length > 0 && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onSend();
            }}
            aria-label="发送到画布"
            title="发送到画布"
            className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-[opacity,background-color,color] hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        )}
        {!folder.system && (
          <div className="relative">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onToggleMenu();
              }}
              aria-label={`${folder.label} 更多操作`}
              className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-[opacity,background-color,color] hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={onToggleMenu} />
                <div className="absolute right-0 top-8 z-20 w-28 overflow-hidden rounded-sm border border-border bg-popover py-1 text-popover-foreground shadow-[0_12px_28px_rgba(0,0,0,0.45)]">
                  <button
                    type="button"
                    onClick={onEditCover}
                    className="block w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                  >
                    修改封面
                  </button>
                  <button
                    type="button"
                    onClick={onRename}
                    className="block w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                  >
                    重命名
                  </button>
                  <button
                    type="button"
                    onClick={onDelete}
                    className="block w-full px-3 py-1.5 text-left text-xs text-destructive transition-colors hover:bg-accent"
                  >
                    删除
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 底部分页。页码窗口最多 7 格、两端省略，够用又不会把 footer 撑开。
 *
 * 每页条数的下拉往上开：它贴着弹窗底边，往下开会被 overflow-hidden 裁掉。
 */
function AssetLibraryPagination({
  page,
  pageCount,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}) {
  const [sizeMenuOpen, setSizeMenuOpen] = useState(false);
  const stepClass =
    'inline-flex h-7 w-7 items-center justify-center rounded-[6px] text-text-muted/85 transition-colors hover:bg-white/[0.08] hover:text-text-dark disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent';

  return (
    <div className="mr-auto flex items-center gap-1.5">
      <button
        type="button"
        aria-label="上一页"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
        className={stepClass}
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      {pageWindow(page, pageCount).map((slot, idx) =>
        slot === '...' ? (
          <span
            key={`gap-${idx}`}
            className="px-1 text-xs text-text-muted/60"
            aria-hidden
          >
            …
          </span>
        ) : (
          <button
            key={slot}
            type="button"
            aria-label={`第 ${slot} 页`}
            aria-current={slot === page ? 'page' : undefined}
            onClick={() => onPageChange(slot)}
            className={`inline-flex h-7 min-w-7 items-center justify-center rounded-[6px] px-1.5 text-xs transition-colors ${
              slot === page
                ? 'bg-white/[0.12] text-text-dark'
                : 'text-text-muted/85 hover:bg-white/[0.08] hover:text-text-dark'
            }`}
          >
            {slot}
          </button>
        ),
      )}
      <button
        type="button"
        aria-label="下一页"
        disabled={page >= pageCount}
        onClick={() => onPageChange(page + 1)}
        className={stepClass}
      >
        <ChevronRight className="h-4 w-4" />
      </button>

      <div className="relative ml-1">
        <button
          type="button"
          aria-label="每页条数"
          onClick={() => setSizeMenuOpen((prev) => !prev)}
          className="inline-flex h-7 items-center gap-1.5 rounded-[6px] border border-white/[0.10] bg-white/[0.04] px-2.5 text-xs text-text-muted/85 transition-colors hover:border-white/[0.20] hover:text-text-dark"
        >
          {pageSize}条/页
          <ChevronsUpDown className="h-3 w-3 opacity-60" />
        </button>
        {sizeMenuOpen && (
          <>
            <div
              className="fixed inset-0 z-10"
              onClick={() => setSizeMenuOpen(false)}
            />
            <div className="absolute bottom-9 right-0 z-20 w-[92px] overflow-hidden rounded-[6px] border border-white/[0.12] bg-[#232429] py-1 shadow-[0_12px_28px_rgba(0,0,0,0.45)]">
              {ASSET_LIBRARY_PAGE_SIZES.map((size) => (
                <button
                  key={size}
                  type="button"
                  onClick={() => {
                    setSizeMenuOpen(false);
                    onPageSizeChange(size);
                  }}
                  className={`block w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-white/[0.08] ${
                    size === pageSize ? 'text-text-dark' : 'text-text-muted/85'
                  }`}
                >
                  {size}条/页
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 页码窗口：总页数 ≤7 全列，否则首尾常驻、当前页两侧各留一格，中间省略。 */
function pageWindow(page: number, pageCount: number): Array<number | '...'> {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  const slots: Array<number | '...'> = [1];
  const start = Math.max(2, Math.min(page - 1, pageCount - 4));
  const end = Math.min(pageCount - 1, Math.max(page + 1, 5));
  if (start > 2) slots.push('...');
  for (let p = start; p <= end; p += 1) slots.push(p);
  if (end < pageCount - 1) slots.push('...');
  slots.push(pageCount);
  return slots;
}
