// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Palette, X } from 'lucide-react';

import type { FreezoneStyleTemplate } from '@/api/ops';
import { StyleAssetImage } from '@/features/canvas/ui/StyleAssetImage';
import {
  NODE_REFERENCE_MEDIA_CHIP_CLASS,
  NODE_REFERENCE_MEDIA_DETACH_CLASS,
  NODE_TEXT_CONTROL_ICON_CLASS,
  NODE_TEXT_CONTROL_TRIGGER_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';

export interface StyleTriggerChipProps {
  onOpen: () => void;
}

/** 没选风格时才出现的入口 chip；选中后由缩略图接管,不再占顶排位置。 */
export function StyleTriggerChip({ onOpen }: StyleTriggerChipProps) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      title="风格"
      className={`${NODE_TEXT_CONTROL_TRIGGER_CLASS} shrink-0`}
    >
      <Palette className={`${NODE_TEXT_CONTROL_ICON_CLASS} shrink-0`} />
      <span>风格</span>
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
  return (
    <div className="group/stylethumb relative">
      <div
        role="button"
        tabIndex={0}
        aria-label={`风格 ${template.label}`}
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
          aria-label="清除风格"
          title="清除风格"
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
