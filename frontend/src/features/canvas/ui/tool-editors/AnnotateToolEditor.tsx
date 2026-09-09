// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight,
  Brush,
  Circle,
  Hand,
  Maximize,
  Square,
  Type,
  Undo2,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  Arrow,
  Ellipse,
  Group,
  Image as KonvaImage,
  Layer,
  Line,
  Rect,
  Stage,
  Text,
  Transformer,
} from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import type Konva from 'konva';

import type { ToolOptions } from '@/features/canvas/tools';
import {
  normalizeAnnotationRect,
  parseAnnotationItems,
  stringifyAnnotationItems,
  type AnnotationItem,
  type AnnotationToolType,
} from '@/features/canvas/tools/annotation';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import type { VisualToolEditorProps } from './types';

const VIEWPORT_PADDING_PX = 16;
const VIEWPORT_MIN_WIDTH_PX = 220;
const VIEWPORT_MIN_HEIGHT_PX = 180;
const DEFAULT_TEXT_SIZE_PERCENT = 10;
const MIN_TEXT_SIZE_PERCENT = 1;
const MAX_TEXT_SIZE_PERCENT = 30;
// 图片缩放：1 = 适配视口（fit），最大放大 8 倍，便于标注小细节。
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const ZOOM_BUTTON_STEP = 1.25;
const WHEEL_ZOOM_FACTOR = 1.1;
const DEFAULT_LINE_WIDTH_PERCENT = 0.4;
const MIN_LINE_WIDTH_PERCENT = 0.1;
const MAX_LINE_WIDTH_PERCENT = 3;
const ANNOTATE_RANGE_CLASS =
  'h-0.5 w-28 cursor-pointer appearance-none rounded-full bg-[rgba(255,255,255,0.36)] accent-[#5b8cff] [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#8ec5ff] [&::-webkit-slider-thumb]:shadow-none [&::-moz-range-thumb]:h-2.5 [&::-moz-range-thumb]:w-2.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[#8ec5ff]';
const ANNOTATE_TOOL_BUTTON_BASE_CLASS =
  'inline-flex h-7 items-center gap-1.5 px-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35';
const ANNOTATE_ACTION_BUTTON_BASE_CLASS =
  'inline-flex h-7 items-center gap-1.5 rounded-[9px] border px-2.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed';

function annotateActionButtonClass(enabled: boolean): string {
  return `${ANNOTATE_ACTION_BUTTON_BASE_CLASS} ${
    enabled
      ? 'border-white/24 text-text-dark hover:border-white/34 hover:bg-white/[0.04]'
      : 'border-white/[0.16] text-text-muted/58'
  }`;
}

type DraftState = {
  tool: Exclude<AnnotationToolType, 'text'>;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  points?: number[];
};

type ToolButton = { type: AnnotationToolType; labelKey: string; icon: typeof Square };

interface TextEditorState {
  annotationId: string | null;
  x: number;
  y: number;
  value: string;
}

const TOOL_BUTTONS: ToolButton[] = [
  { type: 'rect', labelKey: 'canvas.paintTools.rect', icon: Square },
  { type: 'ellipse', labelKey: 'canvas.annotateEditor.ellipse', icon: Circle },
  { type: 'arrow', labelKey: 'canvas.annotateEditor.arrow', icon: ArrowRight },
  { type: 'pen', labelKey: 'canvas.paintTools.brush', icon: Brush },
  { type: 'text', labelKey: 'canvas.annotateEditor.text', icon: Type },
];

function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toText(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function createAnnotationId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveTextBaseSize(image: HTMLImageElement | null): number {
  if (!image) {
    return 1000;
  }
  return Math.max(320, Math.min(image.naturalWidth, image.naturalHeight));
}

function percentToFontSize(percent: number, baseSize: number): number {
  return Math.max(10, Math.round(baseSize * (percent / 100)));
}

function fontSizeToPercent(fontSize: number, baseSize: number): number {
  if (!Number.isFinite(fontSize) || fontSize <= 0) {
    return DEFAULT_TEXT_SIZE_PERCENT;
  }
  return (fontSize / Math.max(1, baseSize)) * 100;
}

function percentToLineWidth(percent: number, baseSize: number): number {
  return Math.max(1, Math.round(baseSize * (percent / 100)));
}

function lineWidthToPercent(lineWidth: number, baseSize: number): number {
  if (!Number.isFinite(lineWidth) || lineWidth <= 0) {
    return DEFAULT_LINE_WIDTH_PERCENT;
  }
  return (lineWidth / Math.max(1, baseSize)) * 100;
}

function getPointsBounds(points: number[]): { minX: number; minY: number } {
  const xs = points.filter((_, index) => index % 2 === 0);
  const ys = points.filter((_, index) => index % 2 === 1);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
  };
}

function updateAnnotationPosition(item: AnnotationItem, newX: number, newY: number): AnnotationItem {
  if (item.type === 'arrow' || item.type === 'pen') {
    const { minX, minY } = getPointsBounds(item.points);
    const dx = newX - minX;
    const dy = newY - minY;
    return {
      ...item,
      points: item.points.map((point, index) => (index % 2 === 0 ? point + dx : point + dy)),
    } as AnnotationItem;
  }

  if (item.type === 'rect' || item.type === 'ellipse' || item.type === 'text') {
    return { ...item, x: newX, y: newY };
  }

  return item;
}

function updateAnnotationTransform(
  item: AnnotationItem,
  newX: number,
  newY: number,
  scaleX: number,
  scaleY: number
): AnnotationItem {
  if (item.type === 'rect' || item.type === 'ellipse') {
    return {
      ...item,
      x: newX,
      y: newY,
      width: Math.max(5, item.width * scaleX),
      height: Math.max(5, item.height * scaleY),
    };
  }

  if (item.type === 'text') {
    return {
      ...item,
      x: newX,
      y: newY,
      fontSize: Math.max(8, Math.round(item.fontSize * Math.max(scaleX, scaleY))),
    };
  }

  if (item.type === 'arrow' || item.type === 'pen') {
    const { minX, minY } = getPointsBounds(item.points);
    return {
      ...item,
      points: item.points.map((point, index) => {
        if (index % 2 === 0) {
          return newX + (point - minX) * scaleX;
        }
        return newY + (point - minY) * scaleY;
      }),
    } as AnnotationItem;
  }

  return item;
}

function canSelectByTool(tool: AnnotationToolType, item: AnnotationItem): boolean {
  return tool === item.type;
}

function canTransformAnnotation(item: AnnotationItem): boolean {
  return Boolean(item);
}

function pruneUndefinedToolOptionsPatch(patch: Partial<ToolOptions>): Partial<ToolOptions> {
  const next: Partial<ToolOptions> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }
    next[key] = value;
  }
  return next;
}

export function AnnotateToolEditor({ options, onOptionsChange, sourceImageUrl }: VisualToolEditorProps) {
  const { t } = useTranslation();
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<AnnotationToolType>('rect');
  const [annotations, setAnnotations] = useState<AnnotationItem[]>(() =>
    parseAnnotationItems(options.annotations)
  );
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [undoStack, setUndoStack] = useState<AnnotationItem[][]>([]);
  const [redoStack, setRedoStack] = useState<AnnotationItem[][]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [textEditorState, setTextEditorState] = useState<TextEditorState | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  // zoom = 在「适配比例」之上的放大倍数；offset = 放大后内容相对舞台左上角的平移（px）。
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // 按住空格进入「抓手」平移模式（放大后查看图片其它区域）。
  const [spaceDown, setSpaceDown] = useState(false);
  // 显式选中「移动」工具：直接拖拽图片调整位置（无需按空格），与绘制工具互斥。
  const [handTool, setHandTool] = useState(false);

  const stageRef = useRef<Konva.Stage | null>(null);
  const contentGroupRef = useRef<Konva.Group | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const shapeRefs = useRef<Map<string, Konva.Node>>(new Map());
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const stageHostRef = useRef<HTMLDivElement | null>(null);
  const textInputRef = useRef<HTMLTextAreaElement | null>(null);
  const panStartRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const isPanningRef = useRef(false);

  const color = toText(options.color, '#ff4d4f');
  const textBaseSize = useMemo(() => resolveTextBaseSize(image), [image]);
  const rawLineWidthPercent = toNumber(options.lineWidthPercent, NaN);
  const legacyLineWidth = Math.max(1, toNumber(options.lineWidth, 4));
  const lineWidthPercent = clamp(
    Number.isFinite(rawLineWidthPercent)
      ? rawLineWidthPercent
      : lineWidthToPercent(legacyLineWidth, textBaseSize),
    MIN_LINE_WIDTH_PERCENT,
    MAX_LINE_WIDTH_PERCENT
  );
  const lineWidth = percentToLineWidth(lineWidthPercent, textBaseSize);
  const rawTextPercent = toNumber(options.fontSizePercent, NaN);
  const legacyFontSize = Math.max(10, toNumber(options.fontSize, 28));
  const textSizePercent = clamp(
    Number.isFinite(rawTextPercent)
      ? rawTextPercent
      : fontSizeToPercent(legacyFontSize, textBaseSize),
    MIN_TEXT_SIZE_PERCENT,
    MAX_TEXT_SIZE_PERCENT
  );
  const fontSize = percentToFontSize(textSizePercent, textBaseSize);
  const canUndo = undoStack.length > 0;
  const canRedo = redoStack.length > 0;
  const canDeleteSelected = Boolean(selectedId);
  const canClear = annotations.length > 0;

  useEffect(() => {
    const nextAnnotations = parseAnnotationItems(options.annotations);
    setAnnotations(nextAnnotations);
    if (selectedId && !nextAnnotations.some((item) => item.id === selectedId)) {
      setSelectedId(null);
    }
  }, [options.annotations, selectedId]);

  useEffect(() => {
    const img = new window.Image();
    img.onload = () => setImage(img);
    img.onerror = () => setImage(null);
    img.src = resolveImageDisplayUrl(sourceImageUrl);
  }, [sourceImageUrl]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) {
      return;
    }

    const updateViewportSize = () => {
      const rect = element.getBoundingClientRect();
      setViewportSize({
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      });
    };

    updateViewportSize();
    const observer = new ResizeObserver(updateViewportSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { stageWidth, stageHeight, scale } = useMemo(() => {
    if (!image) {
      return { stageWidth: 820, stageHeight: 480, scale: 1 };
    }

    const maxWidth = Math.max(
      VIEWPORT_MIN_WIDTH_PX,
      viewportSize.width - VIEWPORT_PADDING_PX * 2
    );
    const maxHeight = Math.max(
      VIEWPORT_MIN_HEIGHT_PX,
      viewportSize.height - VIEWPORT_PADDING_PX * 2
    );
    const ratio = Math.min(maxWidth / image.naturalWidth, maxHeight / image.naturalHeight, 1);
    return {
      stageWidth: Math.max(1, Math.round(image.naturalWidth * ratio)),
      stageHeight: Math.max(1, Math.round(image.naturalHeight * ratio)),
      scale: ratio,
    };
  }, [image, viewportSize.height, viewportSize.width]);

  // 放大后允许的平移范围：内容比舞台大多少，就能往负方向拖多少，保证边缘不留空。
  const clampOffset = useCallback(
    (next: { x: number; y: number }, nextZoom: number) => {
      const scaledWidth = stageWidth * nextZoom;
      const scaledHeight = stageHeight * nextZoom;
      const minX = Math.min(0, stageWidth - scaledWidth);
      const minY = Math.min(0, stageHeight - scaledHeight);
      return { x: clamp(next.x, minX, 0), y: clamp(next.y, minY, 0) };
    },
    [stageHeight, stageWidth]
  );

  // 实际应用到 Group 的平移：始终夹紧，避免 resize / 切图后残留越界 offset。
  const appliedOffset = useMemo(() => clampOffset(offset, zoom), [clampOffset, offset, zoom]);

  // 以舞台坐标系中的某个点 (cx, cy) 为锚点缩放：该点对应的图片像素在缩放后停留原位。
  const zoomAtPoint = useCallback(
    (rawZoom: number, cx: number, cy: number) => {
      const nextZoom = clamp(rawZoom, MIN_ZOOM, MAX_ZOOM);
      const oldScale = scale * zoom;
      const newScale = scale * nextZoom;
      if (oldScale <= 0) {
        return;
      }
      const imageX = (cx - appliedOffset.x) / oldScale;
      const imageY = (cy - appliedOffset.y) / oldScale;
      setOffset(clampOffset({ x: cx - imageX * newScale, y: cy - imageY * newScale }, nextZoom));
      setZoom(nextZoom);
    },
    [appliedOffset.x, appliedOffset.y, clampOffset, scale, zoom]
  );

  const zoomByStep = useCallback(
    (factor: number) => {
      zoomAtPoint(zoom * factor, stageWidth / 2, stageHeight / 2);
    },
    [stageHeight, stageWidth, zoom, zoomAtPoint]
  );

  const resetZoom = useCallback(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const handleWheelZoom = useCallback(
    (event: KonvaEventObject<WheelEvent>) => {
      event.evt.preventDefault();
      const stage = stageRef.current;
      const pointer = stage?.getPointerPosition();
      if (!pointer) {
        return;
      }
      const factor = event.evt.deltaY > 0 ? 1 / WHEEL_ZOOM_FACTOR : WHEEL_ZOOM_FACTOR;
      zoomAtPoint(zoom * factor, pointer.x, pointer.y);
    },
    [zoom, zoomAtPoint]
  );

  // 切换图片时回到适配视图，避免沿用上一张的缩放/平移。
  useEffect(() => {
    resetZoom();
  }, [image, resetZoom]);

  const canZoomIn = zoom < MAX_ZOOM - 1e-3;
  const canZoomOut = zoom > MIN_ZOOM + 1e-3;
  const canResetZoom = zoom !== 1 || offset.x !== 0 || offset.y !== 0;

  const selectedAnnotation = useMemo(
    () => annotations.find((item) => item.id === selectedId) ?? null,
    [annotations, selectedId]
  );
  const activeStyleKind = useMemo<'shape' | 'text' | null>(() => {
    if (handTool) {
      return null;
    }
    if (tool === 'text') {
      return 'text';
    }
    if (tool === 'rect' || tool === 'ellipse' || tool === 'arrow' || tool === 'pen') {
      return 'shape';
    }
    return null;
  }, [handTool, tool]);

  const updateOptionsPayload = useCallback(
    (nextAnnotations: AnnotationItem[], nextOptionsPatch: Partial<ToolOptions> = {}, saveHistory = false) => {
      if (saveHistory) {
        setUndoStack((prev) => [...prev, annotations].slice(-40));
        setRedoStack([]);
      }
      onOptionsChange({
        ...options,
        ...nextOptionsPatch,
        annotations: stringifyAnnotationItems(nextAnnotations),
      });
      setAnnotations(nextAnnotations);
    },
    [annotations, onOptionsChange, options]
  );

  const getImagePoint = useCallback(() => {
    const stage = stageRef.current;
    const group = contentGroupRef.current;
    if (!stage || !group || !image) {
      return null;
    }

    const pointer = stage.getPointerPosition();
    if (!pointer) {
      return null;
    }

    const transform = group.getAbsoluteTransform().copy();
    transform.invert();
    const imagePoint = transform.point(pointer);
    return {
      x: clamp(imagePoint.x, 0, image.naturalWidth),
      y: clamp(imagePoint.y, 0, image.naturalHeight),
    };
  }, [image]);

  const toHostPoint = useCallback((x: number, y: number) => {
    const group = contentGroupRef.current;
    const stage = stageRef.current;
    const host = stageHostRef.current;

    let stagePoint: { x: number; y: number };
    if (!group) {
      stagePoint = { x: x * scale, y: y * scale };
    } else {
      stagePoint = group.getAbsoluteTransform().point({ x, y });
    }

    if (!stage || !host) {
      return stagePoint;
    }

    const stageRect = stage.container().getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    return {
      x: stagePoint.x + (stageRect.left - hostRect.left),
      y: stagePoint.y + (stageRect.top - hostRect.top),
    };
  }, [scale]);

  const startTextEditing = useCallback((item: AnnotationItem | null, fallbackPoint?: { x: number; y: number }) => {
    const targetItem = item && item.type === 'text' ? item : null;
    const x = targetItem ? targetItem.x : (fallbackPoint?.x ?? 0);
    const y = targetItem ? targetItem.y : (fallbackPoint?.y ?? 0);
    setTextEditorState({
      annotationId: targetItem?.id ?? null,
      x,
      y,
      value: targetItem?.text ?? '',
    });
    setSelectedId(targetItem?.id ?? null);
    requestAnimationFrame(() => {
      textInputRef.current?.focus();
      textInputRef.current?.select();
    });
  }, []);

  const handleCommitTextEditor = useCallback(() => {
    if (!textEditorState) {
      return;
    }

    const value = textEditorState.value.trim();
    if (textEditorState.annotationId) {
      const nextAnnotations = annotations
        .map((item) => {
          if (item.id !== textEditorState.annotationId || item.type !== 'text') {
            return item;
          }
          if (!value) {
            return null;
          }
          return {
            ...item,
            text: value,
            color,
            fontSize,
          };
        })
        .filter((item): item is AnnotationItem => Boolean(item));
      updateOptionsPayload(nextAnnotations, {}, true);
      setTextEditorState(null);
      return;
    }

    if (!value) {
      setTextEditorState(null);
      return;
    }

    const nextItem: AnnotationItem = {
      id: createAnnotationId(),
      type: 'text',
      x: textEditorState.x,
      y: textEditorState.y,
      text: value,
      color,
      fontSize,
    };
    const nextAnnotations = [...annotations, nextItem];
    updateOptionsPayload(nextAnnotations, {}, true);
    setSelectedId(nextItem.id);
    setTextEditorState(null);
  }, [annotations, color, fontSize, textEditorState, updateOptionsPayload]);

  const handleCancelTextEditor = useCallback(() => {
    setTextEditorState(null);
  }, []);

  const buildDraftAnnotation = useCallback(
    (currentX: number, currentY: number): AnnotationItem | null => {
      if (!draft) {
        return null;
      }

      if (draft.tool === 'pen') {
        const points = [...(draft.points ?? [draft.startX, draft.startY]), currentX, currentY];
        return {
          id: 'draft-pen',
          type: 'pen',
          points,
          stroke: color,
          lineWidth,
        };
      }

      if (draft.tool === 'arrow') {
        return {
          id: 'draft-arrow',
          type: 'arrow',
          points: [draft.startX, draft.startY, currentX, currentY],
          stroke: color,
          lineWidth,
        };
      }

      const rect = normalizeAnnotationRect(draft.startX, draft.startY, currentX, currentY);

      if (draft.tool === 'rect') {
        return {
          id: 'draft-rect',
          type: 'rect',
          ...rect,
          stroke: color,
          lineWidth,
        };
      }

      return {
        id: 'draft-ellipse',
        type: 'ellipse',
        ...rect,
        stroke: color,
        lineWidth,
      };
    },
    [color, draft, lineWidth]
  );

  const draftAnnotation = useMemo(() => {
    if (!draft) {
      return null;
    }
    if (draft.tool === 'pen') {
      return {
        id: 'draft-pen',
        type: 'pen',
        points: draft.points ?? [draft.startX, draft.startY],
        stroke: color,
        lineWidth,
      } as AnnotationItem;
    }
    return buildDraftAnnotation(draft.currentX, draft.currentY);
  }, [buildDraftAnnotation, color, draft, lineWidth]);

  const handlePointerDown = useCallback((event: KonvaEventObject<MouseEvent | TouchEvent>) => {
    stageHostRef.current?.focus();

    // 抓手平移：选中「移动」工具 / 按住空格 / 中键拖动，不进入绘制流程。
    const middleButton = 'button' in event.evt && event.evt.button === 1;
    if (handTool || spaceDown || middleButton) {
      const pointer = stageRef.current?.getPointerPosition();
      if (pointer) {
        panStartRef.current = { px: pointer.x, py: pointer.y, ox: appliedOffset.x, oy: appliedOffset.y };
        isPanningRef.current = true;
      }
      return;
    }

    const point = getImagePoint();
    if (!point) {
      return;
    }

    const target = event.target;
    const isBackgroundTarget = target === target.getStage() || target.name() === 'annotation-background';
    if (!isBackgroundTarget) {
      return;
    }

    if (tool === 'text') {
      startTextEditing(null, point);
      return;
    }

    setTextEditorState(null);
    setSelectedId(null);
    setDraft({
      tool: tool as Exclude<AnnotationToolType, 'text'>,
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
      points: tool === 'pen' ? [point.x, point.y] : undefined,
    });
  }, [appliedOffset.x, appliedOffset.y, getImagePoint, handTool, spaceDown, startTextEditing, tool]);

  const handlePointerMove = useCallback(() => {
    if (isPanningRef.current && panStartRef.current) {
      const pointer = stageRef.current?.getPointerPosition();
      if (pointer) {
        const start = panStartRef.current;
        setOffset(clampOffset({ x: start.ox + (pointer.x - start.px), y: start.oy + (pointer.y - start.py) }, zoom));
      }
      return;
    }

    if (!draft) {
      return;
    }

    const point = getImagePoint();
    if (!point) {
      return;
    }

    if (draft.tool === 'pen') {
      setDraft((previous) => {
        if (!previous || previous.tool !== 'pen') {
          return previous;
        }
        return {
          ...previous,
          currentX: point.x,
          currentY: point.y,
          points: [...(previous.points ?? [previous.startX, previous.startY]), point.x, point.y],
        };
      });
      return;
    }

    setDraft((previous) =>
      previous
        ? {
          ...previous,
          currentX: point.x,
          currentY: point.y,
        }
        : previous
    );
  }, [clampOffset, draft, getImagePoint, zoom]);

  const handlePointerUp = useCallback(() => {
    if (isPanningRef.current) {
      isPanningRef.current = false;
      panStartRef.current = null;
      return;
    }

    if (!draft) {
      return;
    }

    const point = getImagePoint();
    const finalX = point?.x ?? draft.currentX;
    const finalY = point?.y ?? draft.currentY;
    const nextItem = buildDraftAnnotation(finalX, finalY);
    if (!nextItem) {
      setDraft(null);
      return;
    }

    if (
      (nextItem.type === 'rect' || nextItem.type === 'ellipse')
      && (nextItem.width < 4 || nextItem.height < 4)
    ) {
      setDraft(null);
      return;
    }

    if (nextItem.type === 'arrow') {
      const [x1, y1, x2, y2] = nextItem.points;
      if (Math.hypot(x2 - x1, y2 - y1) < 4) {
        setDraft(null);
        return;
      }
    }

    if (nextItem.type === 'pen' && nextItem.points.length < 6) {
      setDraft(null);
      return;
    }

    const createdItem = { ...nextItem, id: createAnnotationId() } as AnnotationItem;
    const nextAnnotations = [...annotations, createdItem];
    updateOptionsPayload(nextAnnotations, {}, true);
    setSelectedId(createdItem.id);
    setDraft(null);
  }, [annotations, buildDraftAnnotation, draft, getImagePoint, updateOptionsPayload]);

  const handleDeleteSelected = useCallback(() => {
    if (!selectedId) {
      return;
    }
    const nextAnnotations = annotations.filter((item) => item.id !== selectedId);
    updateOptionsPayload(nextAnnotations, {}, true);
    setSelectedId(null);
  }, [annotations, selectedId, updateOptionsPayload]);

  const handleUndo = useCallback(() => {
    if (undoStack.length === 0) {
      return;
    }
    const previous = undoStack[undoStack.length - 1];
    setRedoStack((prev) => [...prev, annotations].slice(-40));
    setUndoStack((prev) => prev.slice(0, -1));
    onOptionsChange({
      ...options,
      annotations: stringifyAnnotationItems(previous),
    });
    setAnnotations(previous);
  }, [annotations, onOptionsChange, options, undoStack]);

  const handleRedo = useCallback(() => {
    if (redoStack.length === 0) {
      return;
    }
    const next = redoStack[redoStack.length - 1];
    setUndoStack((prev) => [...prev, annotations].slice(-40));
    setRedoStack((prev) => prev.slice(0, -1));
    onOptionsChange({
      ...options,
      annotations: stringifyAnnotationItems(next),
    });
    setAnnotations(next);
  }, [annotations, onOptionsChange, options, redoStack]);

  const handleStyleInputChange = useCallback((patch: Partial<ToolOptions>) => {
    const safePatch = pruneUndefinedToolOptionsPatch(patch);
    const nextOptions = { ...options, ...safePatch } as ToolOptions;
    onOptionsChange(nextOptions);

    if (!selectedAnnotation) {
      return;
    }

    const nextAnnotations = annotations.map((item) => {
      if (item.id !== selectedAnnotation.id) {
        return item;
      }

      if (item.type === 'text') {
        const nextTextPercent = clamp(
          toNumber(nextOptions.fontSizePercent, fontSizeToPercent(item.fontSize, textBaseSize)),
          MIN_TEXT_SIZE_PERCENT,
          MAX_TEXT_SIZE_PERCENT
        );
        return {
          ...item,
          color: toText(nextOptions.color, item.color),
          fontSize: percentToFontSize(nextTextPercent, textBaseSize),
        };
      }

      return {
        ...item,
        stroke: toText(nextOptions.color, item.stroke),
        lineWidth: percentToLineWidth(
          clamp(
            toNumber(nextOptions.lineWidthPercent, lineWidthToPercent(item.lineWidth, textBaseSize)),
            MIN_LINE_WIDTH_PERCENT,
            MAX_LINE_WIDTH_PERCENT
          ),
          textBaseSize
        ),
      };
    });
    updateOptionsPayload(nextAnnotations, safePatch, true);
  }, [annotations, onOptionsChange, options, selectedAnnotation, textBaseSize, updateOptionsPayload]);

  const handleStageKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (textEditorState) {
      return;
    }

    if (event.code === 'Space' || event.key === ' ') {
      // 按住空格 = 临时抓手平移；preventDefault 阻止页面滚动。
      event.preventDefault();
      setSpaceDown(true);
      return;
    }

    const key = event.key.toLowerCase();
    const command = event.ctrlKey || event.metaKey;

    if (command && key === 'z' && !event.shiftKey) {
      event.preventDefault();
      handleUndo();
      return;
    }

    if (command && (key === 'y' || (key === 'z' && event.shiftKey))) {
      event.preventDefault();
      handleRedo();
      return;
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      handleDeleteSelected();
    }
  }, [handleDeleteSelected, handleRedo, handleUndo, textEditorState]);

  const handleStageKeyUp = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.code === 'Space' || event.key === ' ') {
      setSpaceDown(false);
      isPanningRef.current = false;
      panStartRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!selectedAnnotation || textEditorState) {
      return;
    }

    let patch: Partial<ToolOptions> = {};
    if (selectedAnnotation.type === 'text') {
      patch = {
        color: selectedAnnotation.color,
        fontSizePercent: clamp(
          fontSizeToPercent(selectedAnnotation.fontSize, textBaseSize),
          MIN_TEXT_SIZE_PERCENT,
          MAX_TEXT_SIZE_PERCENT
        ),
      };
    } else {
      patch = {
        color: selectedAnnotation.stroke,
        lineWidthPercent: clamp(
          lineWidthToPercent(selectedAnnotation.lineWidth, textBaseSize),
          MIN_LINE_WIDTH_PERCENT,
          MAX_LINE_WIDTH_PERCENT
        ),
      };
    }

    const safePatch = pruneUndefinedToolOptionsPatch(patch);
    const hasChange = Object.entries(safePatch).some(
      ([key, value]) => !Object.is(options[key], value)
    );
    if (!hasChange) {
      return;
    }

    const nextOptions = {
      ...options,
      ...safePatch,
    } as ToolOptions;
    onOptionsChange(nextOptions);
  }, [onOptionsChange, options, selectedAnnotation, textBaseSize, textEditorState]);

  useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) {
      return;
    }
    if (!selectedId) {
      transformer.nodes([]);
      transformer.getLayer()?.batchDraw();
      return;
    }

    const selectedNode = shapeRefs.current.get(selectedId);
    if (!selectedNode || !selectedAnnotation || !canTransformAnnotation(selectedAnnotation)) {
      transformer.nodes([]);
      transformer.getLayer()?.batchDraw();
      return;
    }
    transformer.nodes([selectedNode]);
    transformer.getLayer()?.batchDraw();
  }, [selectedAnnotation, selectedId]);

  const bindShapeRef = useCallback((id: string, node: Konva.Node | null) => {
    if (node) {
      shapeRefs.current.set(id, node);
      return;
    }
    shapeRefs.current.delete(id);
  }, []);

  const handleAnnotationDragEnd = useCallback((item: AnnotationItem, event: KonvaEventObject<DragEvent>) => {
    const node = event.target;
    const nextX = node.x();
    const nextY = node.y();
    if (item.type === 'arrow' || item.type === 'pen') {
      node.x(0);
      node.y(0);
    }
    const nextAnnotations = annotations.map((current) =>
      current.id === item.id
        ? updateAnnotationPosition(current, nextX, nextY)
        : current
    );
    updateOptionsPayload(nextAnnotations, {}, true);
  }, [annotations, updateOptionsPayload]);

  const handleAnnotationTransformEnd = useCallback((item: AnnotationItem, event: KonvaEventObject<Event>) => {
    const node = event.target;
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    const nextX = node.x();
    const nextY = node.y();
    node.scaleX(1);
    node.scaleY(1);
    if (item.type === 'arrow' || item.type === 'pen') {
      node.x(0);
      node.y(0);
    }

    const nextAnnotations = annotations.map((current) =>
      current.id === item.id
        ? updateAnnotationTransform(current, nextX, nextY, scaleX, scaleY)
        : current
    );
    updateOptionsPayload(nextAnnotations, {}, true);
  }, [annotations, updateOptionsPayload]);

  const renderAnnotationNode = useCallback((item: AnnotationItem, opacity = 1) => {
    const isSelected = selectedId === item.id;
    const canInteract = canSelectByTool(tool, item);
    const draggable = canInteract && isSelected;

    const commonHandlers = {
      draggable,
      onClick: () => {
        if (canInteract) {
          setSelectedId(item.id);
        }
      },
      onTap: () => {
        if (canInteract) {
          setSelectedId(item.id);
        }
      },
      onDragEnd: (event: KonvaEventObject<DragEvent>) => handleAnnotationDragEnd(item, event),
      onTransformEnd: (event: KonvaEventObject<Event>) => handleAnnotationTransformEnd(item, event),
    };

    if (item.type === 'rect') {
      return (
        <Rect
          key={item.id}
          ref={(node) => bindShapeRef(item.id, node)}
          x={item.x}
          y={item.y}
          width={item.width}
          height={item.height}
          stroke={item.stroke}
          strokeWidth={item.lineWidth}
          opacity={opacity}
          strokeScaleEnabled={false}
          {...commonHandlers}
        />
      );
    }

    if (item.type === 'ellipse') {
      return (
        <Ellipse
          key={item.id}
          ref={(node) => bindShapeRef(item.id, node)}
          x={item.x + item.width / 2}
          y={item.y + item.height / 2}
          radiusX={item.width / 2}
          radiusY={item.height / 2}
          stroke={item.stroke}
          strokeWidth={item.lineWidth}
          opacity={opacity}
          strokeScaleEnabled={false}
          {...commonHandlers}
        />
      );
    }

    if (item.type === 'arrow') {
      return (
        <Arrow
          key={item.id}
          ref={(node) => bindShapeRef(item.id, node)}
          points={item.points}
          stroke={item.stroke}
          fill={item.stroke}
          strokeWidth={item.lineWidth}
          pointerLength={Math.max(10, item.lineWidth * 4)}
          pointerWidth={Math.max(10, item.lineWidth * 3)}
          opacity={opacity}
          strokeScaleEnabled={false}
          {...commonHandlers}
        />
      );
    }

    if (item.type === 'pen') {
      return (
        <Line
          key={item.id}
          ref={(node) => bindShapeRef(item.id, node)}
          points={item.points}
          stroke={item.stroke}
          strokeWidth={item.lineWidth}
          lineJoin="round"
          lineCap="round"
          opacity={opacity}
          strokeScaleEnabled={false}
          {...commonHandlers}
        />
      );
    }

    return (
      <Text
        key={item.id}
        ref={(node) => bindShapeRef(item.id, node)}
        x={item.x}
        y={item.y}
        text={item.text}
        fill={item.color}
        fontStyle="bold"
        fontSize={item.fontSize}
        lineHeight={1.2}
        opacity={opacity}
        {...commonHandlers}
        onDblClick={(event) => {
          event.cancelBubble = true;
          startTextEditing(item);
        }}
      />
    );
  }, [
    bindShapeRef,
    handleAnnotationDragEnd,
    handleAnnotationTransformEnd,
    selectedId,
    startTextEditing,
    tool,
  ]);

  const textEditorStagePos = useMemo(() => {
    if (!textEditorState) {
      return null;
    }
    return toHostPoint(textEditorState.x, textEditorState.y);
  }, [textEditorState, toHostPoint]);

  const transformerKeepRatio = selectedAnnotation?.type === 'text';
  const transformerAnchors: Konva.TransformerConfig['enabledAnchors'] = transformerKeepRatio
    ? ['top-left', 'top-right', 'bottom-left', 'bottom-right']
    : [
      'top-left',
      'top-center',
      'top-right',
      'middle-right',
      'bottom-right',
      'bottom-center',
      'bottom-left',
      'middle-left',
    ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex items-center gap-2.5">
          {TOOL_BUTTONS.map((button) => {
            const Icon = button.icon;
            const active = !handTool && tool === button.type;
            return (
              <button
                key={button.type}
                type="button"
                onClick={() => {
                  setHandTool(false);
                  setTool(button.type);
                  if (button.type !== 'text') {
                    setTextEditorState(null);
                  }
                }}
                className={`${ANNOTATE_TOOL_BUTTON_BASE_CLASS} ${
                  active
                    ? 'text-text-dark'
                    : 'text-text-muted/82 hover:text-text-dark/95'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {t(button.labelKey)}
              </button>
            );
          })}
          <button
            type="button"
            title={t('canvas.annotateEditor.panHint')}
            onClick={() => {
              setHandTool(true);
              setTextEditorState(null);
              setSelectedId(null);
            }}
            className={`${ANNOTATE_TOOL_BUTTON_BASE_CLASS} ${
              handTool ? 'text-text-dark' : 'text-text-muted/82 hover:text-text-dark/95'
            }`}
          >
            <Hand className="h-3.5 w-3.5" />
            {t('canvas.annotateEditor.pan')}
          </button>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            title={t('canvas.zoom.zoomOut')}
            aria-label={t('canvas.zoom.zoomOut')}
            className={`${ANNOTATE_TOOL_BUTTON_BASE_CLASS} text-text-muted/82 hover:text-text-dark/95`}
            onClick={() => zoomByStep(1 / ZOOM_BUTTON_STEP)}
            disabled={!canZoomOut}
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <span className="w-10 text-center text-[12px] tabular-nums text-text-muted/82">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            title={t('canvas.zoom.zoomIn')}
            aria-label={t('canvas.zoom.zoomIn')}
            className={`${ANNOTATE_TOOL_BUTTON_BASE_CLASS} text-text-muted/82 hover:text-text-dark/95`}
            onClick={() => zoomByStep(ZOOM_BUTTON_STEP)}
            disabled={!canZoomIn}
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            title={t('canvas.annotateEditor.fitWindow')}
            aria-label={t('canvas.annotateEditor.fitWindow')}
            className={`${ANNOTATE_TOOL_BUTTON_BASE_CLASS} text-text-muted/82 hover:text-text-dark/95`}
            onClick={resetZoom}
            disabled={!canResetZoom}
          >
            <Maximize className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {activeStyleKind && (
            <div className="flex items-center gap-2">
              <label className="relative inline-flex h-7 cursor-pointer items-center gap-1.5 overflow-hidden rounded-[9px] border border-white/[0.18] px-2.5 text-[12px] font-medium text-text-dark/88 transition-colors hover:border-white/28 hover:text-text-dark">
                <span
                  className="h-4 w-4 rounded-[4px] border border-white/30"
                  style={{ backgroundColor: color }}
                  aria-hidden="true"
                />
                <span>{t('canvas.annotateEditor.color')}</span>
                <input
                  type="color"
                  value={color}
                  onChange={(event) => handleStyleInputChange({ color: event.target.value })}
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                />
              </label>
              {activeStyleKind === 'shape' && (
                <>
                  <input
                    type="range"
                    min={MIN_LINE_WIDTH_PERCENT}
                    max={MAX_LINE_WIDTH_PERCENT}
                    step={0.1}
                    value={Number(lineWidthPercent.toFixed(1))}
                    onChange={(event) => handleStyleInputChange({ lineWidthPercent: Number(event.target.value) })}
                    className={ANNOTATE_RANGE_CLASS}
                  />
                  <span className="w-9 text-[12px] text-text-muted/78">{lineWidthPercent.toFixed(1)}%</span>
                </>
              )}
              {activeStyleKind === 'text' && (
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min={MIN_TEXT_SIZE_PERCENT}
                    max={MAX_TEXT_SIZE_PERCENT}
                    step={0.5}
                    value={Number(textSizePercent.toFixed(1))}
                    onChange={(event) =>
                      handleStyleInputChange({ fontSizePercent: Number(event.target.value) })
                    }
                    className="h-7 w-20 rounded-[9px] border border-[rgba(255,255,255,0.14)] bg-bg-dark/80 px-2 text-[12px] text-text-dark outline-none"
                  />
                  <span className="text-[12px] text-text-muted/78">%</span>
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            className={annotateActionButtonClass(canUndo)}
            onClick={handleUndo}
            disabled={!canUndo}
          >
            <Undo2 className="h-3.5 w-3.5" />
            {t('canvas.paintTools.undoShort')}
          </button>
          <button
            type="button"
            className={annotateActionButtonClass(canRedo)}
            onClick={handleRedo}
            disabled={!canRedo}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7v6h6" />
              <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
            </svg>
            {t('canvas.paintTools.redoShort')}
          </button>
          <button
            type="button"
            className={annotateActionButtonClass(canDeleteSelected)}
            onClick={handleDeleteSelected}
            disabled={!canDeleteSelected}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('viewer.threeD.deleteSelected')}
          </button>
          <button
            type="button"
            className={annotateActionButtonClass(canClear)}
            onClick={() => {
              setUndoStack((prev) => [...prev, annotations].slice(-40));
              setRedoStack([]);
              setSelectedId(null);
              updateOptionsPayload([], {}, false);
            }}
            disabled={!canClear}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('canvas.annotateEditor.clear')}
          </button>
        </div>
      </div>

      <div
        ref={viewportRef}
        className="relative h-[min(46vh,480px)] overflow-hidden rounded-[10px] border border-white/[0.10] bg-[#111214]/80"
      >
        <div
          ref={stageHostRef}
          tabIndex={0}
          className="relative flex h-full w-full items-center justify-center p-2 outline-none"
          onKeyDown={handleStageKeyDown}
          onKeyUp={handleStageKeyUp}
        >
          <Stage
            ref={stageRef}
            width={stageWidth}
            height={stageHeight}
            onMouseDown={handlePointerDown}
            onTouchStart={handlePointerDown}
            onMouseMove={handlePointerMove}
            onTouchMove={handlePointerMove}
            onMouseUp={handlePointerUp}
            onTouchEnd={handlePointerUp}
            onMouseLeave={handlePointerUp}
            onWheel={handleWheelZoom}
            className={
              isPanningRef.current
                ? 'cursor-grabbing'
                : handTool || spaceDown
                  ? 'cursor-grab'
                  : tool === 'text'
                    ? 'cursor-text'
                    : 'cursor-crosshair'
            }
          >
            <Layer>
              <Group
                ref={contentGroupRef}
                x={appliedOffset.x}
                y={appliedOffset.y}
                scaleX={scale * zoom}
                scaleY={scale * zoom}
              >
                {image && (
                  <KonvaImage
                    image={image}
                    x={0}
                    y={0}
                    width={image.naturalWidth}
                    height={image.naturalHeight}
                    name="annotation-background"
                  />
                )}
                {annotations.map((item) => renderAnnotationNode(item))}
                {draftAnnotation && renderAnnotationNode(draftAnnotation, 0.75)}
                <Transformer
                  ref={transformerRef}
                  boundBoxFunc={(oldBox, newBox) => {
                    if (newBox.width < 5 || newBox.height < 5) {
                      return oldBox;
                    }
                    return newBox;
                  }}
                  rotateEnabled={false}
                  borderStroke="#3b82f6"
                  anchorStroke="#3b82f6"
                  anchorFill="#ffffff"
                  anchorSize={8}
                  ignoreStroke
                  keepRatio={transformerKeepRatio}
                  enabledAnchors={transformerAnchors}
                />
              </Group>
            </Layer>
          </Stage>

          {textEditorState && textEditorStagePos && (
            <div
              className="absolute z-20 flex flex-col gap-2 rounded-md border border-[rgba(255,255,255,0.2)] bg-black/75 p-2 backdrop-blur-sm"
              style={{
                left: `${textEditorStagePos.x}px`,
                top: `${textEditorStagePos.y}px`,
                transform: 'translate(0, -100%)',
                minWidth: '180px',
                maxWidth: '300px',
              }}
            >
              <textarea
                ref={textInputRef}
                value={textEditorState.value}
                onChange={(event) =>
                  setTextEditorState((previous) =>
                    previous
                      ? {
                        ...previous,
                        value: event.target.value,
                      }
                      : previous
                  )
                }
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                    event.preventDefault();
                    handleCommitTextEditor();
                    return;
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    handleCancelTextEditor();
                  }
                }}
                rows={3}
                className="w-full resize-none rounded border border-[rgba(255,255,255,0.18)] bg-bg-dark/90 px-2 py-1.5 text-sm text-text-dark outline-none focus:border-accent"
              />
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  className="rounded border border-[rgba(255,255,255,0.22)] px-2 py-1 text-xs text-text-muted hover:bg-bg-dark"
                  onClick={handleCancelTextEditor}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  className="rounded border border-accent/45 bg-accent/20 px-2 py-1 text-xs text-text-dark hover:bg-accent/30"
                  onClick={handleCommitTextEditor}
                >
                  {t('common.confirm')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
