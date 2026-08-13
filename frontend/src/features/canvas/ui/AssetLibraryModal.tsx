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
  Loader2,
  MoreHorizontal,
  Music,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Video as VideoIcon,
  X,
} from 'lucide-react';

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
import { AssetLibraryItemMedia } from './AssetLibraryItemMedia';
import { Button } from '@/components/ui/button';
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
  normalizeLibraryList,
  systemFolderLabel,
  type AssetCategory,
  type AssetFolder,
  type AssetFolderKey,
  type AssetLibraryMedia,
  type AssetLibraryTabKey,
  type LibraryItem,
} from './assetLibraryItems';

/** 每页条数可选档位，第一个是默认值。 */
const ASSET_LIBRARY_PAGE_SIZES = [20, 40, 80, 100] as const;

const ASSET_LIBRARY_MODAL_CLASS =
  'relative flex h-[min(880px,90vh)] w-[min(1440px,94vw)] flex-col overflow-hidden rounded-[10px] border border-white/[0.12] bg-[#15161b]/96 shadow-[0_18px_48px_rgba(0,0,0,0.45)] backdrop-blur-md';

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
  open: boolean;
  project: string | null;
  onClose: () => void;
  onSuccess?: () => void;
  onConfirm?: (selections: AssetLibrarySelection[]) => void;
  maxSelectable?: number;
  /** 允许的媒体类型 Tab;缺省三类都开。生图/图片编辑节点只传 ['image']。 */
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
  open,
  project,
  onClose,
  onSuccess,
  onConfirm,
  maxSelectable = 9,
  allowedMedia,
  onSendFolderToCanvas,
}: AssetLibraryModalProps) {
  // 类目（标签）按用途分，不按媒介分；allowedMedia 只在两个地方起作用：整类都装
  // 不下的类目（如只收音频的「音效」在只要图片的节点里）不出现在 tab 条上，条目
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
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const pendingRef = useRef<PendingUpload[]>([]);
  pendingRef.current = pendingUploads;
  const [isDragging, setIsDragging] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [activeTabKey, setActiveTabKey] =
    useState<AssetLibraryTabKey>(ALL_CATEGORY_KEY);
  // 「全部」下先看文件夹，点进去才看条目；非空即当前打开的文件夹。选中状态跨层级
  // 保留（selectedKeys 与视图无关），所以进出文件夹不会掉勾。
  const [openFolderKey, setOpenFolderKey] = useState<AssetFolderKey | null>(null);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  // 批量操作 = 管理态：卡片上的勾选改为「选中待删除」，底部换成删除条。平时的勾选
  // 是「挑素材给节点用」，两者各存各的，互不影响。
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
  // 分页只管当前网格：「全部」顶层分文件夹，其余分条目。切 Tab / 进出文件夹 /
  // 改每页条数都回到第一页——留在第 3 页看一个只有 2 页的目录没有意义。
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(ASSET_LIBRARY_PAGE_SIZES[0]);

  useEffect(() => {
    setPage(1);
  }, [activeTabKey, openFolderKey, pageSize]);

  // allowedMedia 变了(不同节点复用同一弹窗)时，把当前 Tab 收敛回允许集合。
  useEffect(() => {
    if (
      activeTabKey !== ALL_CATEGORY_KEY &&
      !categories.some((category) => category.key === activeTabKey)
    ) {
      setActiveTabKey(ALL_CATEGORY_KEY);
    }
  }, [categories, activeTabKey]);

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
      setDeletingId(null);
      setIsDragging(false);
      setIsSyncing(false);
      setSelectedKeys([]);
      setActiveTabKey(ALL_CATEGORY_KEY);
      setOpenFolderKey(null);
      setCreateMenuOpen(false);
      setNewFolderOpen(false);
      setUploadOpen(false);
      setBulkMode(false);
      setBulkIds([]);
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
      // 把视图切到目标文件夹，否则上传进度落在用户看不见的地方。
      setActiveTabKey(ALL_CATEGORY_KEY);
      setOpenFolderKey(folder);
      accepted.forEach(({ entry, file }) => {
        void uploadOne(entry, file);
      });
    },
    [project, uploadOne],
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

  const handleBulkDelete = useCallback(async () => {
    if (!project || bulkIds.length === 0 || isBulkDeleting) return;
    const confirmed = window.confirm(
      `确定要删除选中的 ${bulkIds.length} 项素材？`,
    );
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

  // 「全部」下的文件夹，与左侧面板「资产库」tab 同一套分法（见 buildAssetFolders）。
  const folders = useMemo(
    () => buildAssetFolders(allowedItems, customFolders),
    [allowedItems, customFolders],
  );
  const uploadableFolders = useMemo(
    () => folders.filter((folder) => folder.uploadable),
    [folders],
  );

  const openFolder = useMemo(() => {
    if (!openFolderKey) return null;
    const found = folders.find((folder) => folder.key === openFolderKey);
    if (found) return found;
    // 空的系统类目文件夹是「有内容才出现」的（见 buildAssetFolders），所以往一个
    // 还没有素材的类目里传第一个文件时，它并不在 folders 里。这时若照常回落到
    // 文件夹网格，上传中的卡片就没地方落——进度看不见，失败了连「移除」也点不到。
    // 给个同 key 的空壳兜住。只在确实有上传要落进来时才造，免得把刚删掉的文件夹
    // 又变出来。
    if (!pendingUploads.some((p) => p.folder === openFolderKey)) return null;
    const placeholder: AssetFolder = {
      key: openFolderKey,
      label: systemFolderLabel(openFolderKey) ?? openFolderKey,
      items: [],
      system: true,
      uploadable: true,
    };
    return placeholder;
  }, [folders, openFolderKey, pendingUploads]);
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
      const confirmed = window.confirm(
        doomed > 0
          ? `确定要删除文件夹「${folder.label}」？里面的 ${doomed} 项素材会一起删掉，删了找不回来。`
          : `确定要删除文件夹「${folder.label}」？`,
      );
      if (!confirmed) return;
      try {
        await deleteFreezoneAssetLibraryFolder(project, folder.key);
      } catch (err) {
        console.error('[asset-library] delete folder failed', err);
        setLibraryError(err instanceof Error ? err.message : String(err));
      }
      // 删的是「文件夹 + 里面的素材」，两份数据都得重拉；失败也刷，避免视图停在
      // 一个可能已经被删掉的文件夹上。
      if (openFolderKey === folder.key) setOpenFolderKey(null);
      await Promise.all([refreshLibrary(), refreshFolders()]);
    },
    [project, library, openFolderKey, refreshLibrary, refreshFolders],
  );
  // 「全部」且没点进文件夹时是文件夹视图，此时不列条目。
  const showFolders = activeTabKey === ALL_CATEGORY_KEY && !openFolder;

  // 直接往弹窗里拖文件的落点：进了可写文件夹就放那儿(不打标签)，在某个类目 tab 下
  // 就放进该类目的同名系统文件夹并打上该标签。文件夹视图和主线文件夹不接受拖入。
  const dropTarget = useMemo<
    { folder: AssetFolderKey; category: AssetCategory | null; label: string } | null
  >(() => {
    if (activeTabKey !== ALL_CATEGORY_KEY) {
      const category = categories.find((c) => c.key === activeTabKey);
      return category
        ? { folder: category.key, category: category.key, label: category.label }
        : null;
    }
    if (openFolder?.uploadable) {
      return { folder: openFolder.key, category: null, label: openFolder.label };
    }
    return null;
  }, [activeTabKey, categories, openFolder]);

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
    if (showFolders) return [];
    if (activeTabKey === ALL_CATEGORY_KEY) return openFolder?.items ?? [];
    return allowedItems.filter((entry) => entry.category === activeTabKey);
  }, [showFolders, activeTabKey, openFolder, allowedItems]);

  const visiblePending = useMemo(() => {
    if (showFolders) return [];
    if (activeTabKey === ALL_CATEGORY_KEY) {
      return openFolder
        ? pendingUploads.filter((p) => p.folder === openFolder.key)
        : [];
    }
    return pendingUploads.filter((p) => p.category === activeTabKey);
  }, [showFolders, activeTabKey, openFolder, pendingUploads]);

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

  // 分页作用在当前网格上。上传中的占位卡不参与分页——它们几秒后就变成正式条目，
  // 被翻到后面反而看不到进度。
  const pagedTotal = showFolders ? folders.length : visibleItems.length;
  const pageCount = Math.max(1, Math.ceil(pagedTotal / pageSize));
  // 删素材会让总页数缩水，停在已经不存在的页上就成空白了，这里兜一下。
  const safePage = Math.min(page, pageCount);
  const pageStart = (safePage - 1) * pageSize;
  const pagedFolders = showFolders
    ? folders.slice(pageStart, pageStart + pageSize)
    : [];
  const pagedItems = showFolders
    ? []
    : visibleItems.slice(pageStart, pageStart + pageSize);
  const selectedCount = selectedKeys.length;
  // 配额按媒介算（selectionKey 前缀即 media），所以「选满禁选」也得按条目自己的
  // 媒介判断——文件夹里图片和视频是混着的。
  const selectedCountOf = (media: AssetLibraryMedia) =>
    selectedKeys.filter((k) => k.startsWith(`${media}:`)).length;
  const hasSelection = selectedCount > 0;
  const tabs: Array<{ key: AssetLibraryTabKey; label: string }> = [
    { key: ALL_CATEGORY_KEY, label: '全部' },
    ...categories.map((category) => ({
      key: category.key,
      label: category.label,
    })),
  ];

  const headerButtonClass =
    'inline-flex h-8 items-center gap-1.5 rounded-md bg-white/[0.08] px-3 text-xs font-medium text-text-dark transition-colors hover:bg-white/[0.14] disabled:cursor-not-allowed disabled:opacity-50';

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
        {/* Title bar：批量操作 / 新建 统一收在右上角 */}
        <div className="flex shrink-0 items-center justify-between px-5 py-4">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-text-dark">资产库</h2>
          </div>
          <div className="flex items-center gap-2">
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
              重新同步
            </button>
            <button
              type="button"
              onClick={() => {
                setBulkMode((prev) => !prev);
                setBulkIds([]);
                setCreateMenuOpen(false);
              }}
              className={`${headerButtonClass} ${
                bulkMode ? 'bg-white/[0.18] text-text-dark' : ''
              }`}
              title="进入批量删除模式"
            >
              {bulkMode ? '退出批量' : '批量操作'}
            </button>
            <div className="relative">
              <button
                type="button"
                onClick={() => setCreateMenuOpen((prev) => !prev)}
                disabled={!project}
                className={headerButtonClass}
              >
                <Plus className="h-3.5 w-3.5" />
                新建
              </button>
              {createMenuOpen && (
                <>
                  {/* 点空白处收起菜单 */}
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setCreateMenuOpen(false)}
                  />
                  <div className="absolute right-0 top-9 z-20 w-28 overflow-hidden rounded-md border border-white/[0.12] bg-[#232429] py-1 shadow-[0_12px_28px_rgba(0,0,0,0.45)]">
                    <button
                      type="button"
                      onClick={() => {
                        setCreateMenuOpen(false);
                        setNewFolderOpen(true);
                      }}
                      className="block w-full px-3 py-1.5 text-left text-xs text-text-muted/85 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
                    >
                      新建文件夹
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCreateMenuOpen(false);
                        setUploadOpen(true);
                      }}
                      className="block w-full px-3 py-1.5 text-left text-xs text-text-muted/85 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
                    >
                      上传资产
                    </button>
                  </div>
                </>
              )}
            </div>
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
                onClick={() => {
                  setActiveTabKey(tab.key);
                  // 换 tab 一律退回文件夹层，免得「全部」里还留着上次点进去的目录。
                  setOpenFolderKey(null);
                }}
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
          {/* 「已录入 N 个 / 已选 x/y」两个计数去掉了：条数底部分页已经在说，选了
              几个卡片自己有勾。这里只留个加载指示。 */}
          {isLoadingLibrary && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-text-muted" />
          )}
        </div>

        {/* 面包屑：只在「全部」点进某个文件夹后出现 */}
        {activeTabKey === ALL_CATEGORY_KEY && openFolder && (
          <div className="flex shrink-0 items-center gap-1 px-5 pb-3 text-xs text-text-muted/85">
            <button
              type="button"
              onClick={() => setOpenFolderKey(null)}
              aria-label="返回全部"
              className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-1 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              全部
            </button>
            <span className="text-text-muted/50">/</span>
            <span className="px-1 text-text-dark">{openFolder.label}</span>
            <span className="text-text-muted/50">
              （{openFolder.items.length}）
            </span>
          </div>
        )}

        {/* Grid */}
        <div className="ui-scrollbar relative flex-1 overflow-y-auto px-5 pb-2">
          {isDragging && dropTarget && (
            <div className="pointer-events-none absolute inset-x-5 inset-y-0 z-10 flex items-center justify-center rounded-[8px] border border-dashed border-accent/60 bg-accent/10 text-sm text-text-dark">
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
            {/* 文件夹卡片 — 只在「全部」的顶层出现 */}
            {showFolders &&
              pagedFolders.map((folder) => (
                <FolderCard
                  key={folder.key}
                  folder={folder}
                  menuOpen={folderMenuKey === folder.key}
                  onToggleMenu={() =>
                    setFolderMenuKey((prev) =>
                      prev === folder.key ? null : folder.key,
                    )
                  }
                  onOpen={() => setOpenFolderKey(folder.key)}
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
              const isDeleting = deletingId != null && entry.id === deletingId;
              const key = selectionKey(entry);
              // 批量态下只有本地上传的条目可选——主线条目删了也会被下次同步拉回来。
              const bulkEligible = bulkMode && entry.source === 'upload' && !!entry.id;
              const selected = bulkMode
                ? Boolean(entry.id && bulkIds.includes(entry.id))
                : isSelected(key);
              const disabledSelect = bulkMode
                ? !bulkEligible
                : !selected && selectedCountOf(entry.media) >= maxSelectable;
              const activate = () => {
                if (disabledSelect) return;
                if (bulkMode) {
                  if (entry.id) toggleBulk(entry.id);
                } else {
                  toggleSelect(key);
                }
              };
              return (
                <div
                  key={entry.id ?? `idx-${idx}`}
                  className={`group relative aspect-square ${ASSET_LIBRARY_CARD_CLASS} ${
                    selected
                      ? bulkMode
                        ? 'border-red-400/70 ring-1 ring-red-400/45'
                        : 'border-accent/70 ring-1 ring-accent/45'
                      : ASSET_LIBRARY_CARD_HOVER_CLASS
                  } ${disabledSelect ? 'cursor-default' : 'cursor-pointer'}`}
                  onClick={activate}
                >
                  <AssetLibraryItemMedia entry={entry} />

                  {/* Checkbox top-left */}
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      activate();
                    }}
                    disabled={disabledSelect}
                    title={
                      bulkMode
                        ? bulkEligible
                          ? selected
                            ? '取消选择'
                            : '选中待删除'
                          : '主线同步来的素材不能删除'
                        : disabledSelect
                          ? `最多可选 ${maxSelectable} 个`
                          : selected
                            ? '取消选择'
                            : '选择'
                    }
                    className={`absolute left-2 top-2 inline-flex h-5 w-5 items-center justify-center rounded-full border transition-colors ${
                      selected
                        ? bulkMode
                          ? 'border-red-400 bg-red-500 text-white'
                          : 'border-accent bg-accent text-white'
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
                      重新出现，所以不提供删除入口，避免「删不掉」的误导。批量态下走
                      底部的「删除所选」，卡片上不再摆单删按钮。 */}
                  {!bulkMode && entry.source === 'upload' && (
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
            !showFolders &&
            visibleItems.length === 0 &&
            visiblePending.length === 0 &&
            !libraryError && (
              <div className="mt-3 text-center text-[11px] text-text-muted/70">
                这里暂无素材，可点右上角「新建 → 上传资产」添加；主线资产已自动同步，也可点「重新同步」。
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
                退出批量
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
              {onConfirm && (
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
      </div>

      <AssetLibraryNewFolderDialog
        open={newFolderOpen}
        onClose={() => setNewFolderOpen(false)}
        onSubmit={async (name) => {
          const key = await handleCreateFolder(name);
          setNewFolderOpen(false);
          // 建完直接进去，省得用户回头在一堆文件夹里找。
          setActiveTabKey(ALL_CATEGORY_KEY);
          setOpenFolderKey(key);
        }}
      />

      <AssetLibraryUploadDialog
        open={uploadOpen}
        folders={uploadableFolders}
        defaultFolderKey={openFolder?.uploadable ? openFolder.key : null}
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

/**
 * 文件夹卡片。有封面就铺封面（用户设的优先，否则拿夹内第一张图），没有就画图标。
 *
 * 卡片本体是 div 而非 button —— 里面还要放「发送到画布」和「…」两个按钮，
 * button 套 button 是非法 HTML，浏览器会把内层拆出去。role/tabIndex 补齐可达性。
 */
function FolderCard({
  folder,
  menuOpen,
  onToggleMenu,
  onOpen,
  onSend,
  onEditCover,
  onRename,
  onDelete,
}: {
  folder: AssetFolder;
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
    // 外壳平时不画边框/底色，hover 才浮出来。border 常在只是透明，免得 hover
    // 时多出 1px 把卡片顶动。
    <div className="flex flex-col overflow-hidden rounded-[12px] border border-transparent p-2 transition-colors hover:border-white/[0.14] hover:bg-white/[0.05]">
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      // 类目 tab 和文件夹同名（如「风格」），加个前缀让两者可区分。
      aria-label={`文件夹 ${folder.label}`}
      className="group relative flex aspect-square cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-[8px] bg-white/[0.03]"
    >
      {cover ? (
        <img
          src={resolveImageDisplayUrl(cover)}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          draggable={false}
        />
      ) : (
        <Folder className="h-11 w-11 text-text-muted/55 transition-colors group-hover:text-text-muted/80" />
      )}

      {/* 悬停才出现：整柜发到画布。缩到右下角一个小图标——原先是横在封面正中
          的一条文字按钮，鼠标从上往下移到卡片就正好压在上面，很容易误触。 */}
      {onSend && folder.items.length > 0 && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onSend();
          }}
          aria-label="发送到画布"
          title="发送到画布"
          className="absolute bottom-2 right-2 hidden h-7 w-7 items-center justify-center rounded-[6px] bg-black/70 text-white transition-colors hover:bg-black/90 group-hover:inline-flex"
        >
          <Send className="h-3.5 w-3.5" />
        </button>
      )}
    </div>

      {/* 名字挪到方块外面，封面就不用被文字压掉一条；条数不显示，进去就知道 */}
      <div className="mt-2 flex items-center gap-1 px-0.5">
        <div className="min-w-0 flex-1 truncate text-xs text-text-dark" title={folder.label}>
          {folder.label}
        </div>
        {/* 系统文件夹是按标签派生的，没有实体记录，改名/删除/封面都无从谈起 */}
        {!folder.system && (
          <div className="relative shrink-0">
            <button
              type="button"
              onClick={onToggleMenu}
              aria-label={`${folder.label} 更多操作`}
              className="inline-flex h-5 w-5 items-center justify-center rounded-[4px] text-text-muted/70 transition-colors hover:bg-white/[0.10] hover:text-text-dark"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
            {menuOpen && (
              <>
                {/* 点空白处收起菜单 */}
                <div className="fixed inset-0 z-10" onClick={onToggleMenu} />
                {/* 卡片在网格最下一行时菜单要往上开，否则会被列表的滚动容器裁掉 */}
                <div className="absolute bottom-6 right-0 z-20 w-[112px] overflow-hidden rounded-[6px] border border-white/[0.12] bg-[#232429] py-1 shadow-[0_12px_28px_rgba(0,0,0,0.45)]">
                  <button
                    type="button"
                    onClick={onEditCover}
                    className="block w-full px-3 py-1.5 text-left text-xs text-text-dark transition-colors hover:bg-white/[0.08]"
                  >
                    修改封面
                  </button>
                  <button
                    type="button"
                    onClick={onRename}
                    className="block w-full px-3 py-1.5 text-left text-xs text-text-dark transition-colors hover:bg-white/[0.08]"
                  >
                    重命名
                  </button>
                  <button
                    type="button"
                    onClick={onDelete}
                    className="block w-full px-3 py-1.5 text-left text-xs text-red-400 transition-colors hover:bg-white/[0.08]"
                  >
                    删除
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* 建夹日期。系统文件夹没有这个字段，留一行等高的空位让网格对齐。 */}
      <div className="mt-1 h-4 px-0.5 text-right text-[11px] text-text-muted/60">
        {created}
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
