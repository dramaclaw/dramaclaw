// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  memo,
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
} from 'react';
import { createPortal } from 'react-dom';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import {
  Handle,
  Position,
  useStore,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import { Download, FolderOpen, ImagePlus, SlidersHorizontal, SquareArrowOutUpRight } from 'lucide-react';

import {
  embedStoryboardImageMetadata,
  mergeStoryboardImages,
  saveImageSourceToDirectory,
  type MergeStoryboardImagesResult,
} from '@/commands/image';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { CanvasNodeImage } from '@/features/canvas/ui/CanvasNodeImage';
import type {
  StoryboardExportOptions,
  StoryboardFrameItem,
  StoryboardSplitNodeData,
} from '@/features/canvas/domain/canvasNodes';
import {
  CANVAS_NODE_TYPES,
  isExportImageNode,
  isImageEditNode,
  isUploadNode,
} from '@/features/canvas/domain/canvasNodes';
import { EXPORT_RESULT_DISPLAY_NAME, localizeNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import {
  canvasToDataUrl,
  loadImageElement,
  prepareNodeImage,
  persistImageLocally,
  reduceAspectRatio,
  resolveImageDisplayUrl,
  shouldUseOriginalImageByZoom,
} from '@/features/canvas/application/imageData';
import { uploadLocalImageToBackend } from '@/features/canvas/application/uploadToolOutput';
import { useUpstreamNodes } from '@/features/canvas/application/useUpstreamGraph';
import { UiButton, UiCheckbox, UiChipButton, UiInput, UiPanel, UiSelect } from '@/components/ui';
import {
  NODE_CONTROL_CHIP_CLASS,
  NODE_CONTROL_ICON_CLASS,
  NODE_CONTROL_PRIMARY_BUTTON_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import { CANVAS_NODE_PANEL_SURFACE_CLASS, canvasNodeFrameClass } from '@/features/canvas/ui/nodeFrameStyles';
import { useCanvasStore } from '@/stores/canvasStore';
import { readUrl } from '@/lib/url-params';

type StoryboardNodeProps = NodeProps & {
  id: string;
  data: StoryboardSplitNodeData;
  selected?: boolean;
};

const STORYBOARD_NODE_WIDTH_PX = 440;
const STORYBOARD_NODE_MIN_HEIGHT_PX = 320;
const STORYBOARD_SPLIT_FRAME_TARGET_WIDTH = 150;
const STORYBOARD_SPLIT_FRAME_NOTE_HEIGHT = 40;
const STORYBOARD_SPLIT_NODE_CHROME_HEIGHT = 70;
const STORYBOARD_GRID_GAP_PX = 1;
const EXPORT_MAX_DIMENSION = 4096;
const EXPORT_TRACE_PREFIX = '[StoryboardExport]';
const STORYBOARD_SPLIT_HEADER_ADJUST = { x: 0, y: 0, scale: 1 };
const STORYBOARD_SPLIT_ICON_ADJUST = { x: 0, y: 0, scale: 1 };
const STORYBOARD_SPLIT_TITLE_ADJUST = { x: 0, y: 0, scale: 1 };
const STORYBOARD_EXPORT_PANEL_CLASS =
  '!border-white/[0.18] !bg-[#191b20]/92 shadow-[0_10px_28px_rgba(0,0,0,0.34)]';
const STORYBOARD_EXPORT_FIELD_CLASS =
  '!rounded-[6px] !border-white/[0.18] focus:!border-accent hover:!border-white/[0.28]';
const STORYBOARD_EXPORT_CHECKBOX_CLASS =
  '!h-6 !w-6 !rounded-[6px] !border-white/[0.30] aria-checked:!border-white/58 aria-checked:!bg-white/[0.07] aria-checked:!text-white shadow-[0_0_0_1px_rgba(255,255,255,0.035)]';
const STORYBOARD_EXPORT_TRIGGER_CLASS =
  '!h-7 !rounded-md !border !px-2.5 !text-[12px]';
const STORYBOARD_EXPORT_TRIGGER_INACTIVE_CLASS =
  '!border-transparent !bg-transparent !text-text-dark/86 hover:!bg-white/[0.055] hover:!text-white';
const STORYBOARD_EXPORT_TRIGGER_ACTIVE_CLASS =
  '!border-accent/36 !bg-accent/14 !text-white shadow-[0_0_0_1px_rgba(var(--accent-rgb),0.08)]';
const STORYBOARD_EXPORT_BUTTON_CLASS =
  '!h-6 !rounded-md !border-white/[0.12] !bg-white/[0.045] !px-2.5 !text-[11px] !text-text-dark/90 hover:!border-white/[0.22] hover:!bg-white/[0.08] hover:!text-white';
const STORYBOARD_EXPORT_PRIMARY_BUTTON_CLASS =
  '!h-7 !rounded-md !border-transparent !bg-transparent !px-1.5 !text-[12px] !text-text-dark/92 hover:!bg-transparent hover:!text-white';

function SplitResultIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M10 0c1.66 0 3 1.34 3 3v3l2.4-1.5a3.003 3.003 0 0 1 3 5.2a3.003 3.003 0 0 1-4.452-2.051l-.952.55v6.8h-2v-5.65l-4.01 2.32l-.988-1.73l5-2.94v-1.17a2.996 2.996 0 0 1-4-2.829c0-1.66 1.34-3 3-3zM9 3a1 1 0 0 0 2 0a1 1 0 0 0-2 0m7 4a1 1 0 0 0 2 0a1 1 0 0 0-2 0M2.97 19h2v-2h-2V9h3V7h-3c-1.1 0-2 .895-2 2v8c0 1.1.895 2 2 2m6 0h-2v-2h2zm4-2c0 1.1-.895 2-2 2v-2z" />
    </svg>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sanitizePathSegment(raw: string, fallback: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }

  const sanitized = Array.from(trimmed)
    .filter((ch) => !/[<>:"/\\|?*]/.test(ch) && ch >= ' ')
    .join('')
    .trim()
    .replace(/\.+$/g, '');

  return sanitized || fallback;
}

function sanitizeExportLabel(raw: string, maxLength = 50): string {
  const compact = sanitizePathSegment(raw, '').replace(/\s+/g, ' ').trim();
  if (!compact) {
    return '';
  }
  return compact.slice(0, maxLength);
}

function toCssAspectRatio(aspectRatio: string): string {
  const [rawWidth = '1', rawHeight = '1'] = aspectRatio.split(':');
  const width = Number(rawWidth);
  const height = Number(rawHeight);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return '1 / 1';
  }

  return `${width} / ${height}`;
}

function parseAspectRatioValue(aspectRatio: string): number {
  const [rawWidth = '1', rawHeight = '1'] = aspectRatio.split(':');
  const width = Number(rawWidth);
  const height = Number(rawHeight);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 1;
  }

  return width / height;
}

function resolveStoryboardSplitDefaultSize(
  rows: number,
  cols: number,
  frameAspectRatio: string
): { width: number; height: number } {
  const safeRows = Math.max(1, Math.floor(rows));
  const safeCols = Math.max(1, Math.floor(cols));
  const width = Math.round(Math.max(
    STORYBOARD_NODE_WIDTH_PX,
    safeCols * STORYBOARD_SPLIT_FRAME_TARGET_WIDTH + (safeCols - 1) * STORYBOARD_GRID_GAP_PX + 16
  ));
  const contentWidth = Math.max(1, width - 16);
  const frameWidth = Math.max(
    1,
    (contentWidth - (safeCols - 1) * STORYBOARD_GRID_GAP_PX) / safeCols
  );
  const frameImageHeight = frameWidth / parseAspectRatioValue(frameAspectRatio);
  const frameHeight = frameImageHeight + STORYBOARD_SPLIT_FRAME_NOTE_HEIGHT;
  const gridHeight = safeRows * frameHeight + (safeRows - 1) * STORYBOARD_GRID_GAP_PX;
  const height = Math.round(Math.max(
    STORYBOARD_NODE_MIN_HEIGHT_PX,
    Math.min(1600, gridHeight + STORYBOARD_SPLIT_NODE_CHROME_HEIGHT)
  ));

  return { width, height };
}

function createDefaultExportOptions(): StoryboardExportOptions {
  return {
    showFrameIndex: false,
    showFrameNote: false,
    notePlacement: 'overlay',
    imageFit: 'cover',
    frameIndexPrefix: 'S',
    cellGap: 8,
    outerPadding: 0,
    fontSize: 4,
    backgroundColor: '#0f1115',
    textColor: '#f8fafc',
  };
}

function resolveExportOptions(options: StoryboardSplitNodeData['exportOptions']): StoryboardExportOptions {
  const merged = {
    ...createDefaultExportOptions(),
    ...(options ?? {}),
  };

  const rawFontSize = Number.isFinite(merged.fontSize) ? merged.fontSize : 4;
  const normalizedFontPercent = rawFontSize > 20
    ? Math.round(rawFontSize / 6)
    : rawFontSize;

  return {
    ...merged,
    fontSize: clamp(Math.round(normalizedFontPercent), 1, 20),
  };
}

function trimTextToWidth(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string {
  const safeText = text.trim();
  if (!safeText) {
    return '';
  }

  if (context.measureText(safeText).width <= maxWidth) {
    return safeText;
  }

  let content = safeText;
  while (content.length > 1) {
    content = content.slice(0, -1);
    const withEllipsis = `${content}...`;
    if (context.measureText(withEllipsis).width <= maxWidth) {
      return withEllipsis;
    }
  }

  return '...';
}

async function applyStoryboardTextOverlay(
  imageSource: string,
  frames: StoryboardFrameItem[],
  options: StoryboardExportOptions,
  rows: number,
  cols: number,
  layout: MergeStoryboardImagesResult,
  t: TFunction
): Promise<string> {
  if (!options.showFrameIndex && !options.showFrameNote) {
    return imageSource;
  }

  const image = await loadImageElement(imageSource);
  const canvas = document.createElement('canvas');
  canvas.width = layout.canvasWidth;
  canvas.height = layout.canvasHeight;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error(t('node.storyboard.exportCanvasInitFailed'));
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  context.textBaseline = 'middle';
  context.textAlign = 'left';
  context.font = `${Math.max(500, Math.round(layout.fontSize * 1.2))} ${layout.fontSize}px sans-serif`;

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const row = Math.floor(index / Math.max(1, cols));
    const col = index % Math.max(1, cols);
    if (row >= rows) {
      break;
    }

    const x = layout.padding + col * (layout.cellWidth + layout.gap);
    const y = layout.padding + row * (layout.cellHeight + layout.noteHeight + layout.gap);

    if (options.showFrameIndex) {
      const label = `${options.frameIndexPrefix || 'S'}${index + 1}`;
      const badgePaddingX = Math.max(6, Math.round(layout.fontSize * 0.35));
      const badgeHeight = Math.max(18, Math.round(layout.fontSize * 1.15));
      const textWidth = context.measureText(label).width;
      const badgeWidth = Math.round(textWidth + badgePaddingX * 2);

      context.fillStyle = 'rgba(0,0,0,0.65)';
      context.fillRect(x + 6, y + 6, badgeWidth, badgeHeight);
      context.fillStyle = options.textColor;
      context.fillText(label, x + 6 + badgePaddingX, y + 6 + badgeHeight / 2);
    }

    if (options.showFrameNote) {
      const note = trimTextToWidth(
        context,
        frame.note || '',
        Math.max(20, layout.cellWidth - 14)
      );

      if (!note) {
        continue;
      }

      if (options.notePlacement === 'overlay') {
        const overlayHeight = Math.max(18, Math.round(layout.fontSize * 1.35));
        const overlayY = y + layout.cellHeight - overlayHeight;
        context.fillStyle = 'rgba(0, 0, 0, 0.6)';
        context.fillRect(x, overlayY, layout.cellWidth, overlayHeight);
        context.fillStyle = options.textColor;
        context.fillText(note, x + 7, overlayY + overlayHeight / 2);
      } else if (layout.noteHeight > 0) {
        const noteY = y + layout.cellHeight + layout.noteHeight / 2;
        context.fillStyle = options.textColor;
        context.fillText(note, x + 4, noteY);
      }
    }
  }

  return canvasToDataUrl(canvas);
}

interface FrameCardProps {
  nodeId: string;
  frame: StoryboardFrameItem;
  index: number;
  frameAspectRatioCss: string;
  imageFit: StoryboardExportOptions['imageFit'];
  viewerImageList: string[];
  draggedFrameId: string | null;
  dropTargetFrameId: string | null;
  onSortStart: (frameId: string) => void;
  onSortHover: (frameId: string) => void;
  onTogglePicker: (frameId: string, x: number, y: number) => void;
  onEditFrame: (frame: StoryboardFrameItem) => void;
}

interface IncomingImageItem {
  imageUrl: string;
  previewImageUrl: string | null;
  displayUrl: string;
  label: string;
}

const FrameCard = memo(
  ({
    nodeId,
    frame,
    index,
    frameAspectRatioCss,
    imageFit,
    viewerImageList,
    draggedFrameId,
    dropTargetFrameId,
    onSortStart,
    onSortHover,
    onTogglePicker,
    onEditFrame,
  }: FrameCardProps) => {
    const { t } = useTranslation();
    const updateStoryboardFrame = useCanvasStore((state) => state.updateStoryboardFrame);
    // 离散布尔订阅:每个格子原本各订阅一份连续 zoom(N×N 板就有 N² 个),缩放时全部
    // 每帧重渲染。改订阅阈值布尔后,仅在跨过阈值那一帧重渲染。
    const preferOriginalImage = useStore((state) =>
      shouldUseOriginalImageByZoom(state.transform[2])
    );

    const imageSource = useMemo(() => {
      const picked = preferOriginalImage
        ? frame.imageUrl || frame.previewImageUrl
        : frame.previewImageUrl || frame.imageUrl;
      return picked ? resolveImageDisplayUrl(picked) : null;
    }, [frame.imageUrl, frame.previewImageUrl, preferOriginalImage]);
    const viewerSource = useMemo(() => {
      const picked = frame.imageUrl || frame.previewImageUrl;
      return picked ? resolveImageDisplayUrl(picked) : null;
    }, [frame.imageUrl, frame.previewImageUrl]);

    const dragging = draggedFrameId === frame.id;
    const asDropTarget = dropTargetFrameId === frame.id && !dragging;

    return (
      <div
        onPointerEnter={(event) => {
          event.stopPropagation();
          onSortHover(frame.id);
        }}
        onPointerMove={(event) => {
          event.stopPropagation();
          onSortHover(frame.id);
        }}
        onMouseDown={(event) => event.stopPropagation()}
        className={`nodrag relative bg-bg-dark/85 transition-colors ${dragging
          ? 'z-10 opacity-55 ring-1 ring-accent/65'
          : asDropTarget
            ? 'z-10 ring-1 ring-emerald-400/70'
            : ''
          }`}
      >
        <div
          className={`group/frame relative overflow-hidden bg-surface-dark ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
          style={{ aspectRatio: frameAspectRatioCss }}
          onPointerDown={(event) => {
            if (event.button !== 0) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            onSortStart(frame.id);
          }}
        >
          {frame.imageUrl ? (
            <CanvasNodeImage
              src={imageSource ?? ''}
              alt={`Frame ${index + 1}`}
              viewerSourceUrl={viewerSource}
              viewerImageList={viewerImageList}
              className={`h-full w-full ${imageFit === 'contain' ? 'object-contain' : 'object-cover'}`}
              draggable={false}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[11px] text-text-muted">
              {t('node.storyboard.emptyCell')}
            </div>
          )}

          <button
            type="button"
            className="absolute right-1 top-1 rounded bg-black/60 p-1 text-white opacity-0 transition-all duration-150 hover:bg-black/75 group-hover/frame:opacity-100"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onEditFrame(frame);
            }}
            title={t('node.storyboard.editCell')}
          >
            <SquareArrowOutUpRight className="h-3 w-3" />
          </button>

          <button
            type="button"
            className="absolute bottom-1 right-1 rounded bg-black/60 p-1 text-white opacity-0 transition-all duration-150 hover:bg-black/75 group-hover/frame:opacity-100"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onTogglePicker(frame.id, event.clientX, event.clientY);
            }}
            title={t('node.storyboard.replaceFromInput')}
          >
            <ImagePlus className="h-3 w-3" />
          </button>
        </div>

        <textarea
          value={frame.note}
          onChange={(event) => {
            const nextValue = event.target.value;
            updateStoryboardFrame(nodeId, frame.id, {
              note: nextValue,
            });
          }}
          onMouseDown={(event) => event.stopPropagation()}
          onWheelCapture={(event) => event.stopPropagation()}
          placeholder={t('node.storyboard.cellNotePlaceholder', {
            no: String(index + 1).padStart(2, '0'),
          })}
          className="ui-scrollbar nodrag nowheel h-10 w-full resize-none overflow-y-auto border-0 border-t border-[rgba(255,255,255,0.12)] bg-bg-dark/90 px-2 py-1 text-[10px] text-text-dark outline-none focus:border-accent"
        />
      </div>
    );
  }
);

FrameCard.displayName = 'FrameCard';

export const StoryboardNode = memo(({ id, data, selected, width, height }: StoryboardNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const rootRef = useRef<HTMLDivElement>(null);
  const pickerMenuRef = useRef<HTMLDivElement>(null);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  // Subscribe to ONLY one-hop upstream (not the whole nodes array) so unrelated
  // node drags don't re-render this node. See useUpstreamGraph.
  const upstreamNodes = useUpstreamNodes(id);
  const reorderStoryboardFrame = useCanvasStore((state) => state.reorderStoryboardFrame);
  const addDerivedExportNode = useCanvasStore((state) => state.addDerivedExportNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const updateStoryboardFrame = useCanvasStore((state) => state.updateStoryboardFrame);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [draggedFrameId, setDraggedFrameId] = useState<string | null>(null);
  const [dropTargetFrameId, setDropTargetFrameId] = useState<string | null>(null);
  const [pickerState, setPickerState] = useState<{ frameId: string; x: number; y: number } | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [isPackingSingleImages, setIsPackingSingleImages] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [isExportPanelOpen, setIsExportPanelOpen] = useState(false);

  const orderedFrames = useMemo(
    () => [...data.frames].sort((a, b) => a.order - b.order),
    [data.frames]
  );

  const frameAspectRatio = useMemo(() => {
    return (
      data.frameAspectRatio ??
      orderedFrames.find((frame) => typeof frame.aspectRatio === 'string')?.aspectRatio ??
      '1:1'
    );
  }, [data.frameAspectRatio, orderedFrames]);

  const frameAspectRatioCss = useMemo(
    () => toCssAspectRatio(frameAspectRatio),
    [frameAspectRatio]
  );

  const gridCols = Math.max(1, data.gridCols);
  const gridRows = Math.max(1, data.gridRows);
  const totalFrames = orderedFrames.length;
  const defaultSize = useMemo(
    () => resolveStoryboardSplitDefaultSize(gridRows, gridCols, frameAspectRatio),
    [frameAspectRatio, gridCols, gridRows]
  );
  const resolvedNodeWidth = Math.max(STORYBOARD_NODE_WIDTH_PX, Math.round(width ?? defaultSize.width));
  const resolvedNodeHeight = Math.max(
    STORYBOARD_NODE_MIN_HEIGHT_PX,
    Math.round(height ?? defaultSize.height)
  );

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedNodeHeight, resolvedNodeWidth, updateNodeInternals]);

  const resolvedTitle = useMemo(
    () => localizeNodeDisplayName(CANVAS_NODE_TYPES.storyboardSplit, data, t),
    [data, t]
  );

  const exportOptions = useMemo(
    () => resolveExportOptions(data.exportOptions),
    [data.exportOptions]
  );

  const incomingImageRefs = useMemo(() => {
    const dedupedByImageUrl = new Map<string, { imageUrl: string; previewImageUrl: string | null }>();
    for (const sourceNode of upstreamNodes) {
      if (!isUploadNode(sourceNode) && !isImageEditNode(sourceNode) && !isExportImageNode(sourceNode)) {
        continue;
      }
      const imageUrl = sourceNode.data.imageUrl;
      if (!imageUrl) {
        continue;
      }
      if (!dedupedByImageUrl.has(imageUrl)) {
        dedupedByImageUrl.set(imageUrl, {
          imageUrl,
          previewImageUrl: sourceNode.data.previewImageUrl ?? null,
        });
      }
    }

    return Array.from(dedupedByImageUrl.values());
  }, [upstreamNodes]);

  const incomingImageItems = useMemo<IncomingImageItem[]>(
    () =>
      incomingImageRefs.map((item, index) => ({
        imageUrl: item.imageUrl,
        previewImageUrl: item.previewImageUrl,
        displayUrl: resolveImageDisplayUrl(item.previewImageUrl || item.imageUrl),
        label: t('node.storyboard.inputImageLabel', { index: index + 1 }),
      })),
    [incomingImageRefs]
  );
  const frameViewerImageList = useMemo(
    () =>
      orderedFrames
        .map((frame) => {
          const source = frame.imageUrl || frame.previewImageUrl;
          return source ? resolveImageDisplayUrl(source) : null;
        })
        .filter((item): item is string => Boolean(item)),
    [orderedFrames]
  );
  const incomingImageViewerList = useMemo(
    () => incomingImageItems.map((item) => resolveImageDisplayUrl(item.imageUrl)),
    [incomingImageItems]
  );

  useEffect(() => {
    const handleOutsidePointerDown = (event: PointerEvent) => {
      if (!rootRef.current) {
        return;
      }

      const target = event.target as Node;
      const insideRoot = rootRef.current.contains(target);
      const insidePickerMenu = pickerMenuRef.current?.contains(target) ?? false;

      if (!insideRoot && !insidePickerMenu) {
        setPickerState(null);
      }

      if (!insideRoot) {
        setIsExportPanelOpen(false);
      }
    };

    document.addEventListener('pointerdown', handleOutsidePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointerDown, true);
    };
  }, []);

  const patchExportOptions = useCallback(
    (patch: Partial<StoryboardExportOptions>) => {
      updateNodeData(id, {
        exportOptions: {
          ...exportOptions,
          ...patch,
        },
      });
    },
    [exportOptions, id, updateNodeData]
  );

  const handleSortStart = useCallback((frameId: string) => {
    setDraggedFrameId(frameId);
    setDropTargetFrameId(frameId);
    setPickerState(null);
  }, []);

  const handleSortHover = useCallback(
    (frameId: string) => {
      if (!draggedFrameId) {
        return;
      }
      setDropTargetFrameId(frameId);
    },
    [draggedFrameId]
  );

  const finalizeSort = useCallback(() => {
    if (!draggedFrameId) {
      return;
    }

    if (dropTargetFrameId && dropTargetFrameId !== draggedFrameId) {
      reorderStoryboardFrame(id, draggedFrameId, dropTargetFrameId);
    }

    setDraggedFrameId(null);
    setDropTargetFrameId(null);
  }, [draggedFrameId, dropTargetFrameId, id, reorderStoryboardFrame]);

  useEffect(() => {
    if (!draggedFrameId) {
      return;
    }

    const handlePointerUp = () => {
      finalizeSort();
    };

    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';

    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);

    return () => {
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [draggedFrameId, finalizeSort]);

  const handleEditFrame = useCallback(
    async (frame: StoryboardFrameItem) => {
      try {
        const sourceImage = frame.imageUrl ?? frame.previewImageUrl;
        if (!sourceImage) {
          setExportError(t('node.storyboard.noEditableImage'));
          return;
        }
        const frameIndex = orderedFrames.findIndex((item) => item.id === frame.id);
        const frameTitle = frameIndex >= 0
          ? t('node.storyboard.cellTitle', { index: frameIndex + 1 })
          : EXPORT_RESULT_DISPLAY_NAME.storyboardFrameEdit;

        const prepared = await prepareNodeImage(sourceImage);
        // Upload so the edit node's imageUrl is a real backend URL instead of a
        // base64 data URL. previewImageUrl mirrors the uploaded URL so the
        // persisted node never carries the local base64 from prepareNodeImage
        // (which would bloat PUT /default).
        const uploadedUrl = await uploadLocalImageToBackend(
          prepared.imageUrl,
          `storyboard-frame-${id}-${Date.now()}.png`
        );
        const createdNodeId = addDerivedExportNode(
          id,
          uploadedUrl,
          prepared.aspectRatio,
          uploadedUrl,
          {
            defaultTitle: frameTitle,
            resultKind: 'storyboardFrameEdit',
          }
        );

        if (createdNodeId) {
          addEdge(id, createdNodeId);
        }
      } catch (error) {
        setExportError(
          error instanceof Error ? error.message : t('node.storyboard.createEditNodeFailed'),
        );
      }
    },
    [addDerivedExportNode, addEdge, id, orderedFrames]
  );

  const handleExport = useCallback(async () => {
    if (isExporting) {
      return;
    }

    const traceId = `${id}-${Date.now()}`;
    const traceStart = performance.now();
    console.info(`${EXPORT_TRACE_PREFIX} start`, {
      traceId,
      nodeId: id,
      rows: gridRows,
      cols: gridCols,
      frameCount: orderedFrames.length,
    });

    setIsExporting(true);
    setExportError(null);

    try {
      const stageFrameStart = performance.now();
      const frameSources = orderedFrames.map(
        (frame) => frame.imageUrl ?? frame.previewImageUrl ?? ''
      );
      if (frameSources.every((source) => !source)) {
        throw new Error(t('node.storyboard.noExportableImages'));
      }
      console.info(`${EXPORT_TRACE_PREFIX} frame-sources-ready`, {
        traceId,
        elapsedMs: Math.round(performance.now() - stageFrameStart),
        nonEmptyFrames: frameSources.filter((source) => source.length > 0).length,
      });

      const options = exportOptions;
      const rawGap = clamp(Math.round(options.cellGap), 0, 120);
      const rawPadding = 0;
      const fontPercent = clamp(Number.isFinite(options.fontSize) ? options.fontSize : 4, 1, 20);
      const firstFrameSource = frameSources.find((source) => source.length > 0) ?? null;
      let referenceFrameHeight = 1024;
      if (firstFrameSource) {
        const fontProbeStart = performance.now();
        try {
          const referenceImage = await loadImageElement(firstFrameSource);
          referenceFrameHeight = Math.max(
            64,
            referenceImage.naturalHeight || referenceImage.height || referenceFrameHeight
          );
        } catch {
          // Keep fallback size when reference frame cannot be read.
        }
        console.info(`${EXPORT_TRACE_PREFIX} font-reference-resolved`, {
          traceId,
          elapsedMs: Math.round(performance.now() - fontProbeStart),
          referenceFrameHeight,
        });
      }
      const rawFontSize = clamp(
        Math.round(referenceFrameHeight * (fontPercent / 100)),
        10,
        240
      );
      const rawNoteHeight =
        options.showFrameNote && options.notePlacement === 'bottom'
          ? Math.max(Math.round(rawFontSize * 1.7), 24)
          : 0;

      const mergeStart = performance.now();
      const mergeResult = await mergeStoryboardImages({
        frameSources,
        rows: gridRows,
        cols: gridCols,
        cellGap: rawGap,
        outerPadding: rawPadding,
        noteHeight: rawNoteHeight,
        fontSize: rawFontSize,
        backgroundColor: options.backgroundColor,
        maxDimension: EXPORT_MAX_DIMENSION,
        showFrameIndex: options.showFrameIndex,
        showFrameNote: options.showFrameNote,
        notePlacement: options.notePlacement,
        imageFit: options.imageFit,
        frameIndexPrefix: options.frameIndexPrefix,
        textColor: options.textColor,
        frameNotes: orderedFrames.map((frame) => frame.note ?? ''),
      });
      console.info(`${EXPORT_TRACE_PREFIX} merge-done`, {
        traceId,
        elapsedMs: Math.round(performance.now() - mergeStart),
        canvasWidth: mergeResult.canvasWidth,
        canvasHeight: mergeResult.canvasHeight,
        textOverlayApplied: mergeResult.textOverlayApplied,
      });

      const aspectRatio = reduceAspectRatio(mergeResult.canvasWidth, mergeResult.canvasHeight);
      const needsOverlay = (options.showFrameIndex || options.showFrameNote) && !mergeResult.textOverlayApplied;
      let finalImagePath = mergeResult.imagePath;

      if (needsOverlay) {
        const overlayStart = performance.now();
        const mergedBlob = await applyStoryboardTextOverlay(
          mergeResult.imagePath,
          orderedFrames,
          options,
          gridRows,
          gridCols,
          mergeResult,
          t
        );
        console.info(`${EXPORT_TRACE_PREFIX} overlay-done`, {
          traceId,
          elapsedMs: Math.round(performance.now() - overlayStart),
          dataUrlLength: mergedBlob.length,
        });
        const persistStart = performance.now();
        finalImagePath = await persistImageLocally(mergedBlob);
        console.info(`${EXPORT_TRACE_PREFIX} overlay-persisted`, {
          traceId,
          elapsedMs: Math.round(performance.now() - persistStart),
          persistedPath: finalImagePath,
        });
      }

      const metadataStart = performance.now();
      const metadataFrameNotes = orderedFrames.map((frame) => frame.note ?? '');
      const imagePathWithMetadata = await embedStoryboardImageMetadata(finalImagePath, {
        gridRows,
        gridCols,
        frameNotes: metadataFrameNotes,
      }).catch((error) => {
        console.warn('[StoryboardMetadata] embed failed on storyboard export', error);
        return finalImagePath;
      });
      finalImagePath = imagePathWithMetadata;
      console.info(`${EXPORT_TRACE_PREFIX} metadata-embedded`, {
        traceId,
        elapsedMs: Math.round(performance.now() - metadataStart),
        imagePath: finalImagePath,
      });

      // Upload the merged grid (with metadata already embedded) so both image
      // fields are backend URLs. Keeping the local data URL as preview makes
      // drag/history/autosave paths carry a huge base64 string.
      const uploadStart = performance.now();
      const uploadedImageUrl = await uploadLocalImageToBackend(
        finalImagePath,
        `storyboard-export-${id}-${Date.now()}.png`
      );
      console.info(`${EXPORT_TRACE_PREFIX} uploaded`, {
        traceId,
        elapsedMs: Math.round(performance.now() - uploadStart),
        uploaded: uploadedImageUrl !== finalImagePath,
      });

      const createNodeStart = performance.now();
      const createdNodeId = addDerivedExportNode(
        id,
        uploadedImageUrl,
        aspectRatio,
        uploadedImageUrl,
        {
          defaultTitle: EXPORT_RESULT_DISPLAY_NAME.storyboardSplitExport,
          resultKind: 'storyboardSplitExport',
        }
      );
      console.info(`${EXPORT_TRACE_PREFIX} derived-node-created`, {
        traceId,
        elapsedMs: Math.round(performance.now() - createNodeStart),
        createdNodeId,
      });

      if (createdNodeId) {
        addEdge(id, createdNodeId);
      }
      console.info(`${EXPORT_TRACE_PREFIX} done`, {
        traceId,
        totalElapsedMs: Math.round(performance.now() - traceStart),
      });
    } catch (error) {
      console.error(`${EXPORT_TRACE_PREFIX} failed`, {
        traceId,
        elapsedMs: Math.round(performance.now() - traceStart),
        error,
      });
      setExportError(error instanceof Error ? error.message : t('node.storyboard.exportFailed'));
    } finally {
      setIsExporting(false);
    }
  }, [
    addDerivedExportNode,
    addEdge,
    exportOptions,
    gridCols,
    gridRows,
    id,
    isExporting,
    orderedFrames,
  ]);

  const resolvePackRootDir = useCallback(async (): Promise<string | null> => {
    return 'downloads';
  }, []);

  const handlePackSingleImages = useCallback(async () => {
    if (isExporting || isPackingSingleImages) {
      return;
    }

    setExportError(null);
    setIsPackingSingleImages(true);

    try {
      const frameEntries = orderedFrames
        .map((frame, index) => ({
          source: frame.imageUrl ?? frame.previewImageUrl ?? '',
          index,
          note: frame.note ?? '',
        }))
        .filter((item) => item.source.length > 0);

      if (frameEntries.length === 0) {
        throw new Error(t('node.storyboard.cellNoExportableImage'));
      }

      const rootDir = await resolvePackRootDir();
      if (!rootDir) {
        return;
      }

      const normalizedProjectName = sanitizePathSegment(
        readUrl().project ?? '',
        t('node.storyboard.untitledProject'),
      );
      const outputDir = [rootDir, normalizedProjectName].filter(Boolean).join('/');
      const fileProjectName = sanitizeExportLabel(normalizedProjectName, 40) || t('node.storyboard.projectFallback');
      for (const item of frameEntries) {
        const frameNo = String(item.index + 1).padStart(2, '0');
        const noteLabel = sanitizeExportLabel(item.note, 60);
        const fileStem = noteLabel
          ? `${fileProjectName}_${frameNo}_${noteLabel}`
          : `${fileProjectName}_${frameNo}`;
        await saveImageSourceToDirectory(item.source, outputDir, fileStem);
      }

    } catch (error) {
      setExportError(error instanceof Error ? error.message : t('node.storyboard.packFailed'));
    } finally {
      setIsPackingSingleImages(false);
    }
  }, [
    isExporting,
    isPackingSingleImages,
    orderedFrames,
    resolvePackRootDir,
  ]);

  const isAnyExporting = isExporting || isPackingSingleImages;

  const handleTogglePicker = useCallback((frameId: string, x: number, y: number) => {
    setPickerState((previous) => {
      if (previous?.frameId === frameId) {
        return null;
      }
      return { frameId, x, y };
    });
  }, []);

  const handleReplaceFromInput = useCallback(
    (frameId: string, imageUrl: string) => {
      setExportError(null);
      const matched = incomingImageItems.find((item) => item.imageUrl === imageUrl);
      updateStoryboardFrame(id, frameId, {
        imageUrl: matched?.imageUrl ?? imageUrl,
        previewImageUrl: matched?.previewImageUrl ?? matched?.imageUrl ?? imageUrl,
      });
      setPickerState(null);
    },
    [id, incomingImageItems, updateStoryboardFrame]
  );

  return (
    <div
      ref={rootRef}
      className={`
        group relative flex h-full flex-col overflow-visible rounded-[var(--node-radius)] border ${CANVAS_NODE_PANEL_SURFACE_CLASS} p-2 transition-colors duration-150
        ${canvasNodeFrameClass({ selected })}
      `}
      style={{ width: `${resolvedNodeWidth}px`, height: `${resolvedNodeHeight}px` }}
      onClick={() => setSelectedNode(id)}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<SplitResultIcon className="h-3.5 w-3.5" />}
        titleText={resolvedTitle}
        headerAdjust={STORYBOARD_SPLIT_HEADER_ADJUST}
        iconAdjust={STORYBOARD_SPLIT_ICON_ADJUST}
        titleAdjust={STORYBOARD_SPLIT_TITLE_ADJUST}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      <div
        className="ui-scrollbar nowheel min-h-0 flex-1 overflow-auto"
        onWheelCapture={(event) => event.stopPropagation()}
      >
        <div
          className="grid overflow-hidden rounded-lg border border-[rgba(255,255,255,0.16)] bg-[rgba(255,255,255,0.14)]"
          style={{
            gap: `${STORYBOARD_GRID_GAP_PX}px`,
            gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
          }}
        >
          {orderedFrames.map((frame, index) => (
            <FrameCard
              key={frame.id}
              nodeId={id}
              frame={frame}
              index={index}
              frameAspectRatioCss={frameAspectRatioCss}
              imageFit={exportOptions.imageFit}
              viewerImageList={frameViewerImageList}
              draggedFrameId={draggedFrameId}
              dropTargetFrameId={dropTargetFrameId}
              onSortStart={handleSortStart}
              onSortHover={handleSortHover}
              onTogglePicker={handleTogglePicker}
              onEditFrame={(targetFrame) => {
                void handleEditFrame(targetFrame);
              }}
            />
          ))}
        </div>
      </div>

      {pickerState && typeof document !== 'undefined'
        ? createPortal(
          <div
            ref={pickerMenuRef}
            className="nowheel fixed z-[140] w-[120px] overflow-hidden rounded-xl border border-[rgba(255,255,255,0.16)] bg-surface-dark shadow-xl"
            style={{ left: `${pickerState.x}px`, top: `${pickerState.y}px` }}
            onMouseDown={(event) => event.stopPropagation()}
            onWheelCapture={(event) => event.stopPropagation()}
          >
            {incomingImageItems.length > 0 ? (
              <div
                className="ui-scrollbar nowheel max-h-[180px] overflow-y-auto"
                onWheelCapture={(event) => event.stopPropagation()}
              >
                {incomingImageItems.map((item) => (
                  <button
                    key={`${pickerState.frameId}-${item.imageUrl}`}
                    type="button"
                    className="flex w-full items-center gap-2 border border-transparent bg-bg-dark/70 px-2 py-2 text-left text-sm text-text-dark transition-colors hover:border-[rgba(255,255,255,0.18)]"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleReplaceFromInput(pickerState.frameId, item.imageUrl);
                    }}
                    title={item.label}
                  >
                    <CanvasNodeImage
                      src={item.displayUrl}
                      alt={item.label}
                      viewerSourceUrl={resolveImageDisplayUrl(item.imageUrl)}
                      viewerImageList={incomingImageViewerList}
                      className="h-8 w-8 rounded object-cover"
                      draggable={false}
                    />
                    <span className="truncate">{item.label}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="px-2 py-2 text-sm text-text-muted">
                {t('node.storyboard.noInputImages')}
              </div>
            )}
          </div>,
          document.body
        )
        : null}

      {isExportPanelOpen && (
        <UiPanel
          className={`nodrag nowheel mt-2 shrink-0 p-2.5 ${STORYBOARD_EXPORT_PANEL_CLASS}`}
          onMouseDown={(event) => event.stopPropagation()}
          onWheelCapture={(event) => event.stopPropagation()}
        >
          <div className="grid gap-2 text-xs text-text-muted/82">
            <div className="grid grid-cols-2 gap-2">
              <label className="flex items-center gap-2 whitespace-nowrap text-text-dark/90">
                <UiCheckbox
                  className={STORYBOARD_EXPORT_CHECKBOX_CLASS}
                  checked={exportOptions.showFrameIndex}
                  onCheckedChange={(checked) => patchExportOptions({ showFrameIndex: checked })}
                />
                {t('node.storyboard.showFrameIndex')}
              </label>
              <label className="flex items-center gap-2 whitespace-nowrap text-text-dark/90">
                <UiCheckbox
                  className={STORYBOARD_EXPORT_CHECKBOX_CLASS}
                  checked={exportOptions.showFrameNote}
                  onCheckedChange={(checked) => patchExportOptions({ showFrameNote: checked })}
                />
                {t('node.storyboard.showFrameNote')}
              </label>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <label className="grid min-w-0 gap-1">
                <span className="truncate">{t('node.storyboard.imageFit')}</span>
                <UiSelect
                  className={STORYBOARD_EXPORT_FIELD_CLASS}
                  value={exportOptions.imageFit}
                  onChange={(event) =>
                    patchExportOptions({
                      imageFit: event.target.value === 'contain' ? 'contain' : 'cover',
                    })
                  }
                >
                  <option value="cover">{t('node.storyboard.imageFitCover')}</option>
                  <option value="contain">{t('node.storyboard.imageFitContain')}</option>
                </UiSelect>
              </label>
              <label className="grid min-w-0 gap-1">
                <span className="truncate">{t('node.storyboard.notePlacement')}</span>
                <UiSelect
                  className={STORYBOARD_EXPORT_FIELD_CLASS}
                  value={exportOptions.notePlacement}
                  onChange={(event) =>
                    patchExportOptions({
                      notePlacement: event.target.value === 'bottom' ? 'bottom' : 'overlay',
                    })
                  }
                >
                  <option value="overlay">{t('node.storyboard.notePlacementOverlay')}</option>
                  <option value="bottom">{t('node.storyboard.notePlacementBottom')}</option>
                </UiSelect>
              </label>
              <label className="grid min-w-0 gap-1">
                <span className="truncate">{t('node.storyboard.frameIndexPrefix')}</span>
                <UiInput
                  value={exportOptions.frameIndexPrefix}
                  maxLength={4}
                  className={`h-8 ${STORYBOARD_EXPORT_FIELD_CLASS}`}
                  onChange={(event) => patchExportOptions({ frameIndexPrefix: event.target.value })}
                />
              </label>
            </div>

            <div className="grid grid-cols-4 gap-2">
              <label className="grid min-w-0 gap-1">
                <span className="truncate">{t('node.storyboard.cellGap')}</span>
                <UiInput
                  type="number"
                  min={0}
                  max={120}
                  value={exportOptions.cellGap}
                  className={`h-8 ${STORYBOARD_EXPORT_FIELD_CLASS}`}
                  onChange={(event) =>
                    patchExportOptions({ cellGap: Number(event.target.value) || 0 })
                  }
                />
              </label>
              <label className="grid min-w-0 gap-1">
                <span className="truncate">{t('node.storyboard.fontSize')}</span>
                <UiInput
                  type="number"
                  min={1}
                  max={20}
                  value={exportOptions.fontSize}
                  className={`h-8 ${STORYBOARD_EXPORT_FIELD_CLASS}`}
                  onChange={(event) =>
                    patchExportOptions({ fontSize: Number(event.target.value) || 4 })
                  }
                />
              </label>
              <label className="grid min-w-0 gap-1">
                <span className="truncate">{t('node.storyboard.backgroundColor')}</span>
                <input
                  type="color"
                  value={exportOptions.backgroundColor}
                  onChange={(event) => patchExportOptions({ backgroundColor: event.target.value })}
                  className="h-8 w-full rounded-[6px] border border-white/[0.22] bg-transparent p-0.5 hover:border-white/[0.34]"
                />
              </label>
              <label className="grid min-w-0 gap-1">
                <span className="truncate">{t('node.storyboard.textColor')}</span>
                <input
                  type="color"
                  value={exportOptions.textColor}
                  onChange={(event) => patchExportOptions({ textColor: event.target.value })}
                  className="h-8 w-full rounded-[6px] border border-white/[0.22] bg-transparent p-0.5 hover:border-white/[0.34]"
                />
              </label>
            </div>
          </div>
        </UiPanel>
      )}

      <div className="mt-2 flex shrink-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="nodrag relative flex">
            <UiChipButton
              active={isExportPanelOpen}
              className={`${NODE_CONTROL_CHIP_CLASS} ${STORYBOARD_EXPORT_TRIGGER_CLASS} ${
                isExportPanelOpen
                  ? STORYBOARD_EXPORT_TRIGGER_ACTIVE_CLASS
                  : STORYBOARD_EXPORT_TRIGGER_INACTIVE_CLASS
              }`}
              onClick={(event) => {
                event.stopPropagation();
                setIsExportPanelOpen((open) => !open);
              }}
            >
              <SlidersHorizontal className={`${NODE_CONTROL_ICON_CLASS} shrink-0`} />
              <span>{t('node.storyboard.exportSettings')}</span>
            </UiChipButton>
          </div>

          <div className="truncate text-[11px] text-text-muted/80">
            {t('node.storyboard.gridSummary', {
              rows: gridRows,
              cols: gridCols,
              count: totalFrames,
            })}
          </div>
        </div>

        <div className="flex min-w-0 items-center gap-2">
          <UiButton
            size="sm"
            variant="muted"
            className={`nodrag ${NODE_CONTROL_PRIMARY_BUTTON_CLASS} ${STORYBOARD_EXPORT_BUTTON_CLASS}`}
            onClick={(event) => {
              event.stopPropagation();
              void handlePackSingleImages();
            }}
            disabled={isAnyExporting}
          >
            <FolderOpen className={NODE_CONTROL_ICON_CLASS} />
            {isPackingSingleImages ? t('node.storyboard.packing') : t('node.storyboard.pack')}
          </UiButton>
          <UiButton
            size="sm"
            variant="primary"
            className={`nodrag ${NODE_CONTROL_PRIMARY_BUTTON_CLASS} ${STORYBOARD_EXPORT_PRIMARY_BUTTON_CLASS}`}
            onClick={(event) => {
              event.stopPropagation();
              void handleExport();
            }}
            disabled={isAnyExporting}
          >
            <Download className={NODE_CONTROL_ICON_CLASS} />
            {isExporting ? t('node.storyboard.exporting') : t('node.storyboard.mergeGrid')}
          </UiButton>
        </div>
      </div>

      {exportError && <div className="mt-2 shrink-0 text-xs text-red-400 break-words [overflow-wrap:anywhere]">{exportError}</div>}

      <Handle
        type="target"
        id="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-surface-dark !bg-[rgb(148,163,184)]"
      />
      <Handle
        type="source"
        id="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-surface-dark !bg-[rgb(148,163,184)]"
      />
      <NodeResizeHandle
        minWidth={STORYBOARD_NODE_WIDTH_PX}
        minHeight={STORYBOARD_NODE_MIN_HEIGHT_PX}
        maxWidth={1800}
        maxHeight={1600}
      />
    </div>
  );
});

StoryboardNode.displayName = 'StoryboardNode';
