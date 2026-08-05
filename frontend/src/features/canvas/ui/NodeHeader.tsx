// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  isCanvasMeasurementDeferred,
  onCanvasMeasurementResume,
} from '@/features/canvas/application/canvasLod';

type HeaderAdjust = {
  x?: number;
  y?: number;
  scale?: number;
};

type NodeHeaderProps = {
  icon?: ReactNode;
  titleText?: string;
  metaText?: string;
  title?: ReactNode;
  meta?: ReactNode;
  subtitle?: ReactNode;
  rightSlot?: ReactNode;
  className?: string;
  iconClassName?: string;
  toneClassName?: string;
  titleClassName?: string;
  metaClassName?: string;
  titleRowClassName?: string;
  subtitleClassName?: string;
  headerAdjust?: HeaderAdjust;
  iconAdjust?: HeaderAdjust;
  titleAdjust?: HeaderAdjust;
  editable?: boolean;
  onTitleChange?: (value: string) => void;
};

export const NODE_HEADER_TONE_CLASS = 'text-[rgba(15,23,42,0.68)] dark:text-white/55';
export const NODE_HEADER_TITLE_CLASS = 'text-[14px] font-normal';
export const NODE_HEADER_META_CLASS = 'text-xs text-text-muted';
export const NODE_HEADER_FLOATING_POSITION_CLASS = 'absolute -top-7 left-1 right-1 z-10';
const NODE_HEADER_TITLE_MAX_WIDTH_CLASS = 'max-w-[60%]';
const NODE_HEADER_TITLE_FADE_STYLE: CSSProperties = {
  WebkitMaskImage: 'linear-gradient(to right, #000 0%, #000 82%, transparent 100%)',
  maskImage: 'linear-gradient(to right, #000 0%, #000 82%, transparent 100%)',
};

function composeTransformStyle(adjust?: HeaderAdjust): CSSProperties | undefined {
  if (!adjust) {
    return undefined;
  }

  const x = adjust.x ?? 0;
  const y = adjust.y ?? 0;
  const scale = adjust.scale ?? 1;

  if (x === 0 && y === 0 && scale === 1) {
    return undefined;
  }

  return {
    transform: `translate(${x}px, ${y}px) scale(${scale})`,
    transformOrigin: 'center',
  };
}

function joinClasses(...classes: Array<string | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

function sanitizeTitle(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function NodeHeader({
  icon,
  titleText,
  metaText,
  title,
  meta,
  subtitle,
  rightSlot,
  className,
  iconClassName,
  toneClassName,
  titleClassName,
  metaClassName,
  titleRowClassName,
  subtitleClassName,
  headerAdjust,
  iconAdjust,
  titleAdjust,
  editable = false,
  onTitleChange,
}: NodeHeaderProps) {
  const tone = toneClassName ?? NODE_HEADER_TONE_CLASS;
  const canEditTitle = editable && typeof titleText === 'string' && typeof onTitleChange === 'function';
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [titleMeasureElement, setTitleMeasureElement] = useState<HTMLElement | null>(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [isTitleOverflowing, setIsTitleOverflowing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(() => sanitizeTitle(titleText));

  useEffect(() => {
    if (isEditingTitle) {
      return;
    }
    setDraftTitle(sanitizeTitle(titleText));
  }, [isEditingTitle, titleText]);

  useEffect(() => {
    if (!isEditingTitle) {
      return;
    }
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isEditingTitle]);

  useEffect(() => {
    if (!titleMeasureElement || isEditingTitle) {
      setIsTitleOverflowing(false);
      return;
    }

    // 读 scrollWidth/clientWidth 会强制同步布局，在画布这个体量的 DOM 上单次
    // 约 2ms。快速平移时可见性剔除每帧要挂载 3~4 个节点，每个都跑一遍，直接
    // 把帧预算吃穿（实测拖拽 20fps）。所以画布在动、或缩得太小看不清字的时候
    // 一律不量，等它静下来再补一次——标题淡出效果本来也只有静止时才看得见。
    const measureOverflow = () => {
      if (isCanvasMeasurementDeferred()) {
        return;
      }
      const nextOverflowing =
        titleMeasureElement.scrollWidth - titleMeasureElement.clientWidth > 1;
      setIsTitleOverflowing((previous) =>
        previous === nextOverflowing ? previous : nextOverflowing
      );
    };

    measureOverflow();
    const frameId = requestAnimationFrame(measureOverflow);
    const observer = new ResizeObserver(measureOverflow);
    observer.observe(titleMeasureElement);
    const unsubscribeResume = onCanvasMeasurementResume(measureOverflow);

    return () => {
      cancelAnimationFrame(frameId);
      observer.disconnect();
      unsubscribeResume();
    };
  }, [isEditingTitle, titleMeasureElement, titleText]);

  const commitTitle = useCallback(() => {
    if (!canEditTitle || !onTitleChange) {
      setIsEditingTitle(false);
      return;
    }

    const fallbackTitle = sanitizeTitle(titleText);
    const nextTitle = sanitizeTitle(draftTitle) || fallbackTitle;

    if (nextTitle && nextTitle !== fallbackTitle) {
      onTitleChange(nextTitle);
    }

    setDraftTitle(nextTitle || fallbackTitle);
    setIsEditingTitle(false);
  }, [canEditTitle, draftTitle, onTitleChange, titleText]);

  const cancelTitleEdit = useCallback(() => {
    setDraftTitle(sanitizeTitle(titleText));
    setIsEditingTitle(false);
  }, [titleText]);

  const titleFadeStyle = isTitleOverflowing ? NODE_HEADER_TITLE_FADE_STYLE : undefined;

  const resolvedTitle = useMemo(() => {
    if (!canEditTitle) {
      if (titleText) {
        return (
          <span
            ref={setTitleMeasureElement}
            title={titleText}
            className={joinClasses(
              'block min-w-0 overflow-hidden whitespace-nowrap cursor-grab select-none active:cursor-grabbing',
              NODE_HEADER_TITLE_MAX_WIDTH_CLASS,
              NODE_HEADER_TITLE_CLASS,
              tone,
              titleClassName
            )}
            style={titleFadeStyle}
          >
            {titleText}
          </span>
        );
      }
      return title;
    }

    if (isEditingTitle) {
      return (
        <input
          ref={inputRef}
          value={draftTitle}
          onChange={(event) => setDraftTitle(event.target.value)}
          onBlur={commitTitle}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitTitle();
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              cancelTitleEdit();
            }
          }}
          className={joinClasses(
            'nodrag nowheel h-6 min-w-[70px] w-full max-w-full rounded border border-[rgba(15,23,42,0.22)] bg-[rgba(255,255,255,0.86)] px-2 text-[13px] font-normal text-text-dark outline-none focus:border-accent/70 dark:border-[rgba(255,255,255,0.24)] dark:bg-black/30',
            titleClassName
          )}
        />
      );
    }

    return (
      <button
        type="button"
        ref={setTitleMeasureElement}
        className={joinClasses(
          'block min-w-0 overflow-hidden whitespace-nowrap cursor-grab select-none rounded px-0 text-left active:cursor-grabbing',
          NODE_HEADER_TITLE_MAX_WIDTH_CLASS,
          NODE_HEADER_TITLE_CLASS,
          tone,
          titleClassName
        )}
        style={titleFadeStyle}
        title={titleText}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => {
          event.stopPropagation();
          setIsEditingTitle(true);
        }}
      >
        {titleText}
      </button>
    );
  }, [
    canEditTitle,
    cancelTitleEdit,
    commitTitle,
    draftTitle,
    isEditingTitle,
    isTitleOverflowing,
    title,
    titleFadeStyle,
    titleClassName,
    titleText,
    tone,
  ]);

  const resolvedMeta = metaText
    ? <span className={joinClasses(NODE_HEADER_META_CLASS, metaClassName)}>{metaText}</span>
    : meta;

  return (
    <div className={joinClasses('w-full max-w-full', className)}>
      <div className="min-w-0 flex-1" style={composeTransformStyle(headerAdjust)}>
        <div className={joinClasses('flex w-full items-baseline justify-between gap-2', titleRowClassName)}>
          <div className="flex min-w-0 flex-1 items-baseline gap-1">
            {icon ? (
              <span
                className={joinClasses('inline-flex items-center justify-center self-center', tone, iconClassName)}
                style={composeTransformStyle(iconAdjust)}
              >
                {icon}
              </span>
            ) : null}
            <div
              className="flex w-0 min-w-0 flex-1 items-baseline gap-2"
              style={composeTransformStyle(titleAdjust)}
            >
              {resolvedTitle}
              {resolvedMeta}
            </div>
          </div>
          {rightSlot ? <div className="ml-2 flex shrink-0 items-baseline">{rightSlot}</div> : null}
        </div>
        {subtitle ? (
          <div className={joinClasses('text-[11px] text-text-muted/80', subtitleClassName)}>
            {subtitle}
          </div>
        ) : null}
      </div>
    </div>
  );
}

