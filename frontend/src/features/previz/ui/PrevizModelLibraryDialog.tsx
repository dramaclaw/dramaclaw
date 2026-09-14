// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useId, useMemo, useState } from "react";
import { Upload, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  PREVIZ_LIBRARY_CATEGORIES,
  PREVIZ_LIBRARY_ENTRIES,
  countByCategory,
  searchLibrary,
  type PrevizLibraryCategory,
  type PrevizLibraryEntry,
} from "@/features/previz/domain/modelLibrary";
import { isPrevizPrimitiveShape } from "@/features/previz/domain/primitives";
import { PrevizPrimitivePreview } from "@/features/previz/ui/PrevizPrimitivePreview";

export interface PrevizModelLibraryDialogProps {
  open: boolean;
  /** 挑中一张卡片。关不关对话框由父级决定（它还要先查上限、建物件）。 */
  onPick: (entry: PrevizLibraryEntry) => void;
  /** 从本地选了一个模型文件。上传、压缩、toast 仍走编辑器原来那条导入流程。 */
  onImportFile: (file: File) => void;
  onClose: () => void;
}

type CategoryFilter = PrevizLibraryCategory | "all";

const CATEGORIES = Object.keys(PREVIZ_LIBRARY_CATEGORIES) as PrevizLibraryCategory[];
/** 清单是写死的，计数只算一次。 */
const COUNTS = countByCategory(PREVIZ_LIBRARY_ENTRIES);

/** 与机位 / 人物创建对话框同一套：箭头、关闭这类图标按钮不描边，悬停浮起一层底色。 */
const STEP_BUTTON =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded text-white/45 transition-colors hover:bg-white/10 hover:text-white/90";
const RAIL_ITEM =
  "flex h-8 items-center justify-between gap-2 rounded-md px-2 text-left text-[12px] text-white/60 transition-colors hover:bg-white/[0.06] hover:text-white/90 aria-pressed:bg-white/10 aria-pressed:text-white/90";
const CARD =
  "flex w-full flex-col items-center gap-1 rounded-lg border border-white/[0.06] bg-white/[0.03] p-2 text-white/60 transition-colors hover:border-white/20 hover:bg-white/[0.06] hover:text-white/90";

/**
 * 模型库：左栏分类带计数，右侧搜索加卡片网格，本地导入退到底部的次按钮。
 *
 * 铺在视口上而不是再套一层 base-ui Dialog，理由同机位创建对话框：编辑器本身已经是个
 * 全屏 Dialog，嵌套会把焦点陷阱和 Esc 各劫持一遍。
 */
export function PrevizModelLibraryDialog({ open, ...props }: PrevizModelLibraryDialogProps) {
  // 关掉就整个卸载：搜索词和分类不跨次保留，每次打开都从「全部」开始。
  if (!open) return null;
  return <LibraryPanel {...props} />;
}

function LibraryPanel({ onPick, onImportFile, onClose }: Omit<PrevizModelLibraryDialogProps, "open">) {
  const { t } = useTranslation();
  const fileInputId = useId();
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const inCategory =
      category === "all"
        ? PREVIZ_LIBRARY_ENTRIES
        : PREVIZ_LIBRARY_ENTRIES.filter((entry) => entry.category === category);
    return searchLibrary(inCategory, query, (key) => t(key));
  }, [category, query, t]);

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
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 p-6"
    >
      <div className="flex h-full max-h-[560px] w-full max-w-[760px] flex-col gap-3 rounded-xl border border-white/10 bg-[#14161b] p-4 shadow-2xl">
        <header className="flex items-center justify-between">
          <h4 className="text-[13px] font-medium text-white/90">{t("previz.library.title")}</h4>
          <button
            type="button"
            className={STEP_BUTTON}
            aria-label={t("previz.library.close")}
            onClick={onClose}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 gap-4">
          <nav
            aria-label={t("previz.library.categories")}
            className="flex w-36 shrink-0 flex-col gap-0.5"
          >
            {railButton("all", t("previz.library.all"), COUNTS.all)}
            {CATEGORIES.map((value) =>
              railButton(
                value,
                t(PREVIZ_LIBRARY_CATEGORIES[value].labelKey),
                COUNTS.byCategory[value],
              ),
            )}
          </nav>

          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <input
              type="search"
              // 打开就是来找东西的：直接能打字，不用先去点一下搜索框。
              autoFocus
              aria-label={t("previz.library.search")}
              placeholder={t("previz.library.search")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-8 w-full rounded-md border border-white/10 bg-white/[0.04] px-2 text-[12px] text-white/90 outline-none placeholder:text-white/30 focus:border-white/25"
            />
            {matches.length > 0 ? (
              <ul className="grid min-h-0 grid-cols-[repeat(auto-fill,minmax(112px,1fr))] content-start gap-2 overflow-y-auto">
                {matches.map((entry) => (
                  <li key={entry.id}>
                    <button type="button" className={CARD} onClick={() => onPick(entry)}>
                      {entry.assetFormat === "primitive" && isPrevizPrimitiveShape(entry.assetUrl) && (
                        <PrevizPrimitivePreview shape={entry.assetUrl} className="h-16 w-16" />
                      )}
                      <span className="w-full truncate text-center text-[12px]">
                        {t(entry.nameKey)}
                      </span>
                      <span className="text-[11px] tabular-nums text-white/35">
                        {t("previz.library.triangles", { count: entry.triangles })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-10 text-center text-[12px] text-white/40">
                {t("previz.library.empty")}
              </p>
            )}
          </div>
        </div>

        <footer className="flex justify-end border-t border-white/10 pt-3">
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
              if (file) onImportFile(file);
              // 清空 value：不清的话选同一个文件第二次不会触发 change。
              event.target.value = "";
            }}
          />
          <label
            htmlFor={fileInputId}
            className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-white/10 px-3 text-[12px] text-white/70 transition-colors hover:bg-white/10 hover:text-white/90 peer-focus-visible:border-ring peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50"
          >
            <Upload className="h-3.5 w-3.5" />
            {t("previz.library.importLocal")}
          </label>
        </footer>
      </div>
    </section>
  );
}
