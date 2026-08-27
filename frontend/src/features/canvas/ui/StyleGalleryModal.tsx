// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, X } from 'lucide-react';

import type { FreezoneStyleTemplate } from '@/api/ops';
import { StyleAssetImage } from '@/features/canvas/ui/StyleAssetImage';

const STYLE_GALLERY_MODAL_CLASS =
  'relative flex w-[min(1120px,92vw)] flex-col overflow-hidden rounded-[10px] border border-white/[0.12] bg-[#15161b]/96 shadow-[0_18px_48px_rgba(0,0,0,0.45)] backdrop-blur-md';
const STYLE_GALLERY_LIST_SIZE_CLASS = 'h-[min(720px,82vh)]';
const STYLE_GALLERY_DETAIL_SIZE_CLASS = 'max-h-[82vh]';

const ALL_CATEGORIES = '__all__';
const OTHER_CATEGORY = '__other__';

/** 后端 category 的出现顺序就是展示顺序,没填分类的统一落到最后的「其他」。 */
export function collectStyleCategories(
  templates: FreezoneStyleTemplate[],
): Array<{ key: string; label: string }> {
  const seen: string[] = [];
  let hasOther = false;
  for (const item of templates) {
    const category = item.category?.trim() ?? '';
    if (!category) {
      hasOther = true;
      continue;
    }
    if (!seen.includes(category)) seen.push(category);
  }
  const list = seen.map((category) => ({ key: category, label: category }));
  if (hasOther) list.push({ key: OTHER_CATEGORY, label: '其他' });
  return list;
}

export function filterStylesByCategory(
  templates: FreezoneStyleTemplate[],
  category: string,
): FreezoneStyleTemplate[] {
  if (category === ALL_CATEGORIES) return templates;
  if (category === OTHER_CATEGORY) {
    return templates.filter((item) => !item.category?.trim());
  }
  return templates.filter((item) => item.category?.trim() === category);
}

export interface StyleGalleryModalProps {
  templates: FreezoneStyleTemplate[];
  assetBase: string;
  selectedId: string | null;
  isLoading?: boolean;
  /** 只回调,不自己关闭;关闭由调用方决定。 */
  onSelect: (id: string | null) => void;
  onClose: () => void;
}

export function StyleGalleryModal({
  templates,
  assetBase,
  selectedId,
  isLoading = false,
  onSelect,
  onClose,
}: StyleGalleryModalProps) {
  const [detailId, setDetailId] = useState<string | null>(null);
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  const detail = detailId
    ? templates.find((item) => item.id === detailId) ?? null
    : null;
  const categories = useMemo(() => collectStyleCategories(templates), [templates]);
  const visible = useMemo(
    () => filterStylesByCategory(templates, category),
    [templates, category],
  );

  useEffect(() => {
    // 冒泡阶段监听，跟画布上别的弹层一个路数（见 CanvasHistoryAssetsModal）。
    // 早先挂在 capture 上还 stopPropagation，等于把 Esc 从整个页面手里抢走 ——
    // 事件连 target 都到不了，别人的输入法/内嵌弹层就都失灵了。详情页先自己吃掉
    // 一次 Esc（退回图墙），第二次才关整个弹层。
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      if (detailId) setDetailId(null);
      else onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [detailId, onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/55"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`${STYLE_GALLERY_MODAL_CLASS} ${
          detail ? STYLE_GALLERY_DETAIL_SIZE_CLASS : STYLE_GALLERY_LIST_SIZE_CLASS
        }`}
        role="dialog"
        aria-modal="true"
        aria-label={detail ? `风格 ${detail.label}` : '风格图墙'}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {detail ? (
          <div className="flex h-12 shrink-0 items-center justify-between px-4">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setDetailId(null)}
                aria-label="返回"
                className="flex size-7 items-center justify-center rounded-md text-text-muted/90 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
              >
                <ArrowLeft className="size-4" />
              </button>
              <span className="text-sm font-medium text-text-dark">{detail.label}</span>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="flex size-7 items-center justify-center rounded-md text-text-muted/90 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
            >
              <X className="size-4" />
            </button>
          </div>
        ) : null}

        {detail ? (
          <div className="flex min-h-0 gap-4 overflow-hidden p-4">
            <div className="ui-scrollbar grid min-h-0 flex-1 grid-cols-2 content-start gap-2 overflow-y-auto">
              {/* 同一条风格里出现两张同名示例图并非不可能（外部清单是运维自己写的），
                  用路径当 key 会撞车，索引才是这里稳定的身份。 */}
              {detail.samples.map((sample, index) => (
                <StyleAssetImage
                  key={`${detail.id}-${index}`}
                  rel={sample}
                  assetBase={assetBase}
                  alt={`${detail.label} 示例 ${index + 1}`}
                  loading="lazy"
                  className="aspect-video w-full rounded-[8px] border border-white/[0.08] object-cover"
                />
              ))}
            </div>
            <div className="w-[320px] shrink-0">
              <div className="flex max-h-[min(420px,calc(82vh-96px))] flex-col gap-4 rounded-[8px] border border-white/[0.08] bg-white/[0.03] p-3">
                <p className="ui-scrollbar min-h-0 overflow-y-auto whitespace-pre-line text-xs leading-relaxed text-text-dark/80">
                  {detail.style_prompt}
                </p>
                <button
                  type="button"
                  onClick={() => onSelect(detail.id)}
                  className="h-8 shrink-0 rounded-[6px] bg-white/[0.92] text-sm font-medium text-black transition-colors hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--accent-rgb))]"
                >
                  使用
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pr-12 pt-4">
              {categories.length > 1 ? (
                <div className="ui-scrollbar flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
                  {[{ key: ALL_CATEGORIES, label: '全部' }, ...categories].map((entry) => {
                    const isActive = entry.key === category;
                    return (
                      <button
                        key={entry.key}
                        type="button"
                        onClick={() => setCategory(entry.key)}
                        className={`h-7 shrink-0 rounded-[6px] px-2.5 text-xs font-medium transition-colors ${
                          isActive
                            ? 'bg-white/[0.14] text-text-dark'
                            : 'text-text-dark/62 hover:bg-white/[0.08] hover:text-text-dark'
                        }`}
                      >
                        {entry.label}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="flex-1" />
              )}
              {selectedId ? (
                <button
                  type="button"
                  onClick={() => onSelect(null)}
                  className="h-7 shrink-0 rounded-md px-2 text-[11px] font-medium text-text-dark/78 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
                >
                  清除风格
                </button>
              ) : null}
              <button
                type="button"
                onClick={onClose}
                aria-label="关闭"
                className="absolute right-4 top-2.5 flex size-7 items-center justify-center rounded-md text-text-muted/90 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
              >
                <X className="size-4" />
              </button>
            </div>
            {/* 空态和网格是二选一：以前两块都挂 flex-1 同时渲染，
                「加载中」被挤到上半屏，下半屏是一片空白网格。 */}
            {templates.length === 0 ? (
              <div className="flex flex-1 items-center justify-center text-xs text-text-muted">
                {isLoading ? '加载中…' : '暂无风格模板'}
              </div>
            ) : (
              <div className="ui-scrollbar flex-1 overflow-y-auto p-4 [scrollbar-gutter:stable]">
                <div className="grid grid-cols-4 gap-3">
                  {visible.map((item) => {
                    const isActive = item.id === selectedId;
                    return (
                      <div
                        key={item.id}
                        className={`group relative overflow-hidden rounded-[12px] border bg-white/[0.04] shadow-[0_14px_34px_rgba(0,0,0,0.22)] transition-[border-color,box-shadow] duration-300 ease-out hover:border-cyan-100/40 hover:shadow-[0_20px_44px_rgba(0,0,0,0.34),0_0_24px_rgba(103,232,249,0.08)] focus-within:border-cyan-100/40 ${
                          isActive
                            ? 'border-white/[0.30] ring-1 ring-white/24'
                            : 'border-white/[0.10]'
                        }`}
                      >
                        {/* 卡片主体进详情：一张封面看不出这套风格怎么处理不同年龄性别的
                            人物，那四张示例图才看得出来，所以详情是主路径不是彩蛋。 */}
                        <button
                          type="button"
                          onClick={() => setDetailId(item.id)}
                          aria-label={`查看${item.label}详情`}
                          className="block w-full cursor-pointer text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[rgb(var(--accent-rgb))]"
                        >
                          <StyleAssetImage
                            rel={item.cover}
                            assetBase={assetBase}
                            alt={item.label}
                            loading="lazy"
                            className="aspect-video w-full origin-top object-cover transition-transform duration-300 ease-out will-change-transform group-hover:scale-[1.02] group-focus-within:scale-[1.02]"
                          />
                        </button>
                        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-white/[0.04] opacity-80 transition-opacity duration-300 group-hover:opacity-100 group-focus-within:opacity-100" />
                        <div className="pointer-events-none absolute bottom-2.5 left-3 right-16 truncate text-xs font-medium text-white/92">
                          {item.label}
                        </div>
                        {isActive && (
                          <Check className="pointer-events-none absolute right-2 top-2 size-4 text-[rgb(var(--accent-rgb))]" />
                        )}
                        {/* 快路径：已经知道要哪套的人不该被逼着走一趟详情。常驻可见而不是
                            hover 才出 —— opacity-0 没有 focus 变体时，键盘 Tab 聚焦上去
                            按钮照样透明，这个入口对键盘用户等于不存在。绝对定位盖在标题行
                            上，没嵌进上面那颗 button：button 里套 button 是非法结构。 */}
                        <button
                          type="button"
                          onClick={() => onSelect(item.id)}
                          aria-label={`使用${item.label}`}
                          className="absolute bottom-2 right-2 h-6 rounded-[6px] bg-white/[0.16] px-2 text-[11px] font-medium text-white transition-colors hover:bg-white/[0.28] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--accent-rgb))]"
                        >
                          使用
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function describeStyleSelection(
  selectedId: string | null,
  templates: FreezoneStyleTemplate[],
): FreezoneStyleTemplate | null {
  if (!selectedId) return null;
  return templates.find((item) => item.id === selectedId) ?? null;
}

/**
 * 「选了风格」和「查得到这个风格」是两件事：清单还在路上、拉取失败、id 是旧画布
 * 留下的失效值，三种情况下 describeStyleSelection 都返回 null。UI 不能把它们一律
 * 当成「没选」—— 那个 id 照样会跟着生成请求发给后端。
 */
export type StyleSelectionState =
  | 'none'
  | 'ready'
  | 'loading'
  | 'failed'
  | 'missing';

export function resolveStyleSelectionState(
  selectedId: string | null,
  template: FreezoneStyleTemplate | null,
  source: { isLoading: boolean; hasError: boolean },
): StyleSelectionState {
  if (!selectedId) return 'none';
  if (template) return 'ready';
  if (source.isLoading) return 'loading';
  if (source.hasError) return 'failed';
  return 'missing';
}
