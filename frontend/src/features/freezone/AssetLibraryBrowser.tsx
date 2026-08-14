// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// 左侧面板「资产库」tab 的内容：项目级资产库的只读浏览，两级——先文件夹，点进去
// 看条目，顶上有面包屑退回。
//
// 与 AssetLibraryModal 的关系：条目归一化和文件夹分法共用
// `@/features/canvas/ui/assetLibraryItems`，所以两边看到的目录结构始终一致；
// 但这里只读——上传、删除、从主线同步仍然只在弹窗里做（侧栏 300px 放不下，
// 而且写操作有确认/进度态，不适合塞进抽屉）。条目暂时没有点击/拖拽交互。
import { useMemo, useState } from "react";
import { ChevronLeft, Folder, Music, Video as VideoIcon } from "lucide-react";

import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import {
  useFreezoneAssetLibrary,
  useFreezoneAssetLibraryFolders,
} from "@/lib/queries/freezone";
import {
  buildAssetFolders,
  type AssetFolderKey,
} from "@/features/canvas/ui/assetLibraryItems";

interface AssetLibraryBrowserProps {
  project: string;
}

export function AssetLibraryBrowser({ project }: AssetLibraryBrowserProps) {
  const [openKey, setOpenKey] = useState<AssetFolderKey | null>(null);
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

  if (libraryQuery.isError) {
    return (
      <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-400">
          资产库加载失败：
          {libraryQuery.error instanceof Error
            ? libraryQuery.error.message
            : String(libraryQuery.error)}
        </div>
      </div>
    );
  }

  if (libraryQuery.isPending) {
    return (
      <div className="min-h-0 flex-1 px-3 py-6 text-center text-xs text-white/25">
        加载中…
      </div>
    );
  }

  // 库为空、也没建过文件夹时不摆两个空目录，直接说清入口在弹窗里，省得用户在侧栏里找上传。
  if (items.length === 0 && (foldersQuery.data?.length ?? 0) === 0) {
    return (
      <div className="min-h-0 flex-1 px-4 py-6 text-center text-[11px] leading-relaxed text-white/25">
        资产库还是空的。上传素材或从主线同步，请在节点上打开「资产库」。
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
            aria-label="返回资产库根目录"
            className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 transition-colors hover:bg-white/[0.06] hover:text-white/70"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            资产库
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
          ? folders.map((folder) => (
              <button
                key={folder.key}
                type="button"
                onClick={() => setOpenKey(folder.key)}
                aria-label={`文件夹 ${folder.label}`}
                className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors hover:bg-white/[0.06]"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-white/[0.06]">
                  <Folder className="h-4.5 w-4.5 text-white/40" />
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-white/85">
                  {folder.label}
                </span>
                <span className="shrink-0 pr-1 text-[11px] text-white/25">
                  {folder.items.length}
                </span>
              </button>
            ))
          : null}

        {/* ── 文件夹内：条目列表 ── */}
        {openFolder && openFolder.items.length === 0 ? (
          <div className="px-2 py-6 text-center text-[11px] text-white/25">
            「{openFolder.label}」暂无素材。
          </div>
        ) : null}

        {openFolder?.items.map((entry, idx) => (
          <div
            key={entry.id ?? `idx-${idx}`}
            className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-white/[0.06]"
            title={entry.name || "(未命名)"}
          >
            <span className="relative h-10 w-10 shrink-0 overflow-hidden rounded-md bg-white/[0.06]">
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
                    preload="metadata"
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
              {entry.name || "(未命名)"}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
