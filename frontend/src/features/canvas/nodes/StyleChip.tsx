// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Palette, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { FreezoneStyleTemplate } from '@/api/ops';
import { StyleAssetImage } from '@/features/canvas/ui/StyleAssetImage';
import type { StyleSelectionState } from '@/features/canvas/ui/StyleGalleryModal';
import {
  NODE_REFERENCE_MEDIA_CHIP_CLASS,
  NODE_REFERENCE_MEDIA_DETACH_CLASS,
  NODE_TEXT_CONTROL_ICON_CLASS,
  NODE_TEXT_CONTROL_TRIGGER_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';

/** 缩略图接管的是 ready 态,所以这颗 chip 只需要覆盖其余四种。 */
export type StyleTriggerChipState = Exclude<StyleSelectionState, 'ready'>;

const STYLE_TRIGGER_CHIP_KEYS: Record<
  StyleTriggerChipState,
  { label: string; title: string }
> = {
  none: { label: 'canvas.style.chip', title: 'canvas.style.chip' },
  loading: {
    label: 'canvas.style.chipLoading',
    title: 'canvas.style.chipLoadingTitle',
  },
  failed: {
    label: 'canvas.style.chipFailed',
    title: 'canvas.style.chipFailedTitle',
  },
  missing: {
    label: 'canvas.style.chipMissing',
    title: 'canvas.style.chipMissingTitle',
  },
};

export interface StyleTriggerChipProps {
  /** 省略等于 none —— 没选风格的常态。 */
  state?: StyleTriggerChipState;
  onOpen: () => void;
}

/**
 * 没选到风格时占位的入口 chip；真选中并查到模板后由缩略图接管,不再占顶排位置。
 * 「查不到」不等于「没选」：加载中/加载失败/id 失效都要如实说,否则用户会以为
 * 自己没选风格,而那个 id 其实照样跟着生成请求走。
 */
export function StyleTriggerChip({
  state = 'none',
  onOpen,
}: StyleTriggerChipProps) {
  const { t } = useTranslation();
  const keys = STYLE_TRIGGER_CHIP_KEYS[state];
  const label = t(keys.label);
  const title = t(keys.title);
  const degraded = state === 'failed' || state === 'missing';
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      title={title}
      className={`${NODE_TEXT_CONTROL_TRIGGER_CLASS} shrink-0 ${
        degraded ? 'text-amber-300/90' : ''
      }`}
    >
      <Palette className={`${NODE_TEXT_CONTROL_ICON_CLASS} shrink-0`} />
      <span>{label}</span>
    </button>
  );
}

export interface StyleThumbnailProps {
  template: FreezoneStyleTemplate;
  assetBase: string;
  onOpen: () => void;
  onClear: () => void;
}

/** 选中的风格在输入框里留一张封面：点开图墙、hover 出名字和清除按钮。 */
export function StyleThumbnail({
  template,
  assetBase,
  onOpen,
  onClear,
}: StyleThumbnailProps) {
  const { t } = useTranslation();
  return (
    <div className="group/stylethumb relative">
      <div
        role="button"
        tabIndex={0}
        aria-label={t('canvas.style.thumbAria', { label: template.label })}
        className={`${NODE_REFERENCE_MEDIA_CHIP_CLASS} cursor-pointer`}
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onOpen();
        }}
      >
        <StyleAssetImage
          rel={template.cover}
          assetBase={assetBase}
          alt={template.label}
          draggable={false}
          className="h-full w-full object-cover"
        />
        <button
          type="button"
          aria-label={t('canvas.style.clear')}
          title={t('canvas.style.clear')}
          className={NODE_REFERENCE_MEDIA_DETACH_CLASS}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onClear();
          }}
        >
          <X className="h-3 w-3" strokeWidth={2.5} />
        </button>
      </div>
      {/* 缩略图只有 48px 放不下文字,名字放到 hover 浮层里。 */}
      <span className="pointer-events-none absolute left-full top-1/2 z-10 ml-1.5 hidden max-w-[160px] -translate-y-1/2 truncate whitespace-nowrap rounded bg-black/85 px-1.5 py-0.5 text-[11px] font-medium text-text-dark shadow-sm group-hover/stylethumb:block">
        {template.label}
      </span>
    </div>
  );
}
