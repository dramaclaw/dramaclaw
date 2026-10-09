// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { Check, ChevronDown, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  cropImageInPlace,
  CROP_ASPECT_OPTIONS,
  isFullFrameCrop,
  maxCenteredCropRect,
  resolveCropAspectRatio,
  type CropAspectOption,
  type CropRect,
} from '@/features/canvas/application/imageCrop';

import { CANVAS_NODE_TOOLBAR_PILL_CLASS } from './nodeFrameStyles';

/**
 * 「裁剪」编辑器的**外壳无关**内容层：状态机 + 取景框 + 那条控制条。
 *
 * 抽出来的理由同 rotateEditorContent：同一套交互要能挂在两种外壳上（工作流的
 * NodeToolbar / 故事板详情 portal 到 body 的全屏弹窗）。眼下只有故事板在用，但取景
 * 框的坐标换算与比例锁定逻辑不该长在弹窗外壳里。
 *
 * 坐标系：取景框 {@link CropRect} 一律存**源图自然像素**，渲染时按百分比落到显示盒
 * 上。因为图片是 object-contain，显示盒与自然尺寸严格同比，百分比两边通用——于是
 * 布局尺寸变化（窗口缩放）不需要重算 rect，只有指针位移要按比例尺换算回自然像素。
 */

export type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** 取景框最小边长（自然像素），防止拖成一条线甚至 0 宽。 */
const MIN_CROP_PX = 24;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 按手柄拖拽算出新的取景框（锁定 `ratio`，坐标全是自然像素）。
 *
 * 规则：被拖的对边固定不动（拖右边就锁左边），纯上下/左右手柄则保持另一轴居中；
 * 角手柄同时吃两个方向的位移，取两者换算出的宽度均值，斜着拖才跟手。
 */
export function resizeCropRect(
  start: CropRect,
  natural: { width: number; height: number },
  handle: CropHandle,
  dx: number,
  dy: number,
  ratio: number,
): CropRect {
  const west = handle.includes('w');
  const east = handle.includes('e');
  const north = handle.startsWith('n');
  const south = handle.startsWith('s');

  let width = start.width + (east ? dx : west ? -dx : 0);
  let height = start.height + (south ? dy : north ? -dy : 0);

  if (east || west) {
    // 角手柄：宽度取「横向拖出来的宽」与「纵向拖出来的高换算成的宽」的均值。
    width = north || south ? (width + height * ratio) / 2 : width;
    height = width / ratio;
  } else {
    width = height * ratio;
  }

  // 各方向的可用余量：锚定边到图边的距离；无锚定边（纯上下/左右手柄）时按中心
  // 对称展开，余量是到最近图边距离的两倍。
  const centerX = start.x + start.width / 2;
  const centerY = start.y + start.height / 2;
  const maxWidth = east
    ? natural.width - start.x
    : west
      ? start.x + start.width
      : 2 * Math.min(centerX, natural.width - centerX);
  const maxHeight = south
    ? natural.height - start.y
    : north
      ? start.y + start.height
      : 2 * Math.min(centerY, natural.height - centerY);

  // 先按高收口再按宽收口（两次都只会变小，不会把对方顶回去）。
  if (height > maxHeight) {
    height = maxHeight;
    width = height * ratio;
  }
  if (width > maxWidth) {
    width = maxWidth;
    height = width / ratio;
  }

  const minWidth = Math.max(MIN_CROP_PX, MIN_CROP_PX * ratio);
  if (width < minWidth) {
    width = Math.min(minWidth, maxWidth);
    height = width / ratio;
  }

  const x = west ? start.x + start.width - width : east ? start.x : centerX - width / 2;
  const y = north ? start.y + start.height - height : south ? start.y : centerY - height / 2;

  return {
    x: clamp(x, 0, Math.max(0, natural.width - width)),
    y: clamp(y, 0, Math.max(0, natural.height - height)),
    width,
    height,
  };
}

export interface CropEditorController {
  aspect: CropAspectOption;
  /** 取景框（自然像素）；图片还没加载出来时为 null。 */
  rect: CropRect | null;
  /** 源图自然尺寸；未加载时为 null。 */
  natural: { width: number; height: number } | null;
  isSaving: boolean;
  onAspectChange: (next: CropAspectOption) => void;
  /** 图片 onLoad 时把自然尺寸交进来，顺手把取景框铺满整图。 */
  onImageLoad: (image: HTMLImageElement) => void;
  setRect: (next: CropRect) => void;
  onExit: () => void;
  onSave: () => void;
}

export interface UseCropEditorOptions {
  /** 裁剪写回的目标节点（调用方进入编辑器前预建的「裁剪结果」节点）。 */
  nodeId: string;
  imageSource: string;
  /**
   * 关闭编辑器。`committed` 表示是否真正提交了一次裁剪（开始写回节点）：
   *   - `false`：退出 / Esc / 取景框还是整张图 —— 调用方应把预建的「裁剪结果」
   *     节点删掉，避免凭空多出一个节点。
   *   - `true` ：已开始把裁剪结果写回该节点，调用方保留它。
   */
  onClose: (committed: boolean) => void;
  /** 提交起飞后把 completion 交给宿主挂 busy 态与失败反馈（同 useRotateEditor）。 */
  onCommitted?: (completion: Promise<void>) => void;
}

export function useCropEditor({
  nodeId,
  imageSource,
  onClose,
  onCommitted,
}: UseCropEditorOptions): CropEditorController {
  const [aspect, setAspect] = useState<CropAspectOption>('original');
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [rect, setRect] = useState<CropRect | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const onImageLoad = useCallback(
    (image: HTMLImageElement) => {
      const size = { width: image.naturalWidth, height: image.naturalHeight };
      if (!(size.width > 0 && size.height > 0)) return;
      setNatural(size);
      const ratio = resolveCropAspectRatio(aspect, size);
      setRect(ratio ? maxCenteredCropRect(size, ratio) : null);
    },
    [aspect],
  );

  // 换比例 = 取景框复位成该比例下的最大居中矩形（同 liblib：不保留上一次的框）。
  const onAspectChange = useCallback(
    (next: CropAspectOption) => {
      setAspect(next);
      if (!natural) return;
      const ratio = resolveCropAspectRatio(next, natural);
      if (ratio) setRect(maxCenteredCropRect(natural, ratio));
    },
    [natural],
  );

  const onExit = useCallback(() => onClose(false), [onClose]);

  const onSave = useCallback(() => {
    if (isSaving) return;
    // 没框选（图还没加载）或取景框就是整张图 → 没什么可裁的，按「未提交」关闭，
    // 让调用方回收预建节点（等同退出）。
    if (!rect || !natural || isFullFrameCrop(rect, natural)) {
      onClose(false);
      return;
    }

    const completion = cropImageInPlace(nodeId, imageSource, rect);
    // 缺 project 时返回 null：不改变编辑态，保留用户框好的取景框。
    if (!completion) return;

    setIsSaving(true);
    onCommitted?.(completion);
    onClose(true);
    void completion.finally(() => setIsSaving(false));
  }, [imageSource, isSaving, natural, nodeId, onClose, onCommitted, rect]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSaving) {
        onClose(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isSaving, onClose]);

  return {
    aspect,
    rect,
    natural,
    isSaving,
    onAspectChange,
    onImageLoad,
    setRect,
    onExit,
    onSave,
  };
}

interface DragState {
  mode: 'move' | CropHandle;
  startX: number;
  startY: number;
  /** 显示像素 → 自然像素的比例尺。 */
  scale: number;
  startRect: CropRect;
  ratio: number;
}

const HANDLE_STYLE: Record<CropHandle, { position: string; shape: string; cursor: string }> = {
  nw: { position: '-left-px -top-px', shape: 'h-4 w-4 rounded-tl-[3px] border-l-2 border-t-2', cursor: 'nwse-resize' },
  ne: { position: '-right-px -top-px', shape: 'h-4 w-4 rounded-tr-[3px] border-r-2 border-t-2', cursor: 'nesw-resize' },
  sw: { position: '-bottom-px -left-px', shape: 'h-4 w-4 rounded-bl-[3px] border-b-2 border-l-2', cursor: 'nesw-resize' },
  se: { position: '-bottom-px -right-px', shape: 'h-4 w-4 rounded-br-[3px] border-b-2 border-r-2', cursor: 'nwse-resize' },
  n: { position: '-top-px left-1/2 -translate-x-1/2', shape: 'h-[3px] w-6 rounded-full bg-white', cursor: 'ns-resize' },
  s: { position: '-bottom-px left-1/2 -translate-x-1/2', shape: 'h-[3px] w-6 rounded-full bg-white', cursor: 'ns-resize' },
  w: { position: '-left-px top-1/2 -translate-y-1/2', shape: 'h-6 w-[3px] rounded-full bg-white', cursor: 'ew-resize' },
  e: { position: '-right-px top-1/2 -translate-y-1/2', shape: 'h-6 w-[3px] rounded-full bg-white', cursor: 'ew-resize' },
};

const CROP_HANDLES = Object.keys(HANDLE_STYLE) as CropHandle[];

/**
 * 取景界面：原图 + 框外压暗 + 三分线 + 八个手柄，整块可拖动。
 *
 * 根节点 `inline-block` 是刻意的——它必须**收窄到图片实际渲染尺寸**，取景框才能用
 * 百分比直接落位；换成铺满的块级盒，object-contain 留出的空白会把百分比算歪。
 *
 * @param className 加在图片上的尺寸约束（外壳决定图多大，如 `max-h-[78vh]`）。
 */
export function CropEditorSurface({
  controller,
  imageSource,
  className,
}: {
  controller: CropEditorController;
  imageSource: string;
  className?: string;
}): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const { natural, rect, setRect } = controller;

  const beginDrag = useCallback(
    (event: ReactPointerEvent, mode: 'move' | CropHandle) => {
      if (!rect || !natural || controller.isSaving) return;
      const box = hostRef.current?.getBoundingClientRect();
      if (!box || box.width <= 0) return;
      event.preventDefault();
      event.stopPropagation();
      dragRef.current = {
        mode,
        startX: event.clientX,
        startY: event.clientY,
        scale: natural.width / box.width,
        startRect: rect,
        ratio: rect.width / rect.height,
      };
      // jsdom 没有指针捕获，缺了也不影响逻辑，只是拖出元素外会断——故可选调用。
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    },
    [controller.isSaving, natural, rect],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent) => {
      const drag = dragRef.current;
      if (!drag || !natural) return;
      const dx = (event.clientX - drag.startX) * drag.scale;
      const dy = (event.clientY - drag.startY) * drag.scale;

      if (drag.mode === 'move') {
        setRect({
          ...drag.startRect,
          x: clamp(drag.startRect.x + dx, 0, natural.width - drag.startRect.width),
          y: clamp(drag.startRect.y + dy, 0, natural.height - drag.startRect.height),
        });
        return;
      }
      setRect(resizeCropRect(drag.startRect, natural, drag.mode, dx, dy, drag.ratio));
    },
    [natural, setRect],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  const frameStyle: CSSProperties | null =
    rect && natural
      ? {
          left: `${(rect.x / natural.width) * 100}%`,
          top: `${(rect.y / natural.height) * 100}%`,
          width: `${(rect.width / natural.width) * 100}%`,
          height: `${(rect.height / natural.height) * 100}%`,
        }
      : null;

  return (
    <div
      ref={hostRef}
      className="relative inline-block select-none"
      onClick={(event) => event.stopPropagation()}
    >
      <img
        src={imageSource}
        alt=""
        draggable={false}
        onLoad={(event) => controller.onImageLoad(event.currentTarget)}
        className={`block object-contain ${className ?? ''}`}
      />

      {frameStyle && (
        <>
          {/* 框外压暗：超大 spread 的 box-shadow 一把铺满，外层 overflow-hidden 把它
              裁回图片范围内——图片以外是弹窗自己的遮罩，不该再叠一层。 */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div
              className="absolute"
              style={{ ...frameStyle, boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)' }}
            />
          </div>

          {/* 交互层与压暗层分开：压暗层要被裁进图内，而贴着图边的手柄不能被裁掉。 */}
          <div className="absolute inset-0" onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
            <div
              className="absolute cursor-move touch-none border border-white/90"
              style={frameStyle}
              onPointerDown={(event) => beginDrag(event, 'move')}
            >
              {/* 三分线（构图参考，不参与命中）。 */}
              <span className="pointer-events-none absolute inset-y-0 left-1/3 w-px bg-white/25" aria-hidden />
              <span className="pointer-events-none absolute inset-y-0 left-2/3 w-px bg-white/25" aria-hidden />
              <span className="pointer-events-none absolute inset-x-0 top-1/3 h-px bg-white/25" aria-hidden />
              <span className="pointer-events-none absolute inset-x-0 top-2/3 h-px bg-white/25" aria-hidden />

              {CROP_HANDLES.map((handle) => {
                const meta = HANDLE_STYLE[handle];
                return (
                  <span
                    key={handle}
                    data-crop-handle={handle}
                    className={`absolute touch-none border-white ${meta.position} ${meta.shape}`}
                    style={{ cursor: meta.cursor }}
                    onPointerDown={(event) => beginDrag(event, handle)}
                  />
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** 比例小图标：按比例画一个描边矩形，让下拉里一眼看出是横是竖。 */
function AspectIcon({ ratio }: { ratio: number | null }): ReactElement {
  const safe = ratio && Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const width = safe >= 1 ? 13 : 13 * safe;
  const height = safe >= 1 ? 13 / safe : 13;
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden>
      <span className="rounded-[2px] border border-current" style={{ width, height }} />
    </span>
  );
}

/** 比例下拉：原图比例 / 1:1 / 4:3 / 3:4 / 16:9 / 9:16（顺序对齐 liblib）。 */
function AspectPicker({ controller }: { controller: CropEditorController }): ReactElement {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        popoverRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setIsOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [isOpen]);

  const natural = controller.natural ?? { width: 1, height: 1 };
  const label = (option: CropAspectOption): string =>
    option === 'original' ? t('cropEditor.aspectOriginal') : option;

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        disabled={controller.isSaving}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        title={t('cropEditor.aspectLabel')}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs text-text-dark transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <AspectIcon ratio={resolveCropAspectRatio(controller.aspect, natural)} />
        {label(controller.aspect)}
        <ChevronDown className="h-3 w-3 text-text-muted" />
      </button>

      {isOpen && (
        <div
          ref={popoverRef}
          role="listbox"
          aria-label={t('cropEditor.aspectLabel')}
          className="absolute left-0 top-full z-50 mt-2 w-[150px] rounded-xl border border-white/10 bg-surface-dark/95 p-1 shadow-2xl backdrop-blur-md"
        >
          {CROP_ASPECT_OPTIONS.map((option) => {
            const isActive = controller.aspect === option;
            return (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={isActive}
                onClick={() => {
                  controller.onAspectChange(option);
                  setIsOpen(false);
                }}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors ${
                  isActive ? 'bg-white/[0.12] text-white' : 'text-text-dark hover:bg-white/[0.06]'
                }`}
              >
                <AspectIcon ratio={resolveCropAspectRatio(option, natural)} />
                <span className="flex-1 text-left">{label(option)}</span>
                {isActive && <Check className="h-3 w-3" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * 控制条：退出 · 比例选择 · 确认（对齐 liblib 那条浮在取景框上方的胶囊）。
 *
 * @param showTitle 是否在退出钮右边显示「裁剪」标题，语义同 RotateEditorToolbar。
 */
export function CropEditorToolbar({
  controller,
  showTitle = false,
}: {
  controller: CropEditorController;
  showTitle?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const { isSaving } = controller;

  return (
    <div
      className={`flex w-max items-center gap-1 whitespace-nowrap ${CANVAS_NODE_TOOLBAR_PILL_CLASS}`}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-dark/70 text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark disabled:cursor-not-allowed disabled:opacity-50"
        onClick={controller.onExit}
        title={t('cropEditor.exit')}
        aria-label={t('cropEditor.exit')}
        disabled={isSaving}
      >
        <X className="h-4 w-4" />
      </button>

      {showTitle && (
        <>
          <span className="shrink-0 px-1.5 text-xs font-medium text-text-dark">
            {t('cropEditor.title')}
          </span>
          <span className="mx-0.5 h-5 w-px shrink-0 bg-white/10" aria-hidden />
        </>
      )}

      <AspectPicker controller={controller} />

      <button
        type="button"
        onClick={controller.onSave}
        disabled={isSaving}
        className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-white px-3 text-xs font-medium text-bg-dark transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        title={t('cropEditor.confirm')}
      >
        {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
        {isSaving ? t('cropEditor.saving') : t('cropEditor.confirm')}
      </button>
    </div>
  );
}
