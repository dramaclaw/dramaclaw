// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// 左侧面板「资产库」tab 的内容：项目级资产库的浏览，两级——先文件夹，点进去
// 看条目，顶上有面包屑退回。
//
// 与 AssetLibraryModal 的关系：条目归一化和文件夹分法共用
// `@/features/canvas/ui/assetLibraryItems`，所以两边看到的目录结构始终一致。
// 条目右侧的「…」给出发送到画布 / 下载 / 重命名 / 删除四件事——这些都是单条素材
// 的即时操作，一个菜单就够。上传、建文件夹、从主线同步仍然只在弹窗里做：它们要
// 选文件、挑保存位置、看进度条，300px 的侧栏放不下。
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  Download,
  Folder,
  MoreHorizontal,
  Music,
  Pencil,
  SendHorizontal,
  Trash2,
  Video as VideoIcon,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  deleteFreezoneVideoCharacterLibraryItem,
  renameFreezoneVideoCharacterLibraryItem,
} from "@/api/ops";
import { confirmDialog } from "@/components/confirm-dialog-host";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { downloadUrlAsFile } from "@/lib/browserDownload";
import { queryKeys } from "@/lib/query-keys";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import {
  useFreezoneAssetLibrary,
  useFreezoneAssetLibraryFolders,
} from "@/lib/queries/freezone";
import {
  buildAssetFolders,
  folderCoverUrl,
  libraryItemDownloadFilename,
  LIBRARY_ITEM_NAME_MAX_LEN,
  type AssetFolderKey,
  type LibraryItem,
} from "@/features/canvas/ui/assetLibraryItems";
import { AssetLibraryNewFolderDialog } from "@/features/canvas/ui/AssetLibraryNewFolderDialog";

interface AssetLibraryBrowserProps {
  project: string;
  /** 不传表示当前场景没有画布可发，菜单里就不出现「发送到画布」。 */
  onSendToCanvas?: (entry: LibraryItem) => void;
}

// 和大纲面板的行内菜单同款——同一个侧栏里的两个「…」不该长得不一样。
const MENU_CONTENT_CLASS =
  "z-[120] min-w-[132px] border-[var(--ui-border-soft)] bg-[rgba(var(--surface-rgb)/0.95)] text-text-dark shadow-none backdrop-blur-3xl";
const MENU_ITEM_CLASS =
  "gap-2 rounded-[var(--ui-radius-lg)] text-xs text-text-dark focus:bg-[rgb(var(--text-rgb)/0.075)] focus:text-text-dark";
/** 删除项的红色由 DropdownMenuItem 的 destructive variant 给，这里不能再压文字色。 */
const MENU_ITEM_DANGER_CLASS = "gap-2 rounded-[var(--ui-radius-lg)] text-xs";

export function AssetLibraryBrowser({
  project,
  onSendToCanvas,
}: AssetLibraryBrowserProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [openKey, setOpenKey] = useState<AssetFolderKey | null>(null);
  const [renameEntry, setRenameEntry] = useState<LibraryItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const libraryQuery = useFreezoneAssetLibrary(project);
  const foldersQuery = useFreezoneAssetLibraryFolders(project);
  const items = useMemo(() => libraryQuery.data ?? [], [libraryQuery.data]);
  const folders = useMemo(
    () => buildAssetFolders(items, foldersQuery.data ?? []),
    [items, foldersQuery.data],
  );
  const openFolder = openKey
    ? (folders.find((folder) => folder.key === openKey) ?? null)
    : null;

  const refreshLibrary = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.freezoneAssetLibrary(project),
    });
  }, [queryClient, project]);

  const handleDownload = useCallback(async (entry: LibraryItem) => {
    try {
      await downloadUrlAsFile(
        resolveImageDisplayUrl(entry.url),
        libraryItemDownloadFilename(entry),
      );
    } catch (err) {
      toast.error(
        t("canvas.assetLibrary.downloadFailed", {
          detail: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }, [t]);

  const handleDelete = useCallback(
    async (entry: LibraryItem) => {
      if (!entry.id) return;
      const confirmed = await confirmDialog({
        title: t("canvas.assetLibrary.deleteEntryTitle"),
        description: t("canvas.assetLibrary.deleteEntryDescription", { name: entry.name || entry.id }),
        confirmText: t("canvas.assetLibrary.delete"),
        confirmVariant: "destructive",
      });
      if (!confirmed) return;
      setBusyId(entry.id);
      try {
        await deleteFreezoneVideoCharacterLibraryItem(project, entry.id);
        refreshLibrary();
        toast.success(t("freezone.assetBrowser.deleted", { name: entry.name || t("freezone.assetBrowser.itemFallbackName") }));
      } catch (err) {
        toast.error(
          t("freezone.assetBrowser.deleteFailed", {
            detail: err instanceof Error ? err.message : String(err),
          }),
        );
      } finally {
        setBusyId(null);
      }
    },
    [project, refreshLibrary, t],
  );

  const handleRename = useCallback(
    async (name: string) => {
      if (!renameEntry?.id) return;
      await renameFreezoneVideoCharacterLibraryItem(project, renameEntry.id, name);
      setRenameEntry(null);
      refreshLibrary();
    },
    [project, renameEntry, refreshLibrary, t],
  );

  if (libraryQuery.isError) {
    return (
      <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-400">
          {t("freezone.assetBrowser.loadFailed", {
            detail:
              libraryQuery.error instanceof Error
                ? libraryQuery.error.message
                : String(libraryQuery.error),
          })}
        </div>
      </div>
    );
  }

  if (libraryQuery.isPending) {
    return (
      <div className="min-h-0 flex-1 px-3 py-6 text-center text-xs text-white/25">
        {t("freezone.assetBrowser.loading")}
      </div>
    );
  }

  // 库为空、也没建过文件夹时不摆两个空目录，直接说清入口在弹窗里，省得用户在侧栏里找上传。
  if (items.length === 0 && (foldersQuery.data?.length ?? 0) === 0) {
    return (
      <div className="min-h-0 flex-1 px-4 py-6 text-center text-[11px] leading-relaxed text-white/25">
        {t("freezone.assetBrowser.empty")}
      </div>
    );
  }

  return (
    <>
      {/* ── 面包屑（进了文件夹才有） ── */}
      {openFolder ? (
        <div className="flex shrink-0 items-center gap-1 px-3 pt-2.5 pb-1.5 text-xs text-white/40">
          <button
            type="button"
            onClick={() => setOpenKey(null)}
            aria-label={t("freezone.assetBrowser.backToRoot")}
            className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 transition-colors hover:bg-white/[0.06] hover:text-white/70"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            {t("canvas.assetLibrary.title")}
          </button>
          <span className="text-white/20">/</span>
          <span className="truncate px-0.5 text-white/80">
            {openFolder.label}
          </span>
        </div>
      ) : null}

      <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-1.5">
        {/* ── 根目录：文件夹列表 ── */}
        {!openFolder
          ? folders.map((folder) => {
              // 封面口径和弹窗一致（folderCoverUrl：自定义封面优先，否则取第一张图），
              // 两处别各算各的——同一个文件夹在两个视图里长得不一样最费解。
              const cover = folderCoverUrl(folder);
              return (
                <button
                  key={folder.key}
                  type="button"
                  onClick={() => setOpenKey(folder.key)}
                  aria-label={t("canvas.assetLibrary.folderAria", { label: folder.label })}
                  className="flex w-full items-center gap-2.5 rounded-[8px] px-1.5 py-1.5 text-left transition-colors hover:bg-primary/[0.10] focus-visible:bg-primary/[0.10] focus-visible:outline-none"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[8px] bg-white/[0.06] ring-1 ring-inset ring-white/[0.06]">
                    {cover ? (
                      <img
                        src={resolveImageDisplayUrl(cover)}
                        alt=""
                        className="h-full w-full object-cover"
                        draggable={false}
                        loading="lazy"
                      />
                    ) : (
                      <Folder className="h-4.5 w-4.5 text-white/40" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-white/85">
                    {folder.label}
                  </span>
                  <span className="shrink-0 pr-1 text-[11px] text-white/25">
                    {folder.items.length}
                  </span>
                </button>
              );
            })
          : null}

        {/* ── 文件夹内：条目列表 ── */}
        {openFolder && openFolder.items.length === 0 ? (
          <div className="px-2 py-6 text-center text-[11px] text-white/25">
            {t("freezone.assetBrowser.folderEmpty", { name: openFolder.label })}
          </div>
        ) : null}

        {openFolder?.items.map((entry, idx) => (
          <div
            key={entry.id ?? `idx-${idx}`}
            className={`group flex w-full items-center gap-2.5 rounded-[8px] px-1.5 py-1.5 transition-colors hover:bg-primary/[0.10] ${
              busyId && entry.id === busyId ? "opacity-40" : ""
            }`}
            title={entry.name || t("canvas.assetLibrary.unnamed")}
          >
            <span className="relative h-10 w-10 shrink-0 overflow-hidden rounded-[8px] bg-white/[0.06] ring-1 ring-inset ring-white/[0.06]">
              {entry.media === "image" ? (
                <img
                  src={resolveImageDisplayUrl(entry.url)}
                  alt={entry.name}
                  className="h-full w-full object-cover"
                  draggable={false}
                  loading="lazy"
                />
              ) : entry.media === "video" ? (
                <>
                  <video
                    src={resolveImageDisplayUrl(entry.url)}
                    className="h-full w-full object-cover"
                    muted
                    playsInline
                    preload="none"
                  />
                  {/* 视频没有 poster 时是一片黑，补个角标让它和图片区分开 */}
                  <span className="pointer-events-none absolute left-0.5 top-0.5 rounded bg-black/55 p-0.5 text-white/90">
                    <VideoIcon className="h-2.5 w-2.5" />
                  </span>
                </>
              ) : (
                <span className="flex h-full w-full items-center justify-center text-white/40">
                  <Music className="h-4 w-4" />
                </span>
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-white/85">
              {entry.name || t("canvas.assetLibrary.unnamed")}
            </span>
            <AssetItemMenu
              entry={entry}
              onSendToCanvas={
                onSendToCanvas ? () => onSendToCanvas(entry) : undefined
              }
              onDownload={() => void handleDownload(entry)}
              onRename={() => setRenameEntry(entry)}
              onDelete={() => void handleDelete(entry)}
            />
          </div>
        ))}
      </div>

      <AssetLibraryNewFolderDialog
        open={Boolean(renameEntry)}
        title={t("canvas.assetLibrary.rename")}
        fieldLabel={t("freezone.assetBrowser.assetName")}
        placeholder={t("freezone.assetBrowser.assetNamePlaceholder")}
        maxLength={LIBRARY_ITEM_NAME_MAX_LEN}
        initialName={renameEntry?.name ?? ""}
        onClose={() => setRenameEntry(null)}
        onSubmit={handleRename}
      />
    </>
  );
}

/**
 * 条目的「…」菜单。
 *
 * 主线同步来的素材不给改名/删除——改了名下次「从主线同步」会按主线名字覆盖回去，
 * 删了也会在下次同步时原样长回来，摆上去只会让人以为坏了。
 */
function AssetItemMenu({
  entry,
  onSendToCanvas,
  onDownload,
  onRename,
  onDelete,
}: {
  entry: LibraryItem;
  onSendToCanvas?: () => void;
  onDownload: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const queuedRef = useRef<(() => void) | null>(null);
  const writable = entry.source === "upload" && Boolean(entry.id);

  return (
    <DropdownMenu
      open={open}
      onOpenChange={setOpen}
      // 重命名弹窗和删除确认都要抢焦点，跟菜单关闭时把焦点还给触发按钮撞在一起会闪，
      // 所以这两项排队到菜单彻底收完再执行（下载/发送到画布不开弹窗，可以立即走）。
      onOpenChangeComplete={(next) => {
        if (next) return;
        const queued = queuedRef.current;
        queuedRef.current = null;
        queued?.();
      }}
    >
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t("canvas.assetLibrary.folderMoreAria", { label: entry.name || t("freezone.assetBrowser.itemFallbackName") })}
            // 平时藏起来，hover 或键盘聚焦才出现；自己的菜单开着时常驻，
            // 否则鼠标一移到菜单上按钮就消失了。
            className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] text-white/45 transition-colors hover:bg-white/[0.10] hover:text-white focus-visible:opacity-100 ${
              open
                ? "bg-white/[0.10] text-white opacity-100"
                : "opacity-0 group-hover:opacity-100"
            }`}
          />
        }
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className={MENU_CONTENT_CLASS} align="end">
        {onSendToCanvas ? (
          <DropdownMenuItem className={MENU_ITEM_CLASS} onClick={onSendToCanvas}>
            <SendHorizontal className="h-3.5 w-3.5" />
            <span>{t("canvas.assetLibrary.sendToCanvas")}</span>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem className={MENU_ITEM_CLASS} onClick={onDownload}>
          <Download className="h-3.5 w-3.5" />
          <span>{t("freezone.assetBrowser.download")}</span>
        </DropdownMenuItem>
        {writable ? (
          <>
            <DropdownMenuItem
              className={MENU_ITEM_CLASS}
              onClick={() => {
                queuedRef.current = onRename;
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
              <span>{t("canvas.assetLibrary.rename")}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              className={MENU_ITEM_DANGER_CLASS}
              onClick={() => {
                queuedRef.current = onDelete;
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>{t("canvas.assetLibrary.delete")}</span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
