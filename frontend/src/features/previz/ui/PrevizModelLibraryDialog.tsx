// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useId, useMemo, useState } from "react";
import { ArrowLeft, Box, Search, Upload, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  PREVIZ_LIBRARY_CATEGORIES,
  PREVIZ_LIBRARY_ENTRIES,
  PREVIZ_LIBRARY_DRAG_TYPE,
  countByCategory,
  findPrevizLibraryEntry,
  isPrevizLibraryModelUrl,
  searchLibrary,
  type PrevizLibraryCategory,
  type PrevizLibraryEntry,
} from "@/features/previz/domain/modelLibrary";
import { isPrevizPrimitiveShape } from "@/features/previz/domain/primitives";
import { readRecentLibraryIds } from "@/features/previz/domain/recentLibrary";
import type { PrevizObject } from "@/features/previz/domain/scene";
import type {
  PrevizTopDownFootprint,
  PrevizTopDownView,
} from "@/features/previz/domain/topDownMap";
import { PrevizTopDownPicker } from "@/features/previz/ui/PrevizTopDownPicker";
import { cn } from "@/lib/utils";

export interface PrevizModelLibraryDialogProps {
  open: boolean;
  /**
   * 场里已有的对象与道具占地，原样转给「选落点」那一步的俯视选位图。**引用要稳**，
   * 理由同 `PrevizCharacterCreateDialog` 的同名 props：它们是选位图取景的依赖。
   */
  objects: readonly PrevizObject[];
  footprints?: readonly PrevizTopDownFootprint[];
  onRenderTopDown?: (canvas: HTMLCanvasElement) => PrevizTopDownView | null;
  /** 挑好模型并点定了落点（世界 XZ）。关不关对话框由父级决定（它还要先查上限、建物件）。 */
  onPlace: (entry: PrevizLibraryEntry, spot: [number, number]) => void;
  /** 本地模型文件选好了落点。上传、压缩、toast 仍走编辑器原来那条导入流程。 */
  onImportFile: (file: File, spot: [number, number]) => void;
  onClose: () => void;
}

/** 挑中了、正等着选落点的那一个：库里的一张卡片，或本地选的一个文件。 */
type PendingModel = { kind: "entry"; entry: PrevizLibraryEntry } | { kind: "file"; file: File };

type CategoryFilter = PrevizLibraryCategory | "all" | "recent";

const CATEGORIES = Object.keys(PREVIZ_LIBRARY_CATEGORIES) as PrevizLibraryCategory[];
/** 清单是写死的，计数只算一次。 */
const COUNTS = countByCategory(PREVIZ_LIBRARY_ENTRIES);

/** 与机位 / 人物创建对话框同一套：箭头、关闭这类图标按钮不描边，悬停浮起一层底色。 */
const STEP_BUTTON =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-white/45 transition-colors hover:bg-white/10 hover:text-white/90";
// 圆角一律写死像素：全局主题把 rounded-md / lg 放大到 14–16px，压在 32px 高的控件上就成了扁胶囊。
const RAIL_ITEM =
  "flex h-9 shrink-0 whitespace-nowrap items-center justify-between gap-2 rounded-[10px] px-3 text-left text-[13px] text-white/55 transition-colors hover:bg-white/[0.05] hover:text-white/90 aria-pressed:bg-white/10 aria-pressed:text-white";
/** 卡片本身不画框，框给缩略图那一格：一屏几十张卡，每张再套一圈边就是满屏格子线。 */
const CARD =
  "group flex w-full flex-col gap-2 rounded-[14px] p-1.5 text-left text-white/75 transition-colors hover:bg-white/[0.05] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25";
const THUMB_WELL =
  "flex aspect-square w-full items-center justify-center rounded-[10px] border border-white/[0.06] bg-white/[0.03] transition-colors group-hover:border-white/15 group-hover:bg-white/[0.06]";
/** 次按钮：导入、返回。 */
const SECONDARY_BUTTON =
  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] border border-white/10 px-3 text-[12px] text-white/75 transition-colors hover:bg-white/10 hover:text-white";

/**
 * 模型库：左栏分类带计数，右侧搜索加卡片网格，本地导入退到底部的次按钮。
 *
 * 挑中模型（或选好本地文件）后不直接建，而是换到「选落点」一步：同人物创建，在俯视图上
 * 点一下决定放哪。直接建的话每个模型都落在世界原点，连放两个就叠在一起。返回键回到
 * 网格时搜索词与分类都还在——面板没卸载，只是换了一屏。
 *
 * 铺在视口上而不是再套一层 base-ui Dialog，理由同机位创建对话框：编辑器本身已经是个
 * 全屏 Dialog，嵌套会把焦点陷阱和 Esc 各劫持一遍。
 */
export function PrevizModelLibraryDialog({ open, ...props }: PrevizModelLibraryDialogProps) {
  // 关掉就整个卸载：搜索词和分类不跨次保留，每次打开都从「全部」开始。
  if (!open) return null;
  return <LibraryPanel {...props} />;
}

function LibraryPanel({
  objects,
  footprints,
  onRenderTopDown,
  onPlace,
  onImportFile,
  onClose,
}: Omit<PrevizModelLibraryDialogProps, "open">) {
  const { t } = useTranslation();
  const fileInputId = useId();
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<PendingModel | null>(null);
  // 打开时读一次就够：面板开着的时候不会有新的放置（放置即关闭）。
  const [recent] = useState(() =>
    readRecentLibraryIds()
      .map(findPrevizLibraryEntry)
      .filter((entry): entry is PrevizLibraryEntry => entry !== undefined),
  );
  // 拖着卡片往视口走时面板整个让开：既露出落点，也让 drop 事件落到下面的画布上。
  const [dragging, setDragging] = useState(false);
  const [spot, setSpot] = useState<[number, number] | null>(null);
  // 引用稳定的理由见 `PrevizCharacterCreateDialog.handlePick`。
  const handlePick = useCallback((point: [number, number]) => setSpot(point), []);

  const choose = (next: PendingModel) => {
    setPending(next);
    // 换一个模型就重新选：上一个的落点留着的话，「放置」一点就亮，用户以为不用再选。
    setSpot(null);
  };

  const place = () => {
    if (!pending || !spot) return;
    if (pending.kind === "entry") onPlace(pending.entry, spot);
    else onImportFile(pending.file, spot);
  };

  const matches = useMemo(() => {
    const inCategory =
      category === "all"
        ? PREVIZ_LIBRARY_ENTRIES
        : category === "recent"
          ? recent
          : PREVIZ_LIBRARY_ENTRIES.filter((entry) => entry.category === category);
    return searchLibrary(inCategory, query, (key) => t(key));
  }, [category, query, recent, t]);

  const railButton = (value: CategoryFilter, label: string, count: number) => (
    <button
      key={value}
      type="button"
      aria-pressed={category === value}
      className={RAIL_ITEM}
      onClick={() => setCategory(value)}
    >
      <span className="truncate">{label}</span>
      <span className="tabular-nums text-white/35">{count}</span>
    </button>
  );

  return (
    <section
      role="dialog"
      aria-modal="true"
      // 面板自己得能接住焦点：没有 tabIndex 的话，点击面板里的空白处（不落在任何按钮
      // /输入框上）时，浏览器会把焦点交给最近一个可聚焦的祖先——那就是外层编辑器的
      // DialogContent，而编辑器的全局快捷键守卫认的正是它身上那个 `data-previz-editor`
      // 标记，一旦焦点落在那儿，Delete/Backspace/空格这些编辑器快捷键就会穿透过来，
      // 删掉选中对象或切换播放。tabIndex={-1}（不进 Tab 序）让空白点击就地接住焦点，
      // 守卫那边靠 `closest('[role="dialog"]')` 认出这是「别的弹窗」，原样跳过。
      tabIndex={-1}
      aria-label={t("previz.library.title")}
      className={cn(
        // 左侧多留一截给工具栏：它是 z-30 压在浮层上面的，视口窄（侧栏展开）时面板左缘会钻到它底下。
        // 按浮层（即视口）宽度切布局：双侧栏都开时视口可能只剩三四百 px，横排分类栏 +
        // 图标导入按钮把宽度让给结果网格。
        "@container absolute inset-0 z-20 flex items-center justify-center bg-black/60 py-3 pl-[108px] pr-3 transition-opacity duration-150 @min-[720px]:py-6 @min-[720px]:pl-[120px] @min-[720px]:pr-6",
        dragging && "pointer-events-none opacity-0",
      )}
    >
      <div className="flex h-full max-h-[640px] w-full max-w-[880px] flex-col gap-3 rounded-[16px] border border-white/10 bg-neutral-900 p-3 shadow-2xl shadow-black/50 @min-[720px]:gap-4 @min-[720px]:rounded-[20px] @min-[720px]:p-5">
        <header className="flex h-7 items-center justify-between">
          {pending ? (
            <div className="flex min-w-0 items-center gap-1">
              <button
                type="button"
                className={STEP_BUTTON}
                aria-label={t("previz.library.back")}
                onClick={() => setPending(null)}
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <h4 className="truncate text-[15px] font-semibold text-white">
                {t("previz.library.placeTitle", {
                  name: pending.kind === "entry" ? t(pending.entry.nameKey) : pending.file.name,
                })}
              </h4>
            </div>
          ) : (
            <h4 className="text-[15px] font-semibold text-white">{t("previz.library.title")}</h4>
          )}
          <button
            type="button"
            className={STEP_BUTTON}
            aria-label={t("previz.library.close")}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {pending ? (
          <PlaceStep
            pending={pending}
            objects={objects}
            footprints={footprints}
            onRenderTopDown={onRenderTopDown}
            spot={spot}
            onPick={handlePick}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3 @min-[720px]:flex-row @min-[720px]:gap-5">
            <nav
              aria-label={t("previz.library.categories")}
              className="-mx-1 flex shrink-0 gap-0.5 overflow-auto px-1 @min-[720px]:mx-0 @min-[720px]:w-40 @min-[720px]:flex-col @min-[720px]:px-0"
            >
              {railButton("all", t("previz.library.all"), COUNTS.all)}
              {recent.length > 0 &&
                railButton("recent", t("previz.library.recent"), recent.length)}
              {CATEGORIES.map((value) =>
                railButton(
                  value,
                  t(PREVIZ_LIBRARY_CATEGORIES[value].labelKey),
                  COUNTS.byCategory[value],
                ),
              )}
            </nav>

            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
              {/* 导入跟搜索并排：都是「找一个模型」的入口，单独给它一条底栏只剩一大片空白。 */}
              <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35"
              />
              <input
                type="search"
                // 打开就是来找东西的：直接能打字，不用先去点一下搜索框。
                autoFocus
                aria-label={t("previz.library.search")}
                placeholder={t("previz.library.search")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-9 w-full rounded-[10px] border border-white/10 bg-white/[0.04] pl-9 pr-3 text-[13px] text-white/90 outline-none transition-colors placeholder:text-white/35 focus:border-white/25 focus:bg-white/[0.06] [&::-webkit-search-cancel-button]:hidden"
              />
              </div>
              <div className="flex shrink-0">
                {/*
                  input 是 `sr-only` 而不是 `hidden`：display:none 的控件拿不到焦点，键盘用户就
                  再也够不着导入入口了。视觉上的按钮是它的 <label>，焦点环靠 peer-* 从 input 转过来。
                  无障碍名字只由 <label> 的可见文字提供——再挂一份 aria-label 是两处真相，
                  改坏其中一处另一处会把问题遮住。
                  label 上那三个 peer-focus-visible:* 是 buttonVariants 基类里 focus-visible:*
                  的同值翻版（Tailwind 无法给现成的变体换前缀）；设计系统改焦点环时这里要跟着改。
                */}
                <input
                  id={fileInputId}
                  type="file"
                  accept=".glb,.gltf,.obj"
                  className="peer sr-only"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) choose({ kind: "file", file });
                    // 清空 value：不清的话选同一个文件第二次不会触发 change。
                    event.target.value = "";
                  }}
                />
                <label
                  htmlFor={fileInputId}
                  className={cn(
                    SECONDARY_BUTTON,
                    "cursor-pointer peer-focus-visible:border-ring peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50 @max-[720px]:w-9 @max-[720px]:justify-center @max-[720px]:px-0",
                  )}
                >
                  <Upload className="h-3.5 w-3.5" />
                  {/* 窄时只留图标；文字用 sr-only 藏起来而不是删掉，无障碍名字仍来自它。 */}
                  <span className="@max-[720px]:sr-only">{t("previz.library.importLocal")}</span>
                </label>
              </div>
              </div>
              {matches.length > 0 ? (
                // 负边距加回内边距：悬停底色与焦点环贴着滚动区边缘时不被裁掉。
                <ul className="-mx-1.5 grid min-h-0 grid-cols-[repeat(auto-fill,minmax(96px,1fr))] @min-[720px]:grid-cols-[repeat(auto-fill,minmax(124px,1fr))] content-start gap-1 overflow-y-auto px-0 pb-1">
                  {matches.map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        className={CARD}
                        onClick={() => choose({ kind: "entry", entry })}
                        // 拖进视口松手即放在那一点，省掉「选落点」那一屏；点击仍走原来的流程。
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.setData(PREVIZ_LIBRARY_DRAG_TYPE, entry.id);
                          event.dataTransfer.effectAllowed = "copy";
                          const thumb = event.currentTarget.querySelector("img");
                          if (thumb) {
                            event.dataTransfer.setDragImage(thumb, thumb.width / 2, thumb.height / 2);
                          }
                          // 推迟一帧再让开：dragstart 里同步改源元素的祖先，Chrome 会当场取消这次拖拽。
                          requestAnimationFrame(() => setDragging(true));
                        }}
                        // 没落进视口（拖回来、按了 Esc）面板原样回来；落进去了编辑器会把它关掉。
                        onDragEnd={() => setDragging(false)}
                      >
                        <span className={THUMB_WELL}>
                          <EntryThumbnail entry={entry} className="h-[72%] w-[72%]" />
                        </span>
                        <span className="flex w-full flex-col gap-0.5 px-1 pb-0.5">
                          <span className="truncate text-[12px] font-medium">{t(entry.nameKey)}</span>
                          <span className="text-[11px] tabular-nums text-white/35">
                            {t("previz.library.triangles", { count: entry.triangles })}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-16 text-center text-[13px] text-white/40">
                  {t("previz.library.empty")}
                </p>
              )}
            </div>
          </div>
        )}

        {pending ? (
          <footer className="flex items-center justify-end gap-2 border-t border-white/10 pt-4">
            <button
              type="button"
              className={SECONDARY_BUTTON}
              onClick={() => setPending(null)}
            >
              {t("previz.library.back")}
            </button>
            <button
              type="button"
              disabled={!spot}
              className="h-9 shrink-0 rounded-[10px] bg-white/90 px-4 text-[12px] font-medium text-black transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-white/25 disabled:text-black/40"
              onClick={place}
            >
              {t("previz.library.place")}
            </button>
          </footer>
        ) : null}
      </div>
    </section>
  );
}

/** 选落点那一屏：左边俯视选位图，右边是挑中的模型与落点读数。 */
function PlaceStep({
  pending,
  objects,
  footprints,
  onRenderTopDown,
  spot,
  onPick,
}: {
  pending: PendingModel;
  objects: readonly PrevizObject[];
  footprints?: readonly PrevizTopDownFootprint[];
  onRenderTopDown?: (canvas: HTMLCanvasElement) => PrevizTopDownView | null;
  spot: [number, number] | null;
  onPick: (point: [number, number]) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 gap-4">
      <PrevizTopDownPicker
        objects={objects}
        footprints={footprints}
        renderTopDown={onRenderTopDown}
        value={spot}
        onPick={onPick}
      />
      <div className="flex min-w-0 flex-1 flex-col items-center gap-3 pt-6">
        {pending.kind === "entry" ? (
          <span className={cn(THUMB_WELL, "w-32")}>
            <EntryThumbnail entry={pending.entry} className="h-[72%] w-[72%]" />
          </span>
        ) : (
          <span className="flex h-16 w-16 items-center justify-center text-white/25">
            <Box className="h-7 w-7" />
          </span>
        )}
        <span className="w-full truncate text-center text-[12px] text-white/80">
          {pending.kind === "entry" ? t(pending.entry.nameKey) : pending.file.name}
        </span>
        <div className="flex w-full max-w-[220px] items-center gap-2">
          <span className="shrink-0 text-[11px] text-white/45">{t("previz.library.spot")}</span>
          {/* 读数 `aria-live` 的理由同人物创建对话框的站位读数。 */}
          <span
            aria-label={t("previz.library.spotLabel")}
            aria-live="polite"
            className="min-w-0 flex-1 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2 py-1.5 text-center text-[12px] tabular-nums text-white/85"
          >
            {spot ? `${spot[0].toFixed(2)} / ${spot[1].toFixed(2)}` : "— / —"}
          </span>
        </div>
        {!spot && (
          <p className="text-center text-[12px] text-white/40">{t("previz.library.pickHint")}</p>
        )}
      </div>
    </div>
  );
}

/**
 * 基础几何体用随前端发布的白模渲染图（`scripts/render-previz-primitive-thumbnails.mjs`
 * 生成）；CDN 模型用 CDN 上的缩略图。图挂了退成一个方块图标，卡片不塌。
 */
function EntryThumbnail({ entry, className }: { entry: PrevizLibraryEntry; className: string }) {
  const [failed, setFailed] = useState(false);
  const src =
    entry.assetFormat === "primitive" && isPrevizPrimitiveShape(entry.assetUrl)
      ? `/previz/primitives/${entry.assetUrl}.webp`
      : entry.thumbnailUrl;
  if (!src || failed) {
    return (
      <span className={cn("flex items-center justify-center text-white/25", className)}>
        <Box className="h-7 w-7" />
      </span>
    );
  }
  return (
    <img
      src={src}
      // 名字就在卡片下面，图只是装饰。
      alt=""
      // 两百多张图，只取滚进视口的那些。
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
      // 模型库的模型进场景一律是白模（见 `applyClayMaterial`），缩略图跟着去色，
      // 免得挑的时候是彩色、摆进去变灰。用户自己导入的模型保留原色，这里也不动。
      className={cn(
        "object-contain", className,
        isPrevizLibraryModelUrl(entry.assetUrl) && "brightness-110 grayscale",
      )}
    />
  );
}
