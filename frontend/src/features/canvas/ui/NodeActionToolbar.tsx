// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { NodeToolbar as ReactFlowNodeToolbar } from "@xyflow/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/shadcn/dropdown-menu";
import {
  Boxes,
  ChevronDown,
  Copy,
  Crop,
  Download,
  Eraser,
  Expand,
  FastForward,
  Film,
  FolderOpen,
  Globe2,
  Grid2x2,
  Grid3x3,
  ImageUpscale,
  LayoutDashboard,
  LayoutGrid,
  Link2,
  Lightbulb,
  Loader2,
  Maximize2,
  Package,
  Palette,
  PenLine,
  RefreshCw,
  Rewind,
  RotateCw,
  Scissors,
  Send,
  Sparkles,
  Trash2,
  Unlink2,
  User,
  Users,
  Video as VideoIcon,
  Wand2,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { toast } from "sonner";

import { downloadBlobAsFile, downloadUrlAsFile } from "@/lib/browserDownload";
import {
  AUDIO_DOWNLOAD_FORMATS,
  canProduceFormat,
  getAudioExtFromUrl,
  transcodeAudio,
  type AudioDownloadFormat,
} from "@/lib/audioTranscode";
import { nodeMainlineFlags } from "@/features/canvas/domain/mainlineNodeFlags";
import { inheritMainlineFields } from "@/features/canvas/domain/inheritMainlineFields";
import {
  extractMainlineContextsFromNode,
  type MainlineContext,
} from "@/features/freezone/context/mainlineContext";
import { deriveNodeDropInfo } from "@/stores/assetDropStore";

import {
  NODE_TOOL_TYPES,
  CANVAS_NODE_TYPES,
  DEFAULT_NODE_WIDTH,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  isAudioNode,
  isExportImageNode,
  isGroupNode,
  isImageEditNode,
  isImageGenNode,
  isProtectedProjectionGroupNode,
  isStoryboardGenNode,
  isStoryboardGroupNode,
  isStoryboardSplitNode,
  isUploadNode,
  isVideoNode,
  resolveNodeSourceImageUrl,
  type CanvasNode,
  type GroupNodeData,
  type NodeToolType,
} from "@/features/canvas/domain/canvasNodes";
import { GROUP_COLOR_PRESETS } from "@/features/canvas/domain/groupColors";
import { StoryboardGroupToolbar } from "@/features/canvas/ui/StoryboardGroupToolbar";
import { canvasEventBus } from "@/features/canvas/application/canvasServices";
import { useCanvasProjectionStatus } from "@/features/freezone/projectionStatusStore";
import {
  matteInWorker,
  preloadMatteWorker,
} from "@/features/canvas/application/matteClient";
import { getNodeToolPlugins } from "@/features/canvas/tools";
import type { ToolIconKey } from "@/features/canvas/tools";
import { UiChipButton, UiPanel } from "@/components/ui";
import { ZoomScaledToolbar } from "@/features/canvas/ui/ZoomScaledToolbar";
import { copyImageSourceToClipboard } from "@/commands/image";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import { useSettingsStore } from "@/stores/settingsStore";
import { useCanvasStore } from "@/stores/canvasStore";
import {
  fetchFreezoneAudioSeparateResult,
  submitFreezoneAnalyzeVideoStory,
  submitFreezoneAudioSeparate,
  uploadFreezoneImage,
} from "@/api/ops";
import { openPresetProjectionInMyCanvas } from "@/features/freezone/openPresetProjection";
import { awaitTaskCompletion } from "@/api/tasks";
import { normalizeVideoStoryRows } from "@/features/canvas/application/videoStoryNormalizer";
import { readUrl } from "@/lib/url-params";
import { sanitizeStoryboardText } from "@/features/canvas/application/storyboardText";
import { buildGenerationErrorReport } from "@/features/canvas/application/generationErrorReport";
import {
  NODE_TOOLBAR_ALIGN,
  NODE_TOOLBAR_CLASS,
  NODE_TOOLBAR_OFFSET,
  NODE_TOOLBAR_POSITION,
} from "./nodeToolbarConfig";
import type {
  GridActionKey,
  GridActionRequest,
} from "./GridActionConfirmOverlay";

interface NodeActionToolbarProps {
  node: CanvasNode;
  onOpenMultiAngleEditor: (nodeId: string) => void;
  onOpenLightEditor: (nodeId: string) => void;
  onOpenScene360: (nodeId: string) => void;
  onOpenUpscale: (nodeId: string) => void;
  onOpenOutpaint: (nodeId: string) => void;
  onOpenGridAction: (request: GridActionRequest) => void;
  onOpenRedraw: (nodeId: string) => void;
  onOpenErase: (nodeId: string) => void;
  onOpenRotate: (nodeId: string) => void;
}

const toolIconMap: Record<ToolIconKey, typeof Crop> = {
  crop: Crop,
  annotate: PenLine,
  split: Scissors,
};

const TOOLBAR_BUTTON_RADIUS_CLASS = "rounded-[12px]";
// 扁平菜单项：去掉独立边框与胶囊背景，融入工具栏整条；仅靠 hover 高亮区分。
const TOOLBAR_NEUTRAL_BUTTON_CLASS =
  "!border-transparent !bg-transparent text-text-dark hover:!bg-[rgba(255,255,255,0.075)] focus:!border-transparent focus:!bg-transparent focus:!shadow-none focus-visible:!outline-none focus-visible:!ring-0 data-[state=open]:!border-transparent data-[state=open]:!shadow-none";
const TOOLBAR_TEXT_BUTTON_CLASS =
  `h-9 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-3 text-sm ${TOOLBAR_NEUTRAL_BUTTON_CLASS}`;
const TOOLBAR_MENU_CONTENT_CLASS =
  "z-[120] border-white/10 bg-[#242426]/50 text-text-dark shadow-none backdrop-blur-3xl";
const TOOLBAR_MENU_ITEM_CLASS =
  "gap-2 rounded-[10px] text-text-dark focus:bg-[rgba(255,255,255,0.075)] focus:text-text-dark";

type BeatMainlineContext = MainlineContext & {
  projectId: string;
  episode: number;
  beat: number;
};

const BEAT_CONTEXT_SOURCE_KINDS = new Set([
  "beat",
  "sketch",
  "frame",
  "video",
  "audio",
  "director_combined",
  "selected_background",
]);

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayOrUndefined(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : undefined;
}

function beatContextLabel(episode: number, beat: number): string {
  return `EP${episode} / Beat ${beat}`;
}

function beatContextFromRecord(
  raw: unknown,
  projectFallback?: string,
): BeatMainlineContext | null {
  const record = recordOrNull(raw);
  if (!record || record.kind !== "beat") return null;
  const projectId = stringOrUndefined(record.projectId) ?? projectFallback;
  const episode = numberOrUndefined(record.episode);
  const beat = numberOrUndefined(record.beat);
  if (!projectId || episode === undefined || beat === undefined) return null;
  return {
    ...(record as MainlineContext),
    kind: "beat",
    projectId,
    episode,
    beat,
    role: "beat_context",
    label: stringOrUndefined(record.label) ?? beatContextLabel(episode, beat),
  };
}

function beatContextFromParts(
  projectId: string | undefined,
  episode: number | undefined,
  beat: number | undefined,
  meta: Record<string, unknown> | null,
): BeatMainlineContext | null {
  if (!projectId || episode === undefined || beat === undefined) return null;
  return {
    kind: "beat",
    projectId,
    episode,
    beat,
    role: "beat_context",
    label: beatContextLabel(episode, beat),
    visualDescription: stringOrUndefined(meta?.visual_description),
    narrationSegment: stringOrUndefined(meta?.narration_segment),
    sceneId: stringOrUndefined(meta?.scene_id),
    detectedIdentities: stringArrayOrUndefined(meta?.detected_identities),
    detectedProps: stringArrayOrUndefined(meta?.detected_props),
    sketchColors:
      (recordOrNull(meta?.sketch_colors) as Record<string, string> | null) ?? undefined,
    propMarkerColors:
      (recordOrNull(meta?.prop_marker_colors) as Record<string, string> | null) ?? undefined,
  };
}

function beatContextFromNode(node: CanvasNode): BeatMainlineContext | null {
  const data = recordOrNull(node.data) ?? {};
  const source = recordOrNull(data.__freezone_source);
  const projectFallback =
    stringOrUndefined(source?.projectId) ??
    stringOrUndefined(data.projectId) ??
    readUrl().project ??
    undefined;

  const explicit =
    beatContextFromRecord(source?.beat_context, projectFallback) ??
    beatContextFromRecord(data.beat_context, projectFallback);
  if (explicit) return explicit;

  const contexts = extractMainlineContextsFromNode(node);
  const direct = contexts.find(
    (ctx): ctx is BeatMainlineContext =>
      ctx.kind === "beat" &&
      typeof ctx.projectId === "string" &&
      typeof ctx.episode === "number" &&
      typeof ctx.beat === "number",
  );
  if (direct) return direct;

  const slotContext = contexts.find(
    (ctx) =>
      BEAT_CONTEXT_SOURCE_KINDS.has(ctx.kind) &&
      typeof ctx.projectId === "string" &&
      typeof ctx.episode === "number" &&
      typeof ctx.beat === "number",
  );
  if (slotContext) {
    return {
      ...slotContext,
      kind: "beat",
      role: "beat_context",
      label:
        stringOrUndefined(slotContext.label) ??
        beatContextLabel(slotContext.episode as number, slotContext.beat as number),
      sourceUrl: undefined,
    } as BeatMainlineContext;
  }

  const sourceRole = stringOrUndefined(source?.role);
  const sourceKind = stringOrUndefined(source?.kind);
  const beatScoped = Boolean(
    sourceRole &&
      ["current_sketch", "current_frame", "current_video", "current_audio", "selected_background", "director_combined"].includes(sourceRole),
  ) || Boolean(sourceKind && ["video", "audio"].includes(sourceKind));
  if (!beatScoped) return null;

  return beatContextFromParts(
    projectFallback,
    numberOrUndefined(source?.episode),
    numberOrUndefined(source?.beat),
    recordOrNull(source?.meta),
  );
}

function sameBeatContext(a: MainlineContext, b: BeatMainlineContext): boolean {
  return (
    a.kind === "beat" &&
    a.projectId === b.projectId &&
    a.episode === b.episode &&
    a.beat === b.beat
  );
}

function beatContextText(ctx: BeatMainlineContext): string {
  return [
    `Episode: ${ctx.episode}`,
    `Beat: ${ctx.beat}`,
    ctx.visualDescription ? `Visual: ${ctx.visualDescription}` : "",
    ctx.narrationSegment ? `Narration: ${ctx.narrationSegment}` : "",
  ].filter(Boolean).join("\n");
}

function beatContextNodeData(ctx: BeatMainlineContext): Record<string, unknown> {
  return {
    displayName: `镜头上下文 · EP${ctx.episode}/B${ctx.beat}`,
    content: beatContextText(ctx),
    projectId: ctx.projectId,
    episode: ctx.episode,
    beat: ctx.beat,
    context_scope: "mainline",
    beat_context: undefined,
    snapshot: {
      visualDescription: ctx.visualDescription ?? "",
      narrationSegment: ctx.narrationSegment ?? "",
      sceneId: ctx.sceneId ?? "",
      detectedIdentities: ctx.detectedIdentities ?? [],
      detectedProps: ctx.detectedProps ?? [],
      sketchColors: ctx.sketchColors ?? {},
      propMarkerColors: ctx.propMarkerColors ?? {},
    },
    mainline_context: [ctx],
    beat_edit_fields: {
      visual_description: ctx.visualDescription ?? "",
      scene_id: ctx.sceneId ?? "",
      time_of_day: "",
      detected_identities: ctx.detectedIdentities ?? [],
      detected_props: ctx.detectedProps ?? [],
    },
  };
}

/** 工具栏内分组之间的竖向分隔线，呼应 libtv 的连续扁平条视觉。 */
function ToolbarDivider() {
  return (
    <span
      aria-hidden
      className="mx-1 h-4 w-px shrink-0 self-center bg-[rgba(255,255,255,0.14)]"
    />
  );
}

/**
 * 让 Radix DropdownMenu 支持鼠标 hover 自动展开/移出延迟收起（Radix 原生只支持
 * 点击）。返回挂到根的受控 props 与挂到「触发器 + 内容」的 hover 事件；点击仍可用。
 * `onOpen` 在打开瞬间触发（用来关掉同行的下载浮层等）。
 */
function useHoverMenu(onOpen?: () => void) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const openNow = useCallback(() => {
    cancelClose();
    onOpen?.();
    setOpen(true);
  }, [cancelClose, onOpen]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 160);
  }, [cancelClose]);

  const onOpenChange = useCallback(
    (next: boolean) => {
      cancelClose();
      if (next) onOpen?.();
      setOpen(next);
    },
    [cancelClose, onOpen],
  );

  useEffect(() => cancelClose, [cancelClose]);

  return {
    open,
    rootProps: { open, onOpenChange, modal: false } as const,
    hoverProps: { onMouseEnter: openNow, onMouseLeave: scheduleClose },
  };
}


/**
 * Icon-only toolbar 按钮：方形 32×32 click area + 16px icon，与同行的带文字 chip
 * 等高对齐；hover 时在下方浮出主题化 tooltip（不依赖原生 title 的浏览器实现）。
 */
function ToolbarIconChip({
  label,
  icon: Icon,
  onClick,
  extraButtonClass = "",
}: {
  label: string;
  icon: typeof Crop;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  extraButtonClass?: string;
}) {
  return (
    <div className="group/iconchip relative">
      <UiChipButton
        title={label}
        aria-label={label}
        className={`h-9 w-9 justify-center !px-0 ${TOOLBAR_BUTTON_RADIUS_CLASS} text-sm ${TOOLBAR_NEUTRAL_BUTTON_CLASS} ${extraButtonClass}`}
        onClick={onClick}
      >
        <Icon className="h-4 w-4" />
      </UiChipButton>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-[140] mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-md border border-[rgba(255,255,255,0.18)] bg-surface-dark/95 px-2 py-1 text-[11px] font-medium text-text-dark opacity-0 shadow-lg backdrop-blur-sm transition-opacity duration-150 delay-100 group-hover/iconchip:opacity-100"
      >
        {label}
      </span>
    </div>
  );
}

export const NodeActionToolbar = memo(
  ({
    node,
    onOpenMultiAngleEditor,
    onOpenLightEditor,
    onOpenScene360,
    onOpenUpscale,
    onOpenOutpaint,
    onOpenGridAction,
    onOpenRedraw,
    onOpenErase,
    onOpenRotate,
  }: NodeActionToolbarProps) => {
    const { t, i18n } = useTranslation();
    const isImageEdit = isImageEditNode(node);
    // Plain (non-protected) group → eligible for ungroup. Captured up here as a
    // boolean + a plain id while `node` still has its full type: over-broad node
    // type guards below narrow `node` to `never` by the time the ungroup button
    // renders, so reading `node.id` at the call site fails to type-check.
    const nodeId = node.id;
    const isUngroupableGroup = isGroupNode(node) && !isProtectedProjectionGroupNode(node);
    // 同 nodeId:在 node 仍是完整类型时捕获组背景色。下方过宽的类型守卫会把 node
    // 收窄成 never,到 ungroup 按钮渲染处再读 node.data 会编译失败(tsc -b)。
    const groupBackgroundColor = isGroupNode(node)
      ? ((node.data as GroupNodeData).backgroundColor ?? null)
      : null;
    const isStoryboardGen = isStoryboardGenNode(node);
    const isStoryboardSplit = isStoryboardSplitNode(node);
    const canCopyStoryboardText = isStoryboardGen || isStoryboardSplit;
    const tools = useMemo(() => getNodeToolPlugins(node), [node]);
    const deleteNode = useCanvasStore((state) => state.deleteNode);
    const addNode = useCanvasStore((state) => state.addNode);
    const addEdge = useCanvasStore((state) => state.addEdge);
    const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
    const onNodesChange = useCanvasStore((state) => state.onNodesChange);
    const requestFocusNode = useCanvasStore((state) => state.requestFocusNode);
    const ungroupNode = useCanvasStore((state) => state.ungroupNode);
    const arrangeGroupChildren = useCanvasStore(
      (state) => state.arrangeGroupChildren,
    );
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);
    const findNodePosition = useCanvasStore((state) => state.findNodePosition);
    const canReupload = isUploadNode(node) && Boolean(node.data.imageUrl);
    const ignoreAtTagWhenCopyingAndGenerating = useSettingsStore(
      (state) => state.ignoreAtTagWhenCopyingAndGenerating,
    );
    const [activeEditAction, setActiveEditAction] = useState<
      "repaint" | "erase" | "matting" | "crop" | "hd" | "outpaint"
    >("matting");
    const [activeGridAction, setActiveGridAction] =
      useState<GridActionKey | null>(null);
    const [isCopySuccess, setIsCopySuccess] = useState(false);
    const [isCopyTextSuccess, setIsCopyTextSuccess] = useState(false);
    const [isCopyErrorSuccess, setIsCopyErrorSuccess] = useState(false);
    const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );
    const copyTextFeedbackTimerRef = useRef<ReturnType<
      typeof setTimeout
    > | null>(null);
    const copyErrorFeedbackTimerRef = useRef<ReturnType<
      typeof setTimeout
    > | null>(null);
    // mainline canvas readonly state + "打开工作台" 入口需要的本地状态。
    const workbenchTarget = useMemo(() => {
      const raw = (node.data as { workbench_target?: unknown }).workbench_target;
      if (!raw || typeof raw !== "object") return null;
      const target = raw as { scope?: unknown; episode?: unknown; beat?: unknown };
      if (
        target.scope === "beat" &&
        typeof target.episode === "number" &&
        typeof target.beat === "number"
      ) {
        return { scope: "beat" as const, episode: target.episode, beat: target.beat };
      }
      return null;
    }, [node.data]);
    const [openingWorkbench, setOpeningWorkbench] = useState(false);
    // 用统一 helper 解析节点当前图片源，避免每种图片节点各写一套判断。
    const imageSource = useMemo(() => resolveNodeSourceImageUrl(node), [node]);
    const canHandleImage = Boolean(imageSource);
    // commit 按钮现在覆盖所有媒体节点(图像/视频/音频/3GS)——只要能从节点推断出
    // 可提交的媒体 url 就显示。具体提交目标在 CommitDialog 里按 mediaType 处理。
    const canCommitNode = useMemo(
      () => Boolean(deriveNodeDropInfo(node)?.sourceUrl),
      [node],
    );
    const protectedProjectionKey =
      isProtectedProjectionGroupNode(node) &&
      typeof node.data.projection_key === "string" &&
      node.data.projection_key.trim()
        ? node.data.projection_key.trim()
        : null;
    const projectionStatus = useCanvasProjectionStatus(protectedProjectionKey);
    const projectionIsStale = projectionStatus?.stale === true;
    const extractableBeatContext = useMemo(() => beatContextFromNode(node), [node]);
    const canExposeGenerationError =
      isExportImageNode(node) || isImageGenNode(node);
    const generationError =
      canExposeGenerationError &&
      typeof (node.data as { generationError?: unknown }).generationError ===
        "string"
        ? (
            (node.data as { generationError?: string }).generationError ?? ""
          ).trim()
        : "";
    const generationErrorDetails =
      canExposeGenerationError &&
      typeof (node.data as { generationErrorDetails?: unknown })
        .generationErrorDetails === "string"
        ? (
            (node.data as { generationErrorDetails?: string })
              .generationErrorDetails ?? ""
          ).trim()
        : "";
    const canCopyGenerationError =
      canExposeGenerationError && generationError.length > 0;
    const generationErrorReport = useMemo(
      () => {
        // ImageGen keeps the exact pre-normalization error in details: copy it
        // verbatim. Export-image nodes retain their richer diagnostic report.
        if (isImageGenNode(node)) {
          return generationErrorDetails || generationError;
        }
        return buildGenerationErrorReport({
          errorMessage: generationError || t("ai.error"),
          errorDetails: generationErrorDetails || undefined,
          context: (node.data as { generationDebugContext?: unknown })
            .generationDebugContext,
        });
      },
      [generationError, generationErrorDetails, node, t],
    );

    const closeDownloadMenu = useCallback(() => {}, []);

    const resolveToolLabel = useCallback(
      (toolType: NodeToolType) => {
        if (toolType === NODE_TOOL_TYPES.crop) {
          return t("tool.crop");
        }
        if (toolType === NODE_TOOL_TYPES.annotate) {
          return t("tool.annotate");
        }
        if (toolType === NODE_TOOL_TYPES.splitStoryboard) {
          return t("tool.split");
        }
        return "";
      },
      [t],
    );

    // hover 即展开的编辑/九宫格下拉（打开时顺手关掉下载浮层）。
    const editMenu = useHoverMenu(closeDownloadMenu);
    const gridMenu = useHoverMenu(closeDownloadMenu);

    // 选中可抠图的节点时,在浏览器空闲间隙预热抠图管线,把一次性的模型/Worker/
    // WASM 初始化挪到用户点击「抠图」之前,避免点击瞬间主线程卡 2~3s。整段只跑一次。
    useEffect(() => {
      if (!canHandleImage) {
        return;
      }
      const win = window as unknown as {
        requestIdleCallback?: (cb: () => void) => number;
        cancelIdleCallback?: (handle: number) => void;
      };
      if (typeof win.requestIdleCallback === "function") {
        const handle = win.requestIdleCallback(() => {
          preloadMatteWorker();
        });
        return () => {
          win.cancelIdleCallback?.(handle);
        };
      }
      const timer = setTimeout(() => {
        preloadMatteWorker();
      }, 1200);
      return () => {
        clearTimeout(timer);
      };
    }, [canHandleImage]);

    useEffect(() => {
      return () => {
        if (copyFeedbackTimerRef.current) {
          clearTimeout(copyFeedbackTimerRef.current);
        }
        if (copyTextFeedbackTimerRef.current) {
          clearTimeout(copyTextFeedbackTimerRef.current);
        }
        if (copyErrorFeedbackTimerRef.current) {
          clearTimeout(copyErrorFeedbackTimerRef.current);
        }
      };
    }, []);

    const handleCopyImage = useCallback(async () => {
      if (!imageSource) {
        return;
      }

      setIsCopySuccess(true);
      if (copyFeedbackTimerRef.current) {
        clearTimeout(copyFeedbackTimerRef.current);
      }
      copyFeedbackTimerRef.current = setTimeout(() => {
        setIsCopySuccess(false);
        copyFeedbackTimerRef.current = null;
      }, 1100);

      try {
        await copyImageSourceToClipboard(imageSource);
      } catch (error) {
        console.error("Failed to copy image to clipboard", error);
      }
    }, [imageSource]);

    const storyboardText = useMemo(() => {
      if (isStoryboardGen) {
        return node.data.frames
          .map((frame, index) =>
            t("nodeToolbar.storyboardLine", {
              index: String(index + 1).padStart(2, "0"),
              content: sanitizeStoryboardText(
                frame.description ?? "",
                ignoreAtTagWhenCopyingAndGenerating,
              ),
            }),
          )
          .join("\n");
      }
      if (isStoryboardSplit) {
        const orderedFrames = [...node.data.frames].sort(
          (a, b) => a.order - b.order,
        );
        return orderedFrames
          .map((frame, index) =>
            t("nodeToolbar.storyboardLine", {
              index: String(index + 1).padStart(2, "0"),
              content: sanitizeStoryboardText(
                frame.note ?? "",
                ignoreAtTagWhenCopyingAndGenerating,
              ),
            }),
          )
          .join("\n");
      }
      return "";
    }, [
      ignoreAtTagWhenCopyingAndGenerating,
      isStoryboardGen,
      isStoryboardSplit,
      node,
      t,
      i18n.language,
    ]);

    const handleCopyStoryboardText = useCallback(async () => {
      if (!storyboardText) {
        return;
      }

      setIsCopyTextSuccess(true);
      if (copyTextFeedbackTimerRef.current) {
        clearTimeout(copyTextFeedbackTimerRef.current);
      }
      copyTextFeedbackTimerRef.current = setTimeout(() => {
        setIsCopyTextSuccess(false);
        copyTextFeedbackTimerRef.current = null;
      }, 1100);

      try {
        await navigator.clipboard.writeText(storyboardText);
      } catch (error) {
        console.error("Failed to copy storyboard text", error);
      }
    }, [storyboardText]);

    const handleCopyGenerationError = useCallback(async () => {
      if (!canCopyGenerationError) {
        return;
      }

      setIsCopyErrorSuccess(true);
      if (copyErrorFeedbackTimerRef.current) {
        clearTimeout(copyErrorFeedbackTimerRef.current);
      }
      copyErrorFeedbackTimerRef.current = setTimeout(() => {
        setIsCopyErrorSuccess(false);
        copyErrorFeedbackTimerRef.current = null;
      }, 1100);

      try {
        await navigator.clipboard.writeText(generationErrorReport);
      } catch (error) {
        console.error("Failed to copy generation error report", error);
      }
    }, [canCopyGenerationError, generationErrorReport]);

    const resolveImageDownloadFilename = useCallback(() => {
      const sourceFileName =
        typeof (node.data as { sourceFileName?: unknown }).sourceFileName === "string"
          ? ((node.data as { sourceFileName?: string }).sourceFileName ?? "").trim()
          : "";
      if (sourceFileName) {
        return sourceFileName;
      }
      const displayName =
        typeof (node.data as { displayName?: unknown }).displayName === "string"
          ? ((node.data as { displayName?: string }).displayName ?? "").trim()
          : "";
      if (displayName) {
        return `${displayName}.png`;
      }
      return `node-${node.id}.png`;
    }, [node.data, node.id]);

    const handleDownloadSaveAs = useCallback(async () => {
      if (!imageSource) {
        return;
      }
      try {
        await downloadUrlAsFile(
          resolveImageDisplayUrl(imageSource),
          resolveImageDownloadFilename(),
        );
        closeDownloadMenu();
      } catch (error) {
        console.error("Failed to download image", error);
      }
    }, [closeDownloadMenu, imageSource, resolveImageDownloadFilename]);

    // 以下符号被暂时隐藏的 toolbar 按钮使用，保留代码不删除：
    // - Sparkles 图标用于 AI 改图按钮
    // - Copy 图标用于复制按钮
    // - RefreshCw 图标 / canReupload 用于"重新上传"按钮
    // - handleCreateAiEditNode / handleCopyImage / isCopySuccess 同上
    // 取消注释相关 JSX 后这些 void 也可以一起删掉
    void Sparkles;
    void RefreshCw;
    void canReupload;
    void handleCopyImage;
    void isCopySuccess;

    const handleCreateAiEditNode = useCallback(() => {
      if (!imageSource) {
        return;
      }
      closeDownloadMenu();
      const nodeWidth =
        typeof node.measured?.width === "number"
          ? node.measured.width
          : typeof node.width === "number"
            ? node.width
            : DEFAULT_NODE_WIDTH;
      const nextNodeId = addNode(
        CANVAS_NODE_TYPES.imageEdit,
        {
          x: node.position.x + nodeWidth + 96,
          y: node.position.y,
        },
        {
          displayName: t("nodeToolbar.aiEdit"),
          prompt: "",
          requestAspectRatio: "auto",
          generationMode: "image_reference",
        },
      );
      addEdge(node.id, nextNodeId);
      setSelectedNode(nextNodeId);
    }, [
      addEdge,
      addNode,
      closeDownloadMenu,
      imageSource,
      node,
      setSelectedNode,
      t,
    ]);
    // 同上：保留 handleCreateAiEditNode 等待恢复 AI 改图按钮
    void handleCreateAiEditNode;

    const handleCreatePresetEditNode = useCallback(
      (displayKey: "repaint" | "erase" | "matting", presetPrompt: string) => {
        if (!imageSource) {
          return;
        }
        closeDownloadMenu();
        const nodeWidth =
          typeof node.measured?.width === "number"
            ? node.measured.width
            : typeof node.width === "number"
              ? node.width
              : DEFAULT_NODE_WIDTH;
        // preset_managed parent nodes spawn user_spawned imageEdit children
        // via inheritMainlineFields — they carry slot_target/mainline_context/
        // committed_slot_url so Push can land back on the original canonical.
        const initialData = inheritMainlineFields(
          { data: node.data as Record<string, unknown> },
          {
            displayName: t(`nodeToolbar.${displayKey}`),
            prompt: presetPrompt,
            requestAspectRatio: "auto",
            generationMode: "image_reference",
          },
        );
        const nextNodeId = addNode(
          CANVAS_NODE_TYPES.imageEdit,
          {
            x: node.position.x + nodeWidth + 96,
            y: node.position.y,
          },
          initialData as unknown as Parameters<typeof addNode>[2],
        );
        addEdge(node.id, nextNodeId);
        setSelectedNode(nextNodeId);
      },
      [
        addEdge,
        addNode,
        closeDownloadMenu,
        imageSource,
        node,
        setSelectedNode,
        t,
      ],
    );
    // 擦除已改为 EraseOverlay（蒙版 + 重绘接口），不再新建 imageEdit 预设节点；
    // 保留此 helper 以便将来其它预设改图入口复用。
    void handleCreatePresetEditNode;

    const handleMatteImage = useCallback(() => {
      if (!imageSource) {
        return;
      }
      const projectId = readUrl().project;
      if (!projectId) {
        console.warn(
          "[matte] no project_id in URL (?p=<project_id>) — cannot persist matted PNG",
        );
        return;
      }
      closeDownloadMenu();

      const sourceAspectRatio =
        typeof (node.data as { aspectRatio?: unknown }).aspectRatio === "string"
          ? ((node.data as { aspectRatio?: string }).aspectRatio ?? "1:1")
          : "1:1";
      const position = findNodePosition(
        node.id,
        EXPORT_RESULT_NODE_DEFAULT_WIDTH,
        EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
      );
      // Same inheritance contract as the spawn-style overlays — matting
      // produces a user_spawned exportImage child that still represents
      // the same canonical slot at Push time.
      const matteInitialData = inheritMainlineFields(
        { data: node.data as Record<string, unknown> },
        {
          displayName: t("nodeToolbar.matting"),
          imageUrl: null,
          previewImageUrl: null,
          aspectRatio: sourceAspectRatio,
          resultKind: "matte",
          isGenerating: true,
          generationStartedAt: Date.now(),
        },
      );
      const nextNodeId = addNode(
        CANVAS_NODE_TYPES.exportImage,
        position,
        matteInitialData as unknown as Parameters<typeof addNode>[2],
      );
      addEdge(node.id, nextNodeId);
      setSelectedNode(nextNodeId);

      const sourceUrl = imageSource;
      void (async () => {
        try {
          const sourceResp = await fetch(sourceUrl);
          if (!sourceResp.ok) {
            throw new Error(`fetch source failed: ${sourceResp.status}`);
          }
          const sourceBlob = await sourceResp.blob();
          // 整段去背在自建 Worker 内执行(见 matteClient / matteWorker):无论 WebGPU
          // 是否可用,主线程都不阻塞,点击抠图后画布保持流畅。
          const mattedBlob = await matteInWorker(sourceBlob);
          const filename = `matte-${node.id}-${Date.now()}.png`;
          const uploaded = await uploadFreezoneImage(
            projectId,
            mattedBlob,
            filename,
          );
          updateNodeData(nextNodeId, {
            imageUrl: uploaded.url,
            previewImageUrl: uploaded.url,
            isGenerating: false,
            generationStartedAt: null,
            generationError: null,
            generationErrorDetails: null,
          });
        } catch (error) {
          console.error("[matte] failed", error);
          const message =
            error instanceof Error ? error.message : String(error);
          updateNodeData(nextNodeId, {
            isGenerating: false,
            generationStartedAt: null,
            generationError: message,
            generationErrorDetails: message,
          });
        }
      })();
    }, [
      addEdge,
      addNode,
      closeDownloadMenu,
      findNodePosition,
      imageSource,
      node,
      setSelectedNode,
      t,
      updateNodeData,
    ]);

    const handleOpenWorkbench = useCallback(() => {
      if (!workbenchTarget || openingWorkbench) {
        return;
      }
      const projectId = readUrl().project;
      if (!projectId) {
        console.warn("[freezone] no project_id in URL (?p=<project_id>)");
        return;
      }
      setOpeningWorkbench(true);
      void (async () => {
        try {
          await openPresetProjectionInMyCanvas(projectId, {
            scope: workbenchTarget.scope,
            episode: workbenchTarget.episode,
            beat: workbenchTarget.beat,
            primary_slot: "render",
          });
        } catch (error) {
          console.error("[freezone] open workbench failed", error);
        } finally {
          setOpeningWorkbench(false);
        }
      })();
    }, [openingWorkbench, workbenchTarget]);

    const handleEnsureBeatContextNode = useCallback(
      (event: ReactMouseEvent) => {
        event.stopPropagation();
        if (!extractableBeatContext) return;

        const store = useCanvasStore.getState();
        const existing = store.nodes.find((candidate) =>
          extractMainlineContextsFromNode(candidate).some((ctx) =>
            sameBeatContext(ctx, extractableBeatContext),
          ),
        );
        if (existing?.id) {
          setSelectedNode(String(existing.id));
          requestFocusNode(String(existing.id));
          return;
        }

        const nodeWidth =
          node.measured?.width ??
          (typeof node.width === "number" ? node.width : DEFAULT_NODE_WIDTH);
        const contextNodeId = addNode(
          CANVAS_NODE_TYPES.beatContext,
          {
            x: node.position.x + nodeWidth + 80,
            y: node.position.y,
          },
          beatContextNodeData(extractableBeatContext),
        );
        setSelectedNode(contextNodeId);
        requestFocusNode(contextNodeId);
      },
      [
        addNode,
        extractableBeatContext,
        node.measured?.width,
        node.position.x,
        node.position.y,
        node.width,
        requestFocusNode,
        setSelectedNode,
      ],
    );

    // Per-node mainline lock decision: only preset-managed nodes are locked.
    // Ordinary/user-created nodes stay editable even on a mainline preset canvas.
    //
    // NB: we deliberately do NOT early-return on locked. preset_managed
    // nodes still need access to **spawn-style** edit tools (relight /
    // multi-dim / crop / repaint / outpaint) — those produce new
    // user_spawned children that carry the inherited slot_target and Push
    // back to the same canonical. The lock affects only:
    //   - mutate-in-place tools (Rotate, the HD/upscale entry inside the
    //     edit-menu dropdown) — they'd violate canonical immutability;
    // The leading "主线投影 · 锁定" pill (+ optional "打开工作台" button)
    // signals the state visually so the user knows why some chips are
    // missing.
    const _toolbarFlags = nodeMainlineFlags(node);
    const isPresetLocked = _toolbarFlags.isPresetManaged;

    // 分镜组 has its own dedicated toolbar (aspect / grid / index / convert /
    // ungroup) — render it instead of the generic node toolbar.
    if (isStoryboardGroupNode(node)) {
      return <StoryboardGroupToolbar node={node} />;
    }

    return (
      <>
        <ReactFlowNodeToolbar
          nodeId={node.id}
          isVisible
          position={NODE_TOOLBAR_POSITION}
          align={NODE_TOOLBAR_ALIGN}
          offset={NODE_TOOLBAR_OFFSET}
          className={NODE_TOOLBAR_CLASS}
        >
          <ZoomScaledToolbar origin="bottom center" mode="counter" counterMax={1}>
          {/* 节点激活时，顶部菜单从节点上沿淡入+轻微上滑浮现（而非生硬地直接出现），
              与下方操作区的入场动画呼应。motion-reduce 下退化为无动画。 */}
          <UiPanel className="flex animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2 items-center gap-1.5 rounded-[18px] !border-white/10 !bg-[#242426]/95 px-2 py-1.5 text-sm shadow-[0_10px_24px_rgba(0,0,0,0.28)] backdrop-blur-2xl duration-200 ease-out motion-reduce:animate-none [&_svg]:h-4 [&_svg]:w-4">
            {/* Mainline lock indicator — shown as a leading pill when the
                node is preset-managed (or canvas-level fallback applies).
                The chips below remain visible for spawn-style edits; the
                mutate-style chips are gated separately so
                the user can still spawn user_spawned children from a
                canonical slot but cannot violate its immutability. */}
            {isPresetLocked && (
              <span
                key="mainline-lock-pill"
                className="rounded-full bg-amber-500/15 px-3 py-1.5 text-sm text-amber-100"
              >
                主线投影 · 锁定
              </span>
            )}
            {isPresetLocked && workbenchTarget && (
              <UiChipButton
                key="mainline-open-workbench"
                className={`h-9 ${TOOLBAR_BUTTON_RADIUS_CLASS} border-cyan-300/45 bg-cyan-400/12 px-3 text-sm text-cyan-100 hover:bg-cyan-300/20 disabled:opacity-50`}
                disabled={openingWorkbench}
                onClick={(event) => {
                  event.stopPropagation();
                  handleOpenWorkbench();
                }}
              >
                <FolderOpen className="h-3.5 w-3.5" />
                {openingWorkbench ? "打开中..." : "打开工作台"}
              </UiChipButton>
            )}
            {extractableBeatContext && node.type !== CANVAS_NODE_TYPES.beatContext && (
              <UiChipButton
                key="extract-beat-context"
                className={TOOLBAR_TEXT_BUTTON_CLASS}
                title="创建或定位这个素材对应的镜头上下文节点；不会自动连线"
                onClick={handleEnsureBeatContextNode}
              >
                <Link2 className="h-3.5 w-3.5" />
                镜头上下文
              </UiChipButton>
            )}
            {/* AI 改图按钮暂时隐藏（保留代码，等需求恢复时取消注释）
        {!isImageEdit && canHandleImage && (
          <UiChipButton
            key="image-ai-edit"
            className={`h-9 ${TOOLBAR_BUTTON_RADIUS_CLASS} border-[rgb(var(--accent-rgb)/0.55)] bg-[rgb(var(--accent-rgb)/0.18)] px-3 text-sm text-accent hover:bg-[rgb(var(--accent-rgb)/0.28)]`}
            onClick={(event) => {
              event.stopPropagation();
              handleCreateAiEditNode();
            }}
          >
            <Sparkles className="h-3.5 w-3.5" />
            {t('nodeToolbar.aiEdit')}
          </UiChipButton>
        )}
        */}
            {!isImageEdit && canHandleImage && (
              <UiChipButton
                key="image-panorama"
                className={TOOLBAR_TEXT_BUTTON_CLASS}
                onClick={(event) => {
                  event.stopPropagation();
                  closeDownloadMenu();
                  onOpenScene360(node.id);
                }}
              >
                <Globe2 className="h-3.5 w-3.5" />
                {t("nodeToolbar.panorama")}
              </UiChipButton>
            )}
            {!isImageEdit && canHandleImage && (
              <UiChipButton
                key="image-multi-dimension"
                className={TOOLBAR_TEXT_BUTTON_CLASS}
                onClick={(event) => {
                  event.stopPropagation();
                  closeDownloadMenu();
                  onOpenMultiAngleEditor(node.id);
                }}
              >
                <Boxes className="h-3.5 w-3.5" />
                {t("nodeToolbar.multiDimension")}
              </UiChipButton>
            )}
            {!isImageEdit && canHandleImage && (
              <UiChipButton
                key="image-relight"
                className={TOOLBAR_TEXT_BUTTON_CLASS}
                onClick={(event) => {
                  event.stopPropagation();
                  closeDownloadMenu();
                  onOpenLightEditor(node.id);
                }}
              >
                <Lightbulb className="h-3.5 w-3.5" />
                {t("nodeToolbar.relight")}
              </UiChipButton>
            )}
            {!isImageEdit &&
              canHandleImage &&
              tools.some((tool) => tool.type === NODE_TOOL_TYPES.crop) &&
              (() => {
                const editActions = [
                  {
                    key: "repaint" as const,
                    icon: Wand2,
                    label: t("nodeToolbar.repaint"),
                    run: () => onOpenRedraw(node.id),
                  },
                  {
                    key: "erase" as const,
                    icon: Eraser,
                    label: t("nodeToolbar.erase"),
                    run: () => {
                      closeDownloadMenu();
                      onOpenErase(node.id);
                    },
                  },
                  {
                    key: "matting" as const,
                    icon: Scissors,
                    label: t("nodeToolbar.matting"),
                    run: () => handleMatteImage(),
                  },
                  {
                    key: "crop" as const,
                    icon: Crop,
                    label: t("tool.crop"),
                    run: () =>
                      canvasEventBus.publish("tool-dialog/open", {
                        nodeId: node.id,
                        toolType: NODE_TOOL_TYPES.crop,
                      }),
                  },
                  {
                    key: "hd" as const,
                    icon: ImageUpscale,
                    label: t("nodeToolbar.hd"),
                    run: () => {
                      closeDownloadMenu();
                      onOpenUpscale(node.id);
                    },
                  },
                  {
                    key: "outpaint" as const,
                    icon: Expand,
                    label: t("nodeToolbar.outpaint"),
                    run: () => {
                      closeDownloadMenu();
                      onOpenOutpaint(node.id);
                    },
                  },
                ]
                  // HD/upscale mutates source in place
                  // (UpscaleEditorOverlay → updateNodeData(node.id, ...))
                  // so hide it from the edit-menu on preset_managed nodes.
                  // Repaint/Erase/Matting/Crop/Outpaint all spawn child
                  // nodes via inheritMainlineFields, safe to keep.
                  .filter((a) => !(isPresetLocked && a.key === "hd"));
                const active =
                  editActions.find((a) => a.key === activeEditAction) ??
                  editActions[Math.min(2, editActions.length - 1)];
                const ActiveIcon = active.icon;
                return (
                  <DropdownMenu {...editMenu.rootProps}>
                    <DropdownMenuTrigger asChild>
                      <UiChipButton
                        key="image-edit-menu"
                        className={TOOLBAR_TEXT_BUTTON_CLASS}
                        onClick={(event) => event.stopPropagation()}
                        {...editMenu.hoverProps}
                      >
                        <ActiveIcon className="h-3.5 w-3.5" />
                        {active.label}
                        <ChevronDown className="h-3 w-3" />
                      </UiChipButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="start"
                      sideOffset={6}
                      className={`${TOOLBAR_MENU_CONTENT_CLASS} min-w-[180px]`}
                      onClick={(event) => event.stopPropagation()}
                      {...editMenu.hoverProps}
                    >
                      {editActions.map((action) => {
                        const Icon = action.icon;
                        return (
                          <DropdownMenuItem
                            key={action.key}
                            className={TOOLBAR_MENU_ITEM_CLASS}
                            onSelect={() => {
                              setActiveEditAction(action.key);
                              action.run();
                            }}
                          >
                            <Icon className="h-4 w-4" />
                            {action.label}
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuContent>
                  </DropdownMenu>
                );
              })()}
            {!isImageEdit &&
              canHandleImage &&
              (() => {
                const gridActions: Array<{
                  key: GridActionKey;
                  icon: typeof Crop;
                  label: string;
                  prompt: string;
                  cost: number;
                }> = [
                  {
                    key: "multiCameraGrid",
                    icon: Grid3x3,
                    label: t("nodeToolbar.gridMenu.multiCameraGrid"),
                    prompt: t("nodeToolbar.gridMenu.multiCameraGridPrompt"),
                    cost: 14,
                  },
                  {
                    key: "plotFourGrid",
                    icon: Grid2x2,
                    label: t("nodeToolbar.gridMenu.plotFourGrid"),
                    prompt: t("nodeToolbar.gridMenu.plotFourGridPrompt"),
                    cost: 8,
                  },
                  {
                    key: "faceThreeView",
                    icon: User,
                    label: t("nodeToolbar.gridMenu.faceThreeView"),
                    prompt: t("nodeToolbar.gridMenu.faceThreeViewPrompt"),
                    cost: 6,
                  },
                  {
                    key: "productThreeView",
                    icon: Package,
                    label: t("nodeToolbar.gridMenu.productThreeView"),
                    prompt: t("nodeToolbar.gridMenu.productThreeViewPrompt"),
                    cost: 6,
                  },
                  {
                    key: "serialStoryboard25",
                    icon: LayoutDashboard,
                    label: t("nodeToolbar.gridMenu.serialStoryboard25"),
                    prompt: t("nodeToolbar.gridMenu.serialStoryboard25Prompt"),
                    cost: 32,
                  },
                  {
                    key: "cinematicLightCorrection",
                    icon: Film,
                    label: t("nodeToolbar.gridMenu.cinematicLightCorrection"),
                    prompt: t(
                      "nodeToolbar.gridMenu.cinematicLightCorrectionPrompt",
                    ),
                    cost: 4,
                  },
                  {
                    key: "characterThreeView",
                    icon: Users,
                    label: t("nodeToolbar.gridMenu.characterThreeView"),
                    prompt: t("nodeToolbar.gridMenu.characterThreeViewPrompt"),
                    cost: 6,
                  },
                  {
                    key: "frameProjection3sLater",
                    icon: FastForward,
                    label: t("nodeToolbar.gridMenu.frameProjection3sLater"),
                    prompt: t(
                      "nodeToolbar.gridMenu.frameProjection3sLaterPrompt",
                    ),
                    cost: 4,
                  },
                  {
                    key: "frameProjection5sEarlier",
                    icon: Rewind,
                    label: t("nodeToolbar.gridMenu.frameProjection5sEarlier"),
                    prompt: t(
                      "nodeToolbar.gridMenu.frameProjection5sEarlierPrompt",
                    ),
                    cost: 4,
                  },
                ];
                return (
                  <DropdownMenu {...gridMenu.rootProps}>
                    <DropdownMenuTrigger asChild>
                      <UiChipButton
                        key="image-grid-menu"
                        className={TOOLBAR_TEXT_BUTTON_CLASS}
                        onClick={(event) => event.stopPropagation()}
                        {...gridMenu.hoverProps}
                      >
                        <LayoutGrid className="h-3.5 w-3.5" />
                        {t("nodeToolbar.gridMenu.trigger")}
                        <ChevronDown className="h-3 w-3" />
                      </UiChipButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="start"
                      sideOffset={6}
                      className={`${TOOLBAR_MENU_CONTENT_CLASS} min-w-[200px]`}
                      onClick={(event) => event.stopPropagation()}
                      {...gridMenu.hoverProps}
                    >
                      {gridActions.map((action) => {
                        const Icon = action.icon;
                        const isActive = action.key === activeGridAction;
                        return (
                          <DropdownMenuItem
                            key={action.key}
                            className={
                              isActive
                                ? "gap-2 bg-[rgb(var(--accent-rgb)/0.18)] text-accent focus:bg-[rgb(var(--accent-rgb)/0.28)] focus:text-accent"
                                : TOOLBAR_MENU_ITEM_CLASS
                            }
                            onSelect={() => {
                              setActiveGridAction(action.key);
                              onOpenGridAction({
                                nodeId: node.id,
                                key: action.key,
                                label: action.label,
                                prompt: action.prompt,
                                cost: action.cost,
                              });
                            }}
                          >
                            <Icon className="h-4 w-4" />
                            {action.label}
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuContent>
                  </DropdownMenu>
                );
              })()}
            {!isImageEdit && canHandleImage && <ToolbarDivider />}
            {!isImageEdit &&
              tools
                .filter((tool) => tool.type !== NODE_TOOL_TYPES.crop)
                .map((tool) => {
                  const Icon = toolIconMap[tool.icon] ?? Crop;
                  const label = resolveToolLabel(tool.type);
                  const isAnnotate = tool.type === NODE_TOOL_TYPES.annotate;

                  if (isAnnotate) {
                    return (
                      <ToolbarIconChip
                        key={tool.type}
                        label={label}
                        icon={Icon}
                        onClick={() =>
                          canvasEventBus.publish("tool-dialog/open", {
                            nodeId: node.id,
                            toolType: tool.type,
                          })
                        }
                      />
                    );
                  }

                  return (
                    <UiChipButton
                      key={tool.type}
                      className={TOOLBAR_TEXT_BUTTON_CLASS}
                      onClick={() =>
                        canvasEventBus.publish("tool-dialog/open", {
                          nodeId: node.id,
                          toolType: tool.type,
                        })
                      }
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {label}
                    </UiChipButton>
                  );
                })}
            {!isImageEdit && canHandleImage && !isPresetLocked && (
              // Hidden on preset_managed nodes — Rotate mutates the source
              // image in place (RotateEditorOverlay calls updateNodeData(node.id, ...))
              // which would violate canonical immutability. Same for HD/upscale
              // below (filtered out of the edit-menu dropdown when locked).
              <ToolbarIconChip
                key="image-rotate"
                label={t("nodeToolbar.rotate")}
                icon={RotateCw}
                onClick={(event) => {
                  event.stopPropagation();
                  closeDownloadMenu();
                  onOpenRotate(node.id);
                }}
              />
            )}
            {/* 重新上传按钮暂时隐藏（保留代码，等需求恢复时取消注释）
        {!isImageEdit && canReupload && (
          <UiChipButton
            key="upload-reupload"
            className={TOOLBAR_TEXT_BUTTON_CLASS}
            onClick={() =>
              canvasEventBus.publish('upload-node/reupload', {
                nodeId: node.id,
              })
            }
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t('nodeToolbar.reupload')}
          </UiChipButton>
        )}
        */}
            {/* 复制图片按钮暂时隐藏（保留代码，等需求恢复时取消注释）
        {!isImageEdit && canHandleImage && (
          <UiChipButton
            key="image-copy"
            className={`h-9 ${TOOLBAR_BUTTON_RADIUS_CLASS} px-3 text-sm ${TOOLBAR_NEUTRAL_BUTTON_CLASS} ${
              isCopySuccess
                ? '!border-emerald-400/70 !bg-emerald-500/20 !text-emerald-200 hover:!bg-emerald-500/30'
                : ''
            }`}
            onClick={() => {
              void handleCopyImage();
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            {t('nodeToolbar.copy')}
          </UiChipButton>
        )}
        */}
            {!isImageEdit && canCopyStoryboardText && (
              <UiChipButton
                key="storyboard-text-copy"
                className={`${TOOLBAR_TEXT_BUTTON_CLASS} ${
                  isCopyTextSuccess
                    ? "!border-emerald-400/70 !bg-emerald-500/20 !text-emerald-200 hover:!bg-emerald-500/30"
                    : ""
                }`}
                onClick={() => {
                  void handleCopyStoryboardText();
                }}
              >
                <Copy className="h-3.5 w-3.5" />
                {t("nodeToolbar.copyText")}
              </UiChipButton>
            )}
            {!isImageEdit && canCopyGenerationError && (
              <UiChipButton
                key="generation-error-copy"
                className={`${TOOLBAR_TEXT_BUTTON_CLASS} ${
                  isCopyErrorSuccess
                    ? "!border-emerald-400/70 !bg-emerald-500/20 !text-emerald-200 hover:!bg-emerald-500/30"
                    : "!border-red-500/45 !bg-red-500/15 !text-red-200 hover:!bg-red-500/25"
                }`}
                onClick={() => {
                  void handleCopyGenerationError();
                }}
              >
                <Copy className="h-3.5 w-3.5" />
                {isCopyErrorSuccess
                  ? t("nodeToolbar.copied")
                  : t("nodeToolbar.copyErrorReport")}
              </UiChipButton>
            )}
            {!isImageEdit && canHandleImage && (
              <ToolbarIconChip
                key="image-download"
                label={t("nodeToolbar.download")}
                icon={Download}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleDownloadSaveAs();
                }}
              />
            )}
            {isVideoNode(node) &&
              (() => {
                const videoData = node.data;
                const videoUrl =
                  typeof videoData.videoUrl === "string"
                    ? videoData.videoUrl
                    : null;
                const isAnalyzing = Boolean(videoData.isAnalyzing);
                const hasVideo = Boolean(videoUrl);
                const stubButtonClass = TOOLBAR_TEXT_BUTTON_CLASS;

                const handleVideoStub = (label: string) => {
                  console.info(
                    `[video-toolbar] stub action triggered: ${label}`,
                  );
                };

                const handleVideoAnalyze = async () => {
                  if (!hasVideo || !videoUrl || isAnalyzing) {
                    return;
                  }
                  const projectId = readUrl().project;
                  if (!projectId) {
                    console.error("[video-analyze] no project in URL");
                    return;
                  }
                  updateNodeData(node.id, {
                    isAnalyzing: true,
                    analysisError: null,
                  });

                  // 立即在下游建一个 loading 态的视频故事节点 —— 不等后端返回。
                  // 数据回来后再 updateNodeData 把分镜填进去；失败则把错误写到该节点。
                  const storyPosition = findNodePosition(node.id, 720, 360);
                  const storyNodeId = addNode(
                    CANVAS_NODE_TYPES.videoStory,
                    storyPosition,
                    {
                      sourceVideoUrl: videoUrl,
                      rows: [],
                      rawResult: null,
                      isAnalyzing: true,
                      analysisStartedAt: Date.now(),
                      analysisError: null,
                    },
                  );
                  addEdge(node.id, storyNodeId);

                  try {
                    const durationSec =
                      typeof videoData.durationMs === "number" && videoData.durationMs > 0
                        ? videoData.durationMs / 1000
                        : undefined;
                    const submitResp = (await submitFreezoneAnalyzeVideoStory(
                      projectId,
                      { videoUrl, durationSec },
                    )) as unknown;
                    console.info("[video-analyze] submit response", submitResp);

                    const submitRecord =
                      submitResp && typeof submitResp === "object"
                        ? (submitResp as Record<string, unknown>)
                        : {};
                    const taskKey =
                      typeof submitRecord.task_key === "string"
                        ? submitRecord.task_key
                        : null;

                    let rawResult: Record<string, unknown>;
                    if (taskKey) {
                      const completed = await awaitTaskCompletion(taskKey, projectId);
                      console.info(
                        "[video-analyze] task completed",
                        completed.result,
                      );
                      rawResult = (completed.result ?? {}) as Record<string, unknown>;
                    } else {
                      // Endpoint returned the result synchronously (OpenAPI 200 is `{}` —
                      // not guaranteed to be the async FreezoneJobAcceptedResponse).
                      console.info(
                        "[video-analyze] no task_key, treating response as inline result",
                      );
                      rawResult = submitRecord;
                    }

                    const rows = normalizeVideoStoryRows(rawResult);
                    console.info(
                      "[video-analyze] normalized rows",
                      rows.length,
                      rows,
                    );

                    // 把解析结果回填到先前创建的 loading 故事节点。
                    updateNodeData(storyNodeId, {
                      rows,
                      rawResult,
                      isAnalyzing: false,
                      analysisError: null,
                    });
                    updateNodeData(node.id, {
                      isAnalyzing: false,
                      analysisError: null,
                    });
                  } catch (error) {
                    const message =
                      error instanceof Error ? error.message : String(error);
                    console.error("[video-analyze] failed", error);
                    // 把错误写到下游故事节点,清掉它的 loading 态。
                    updateNodeData(storyNodeId, {
                      isAnalyzing: false,
                      analysisError: message,
                    });
                    updateNodeData(node.id, {
                      isAnalyzing: false,
                      analysisError: message,
                    });
                  }
                };

                const handleVideoDownload = async () => {
                  if (!hasVideo || !videoUrl) {
                    return;
                  }
                  try {
                    const sourceFileName =
                      typeof videoData.sourceFileName === "string" && videoData.sourceFileName.trim().length > 0
                        ? videoData.sourceFileName
                        : typeof videoData.displayName === "string" && videoData.displayName.trim().length > 0
                          ? `${videoData.displayName}.mp4`
                          : `video-${node.id}.mp4`;
                    await downloadUrlAsFile(
                      resolveImageDisplayUrl(videoUrl),
                      sourceFileName,
                    );
                  } catch (error) {
                    console.error("[video-download] failed", error);
                  }
                };

                const handleVideoFullscreen = () => {
                  if (!hasVideo || !videoUrl) {
                    return;
                  }
                  canvasEventBus.publish("video-viewer/open", {
                    videoUrl,
                    title:
                      typeof videoData.displayName === "string"
                        ? videoData.displayName
                        : undefined,
                  });
                };

                // 「高清」：在下游建一个视频节点（复用 video 节点的播放器/角标/尺寸，
                // 与普通视频节点一致），以本视频为源、打 isUpscaleNode 标记 —— 选中后在
                // 其下方展开 VideoUpscaleEditorOverlay 配置面板，提交走 /freezone/video/upscale。
                const handleVideoUpscale = () => {
                  if (!hasVideo || !videoUrl) {
                    return;
                  }
                  const position = findNodePosition(node.id, 580, 380);
                  const upscaleNodeId = addNode(
                    CANVAS_NODE_TYPES.video,
                    position,
                    {
                      displayName: `${t("node.videoUpscale.nodeTitle")}（1080P）`,
                      videoUrl: null,
                      previewImageUrl:
                        typeof videoData.previewImageUrl === "string"
                          ? videoData.previewImageUrl
                          : null,
                      aspectRatio:
                        typeof videoData.aspectRatio === "string"
                          ? videoData.aspectRatio
                          : "16:9",
                      isUpscaleNode: true,
                      upscaleSourceUrl: videoUrl,
                      upscaleResolution: "1080p",
                      upscaleDenoise: "1x",
                      isGenerating: false,
                    } as unknown as Parameters<typeof addNode>[2],
                  );
                  addEdge(node.id, upscaleNodeId);
                  onNodesChange([
                    { id: node.id, type: "select", selected: false },
                    { id: upscaleNodeId, type: "select", selected: true },
                  ]);
                  setSelectedNode(upscaleNodeId);
                };

                const isSeparatingAv = Boolean(videoData.isSeparatingAv);

                const handleAudioSeparate = async () => {
                  if (!hasVideo || !videoUrl || isSeparatingAv) {
                    return;
                  }
                  const projectId = readUrl().project;
                  if (!projectId) {
                    console.error("[audio-separate] no project in URL");
                    return;
                  }
                  updateNodeData(node.id, { isSeparatingAv: true });
                  try {
                    const ref = await submitFreezoneAudioSeparate(
                      projectId,
                      { sourceUrl: videoUrl },
                    );
                    const completed = await awaitTaskCompletion(ref.task_key, projectId);
                    console.info(
                      "[audio-separate] task completed",
                      completed.result,
                    );

                    // Walk an arbitrary JSON tree and pull every string that
                    // looks like a URL/path. Backend hasn't typed the result
                    // schema, so we can't rely on key names alone.
                    const collectStrings = (
                      value: unknown,
                      out: string[],
                    ): void => {
                      if (typeof value === "string") {
                        if (value.length > 0) out.push(value);
                        return;
                      }
                      if (Array.isArray(value)) {
                        for (const item of value) collectStrings(item, out);
                        return;
                      }
                      if (value && typeof value === "object") {
                        for (const item of Object.values(
                          value as Record<string, unknown>,
                        )) {
                          collectStrings(item, out);
                        }
                      }
                    };

                    // Fallback only: some legacy results carry a backend
                    // filesystem path (e.g. `/data/output/<user>/<project>/...`)
                    // instead of a servable URL. Rewriting `<...>/output/` into
                    // `/static/<user>/<project>/...` yields the LEGACY scheme,
                    // which production now rejects with 410 — so this is used
                    // strictly as a last resort when no `*_url` field exists.
                    const toStaticUrl = (raw: string): string => {
                      if (!raw) return raw;
                      if (
                        raw.startsWith("/static/") ||
                        raw.startsWith("http://") ||
                        raw.startsWith("https://") ||
                        raw.startsWith("blob:") ||
                        raw.startsWith("data:")
                      ) {
                        return raw;
                      }
                      const outputIdx = raw.lastIndexOf("/output/");
                      if (outputIdx >= 0) {
                        return `/static/${raw.slice(outputIdx + "/output/".length)}`;
                      }
                      return raw;
                    };

                    const pickUrlField = (
                      source: Record<string, unknown>,
                      keys: string[],
                    ): string | null => {
                      for (const key of keys) {
                        const value = source[key];
                        if (typeof value === "string" && value.length > 0) {
                          return value;
                        }
                      }
                      return null;
                    };

                    const classify = (
                      source: Record<string, unknown> | null | undefined,
                    ): { audio: string | null; video: string | null } => {
                      if (!source)
                        return { audio: null, video: null };

                      // Prefer the backend-provided canonical URLs. The result
                      // carries BOTH a filesystem `*_path`
                      // (`/data/output/<user>/<project>/...`) and a
                      // ready-to-serve `*_url` (`/static/projects/<project_id>/...`).
                      // Only the `*_url` form is reachable online — OpenResty
                      // returns 410 for legacy `/static/<user>/<project>/...`.
                      // Never derive a URL from `*_path`.
                      let audio = pickUrlField(source, ["audio_url", "audioUrl"]);
                      let video = pickUrlField(source, [
                        "mute_video_url",
                        "muteVideoUrl",
                      ]);

                      // Fallback heuristic for results that don't carry explicit
                      // URL fields: walk the tree and pick by extension,
                      // preferring already-servable `/static`/http URLs over raw
                      // filesystem paths so we never reconstruct a legacy URL.
                      if (!audio || !video) {
                        const strings: string[] = [];
                        collectStrings(source, strings);
                        const isServable = (s: string) =>
                          s.startsWith("/static/") ||
                          s.startsWith("http://") ||
                          s.startsWith("https://");
                        strings.sort(
                          (a, b) =>
                            Number(isServable(b)) - Number(isServable(a)),
                        );
                        const audioExt =
                          /\.(mp3|m4a|aac|wav|flac|ogg|opus)(\?|$)/i;
                        const videoExt =
                          /\.(mp4|mov|webm|mkv|avi|m4v)(\?|$)/i;
                        for (const s of strings) {
                          if (
                            !audio &&
                            (audioExt.test(s) || /audio|sound/i.test(s))
                          ) {
                            audio = s;
                          } else if (
                            !video &&
                            (videoExt.test(s) ||
                              /silent|mute|no[_-]?audio|video/i.test(s))
                          ) {
                            video = s;
                          }
                          if (audio && video) break;
                        }
                      }

                      return {
                        audio: audio ? toStaticUrl(audio) : null,
                        video: video ? toStaticUrl(video) : null,
                      };
                    };

                    let { audio: audioOutputUrl, video: silentVideoOutputUrl } =
                      classify(
                        (completed.result ?? null) as Record<
                          string,
                          unknown
                        > | null,
                      );

                    // Fallback: hit the dedicated job-result endpoint when SSE
                    // result didn't carry the URLs (some freezone task types
                    // surface artifacts only via /jobs/.../result).
                    if (!audioOutputUrl || !silentVideoOutputUrl) {
                      try {
                        const jobResult =
                          await fetchFreezoneAudioSeparateResult(
                            projectId,
                            ref.job_id,
                          );
                        console.info(
                          "[audio-separate] job result",
                          jobResult,
                        );
                        const classified = classify(jobResult);
                        audioOutputUrl = audioOutputUrl ?? classified.audio;
                        silentVideoOutputUrl =
                          silentVideoOutputUrl ?? classified.video;
                      } catch (jobErr) {
                        console.warn(
                          "[audio-separate] job result fetch failed",
                          jobErr,
                        );
                      }
                    }

                    if (!audioOutputUrl || !silentVideoOutputUrl) {
                      console.warn(
                        "[audio-separate] could not resolve audio/video urls",
                        { sseResult: completed.result },
                      );
                      return;
                    }
                    console.info("[audio-separate] resolved urls", {
                      audioOutputUrl,
                      silentVideoOutputUrl,
                    });
                    const rawName =
                      typeof videoData.sourceFileName === "string" &&
                      videoData.sourceFileName.trim().length > 0
                        ? videoData.sourceFileName
                        : typeof videoData.displayName === "string" &&
                            videoData.displayName.trim().length > 0
                          ? videoData.displayName
                          : "video";
                    const baseName = rawName.replace(/\.[^/.]+$/, "");
                    const audioTitle = `${baseName}_背景音`;
                    const silentTitle = `${baseName}_无声`;

                    const audioPos = findNodePosition(node.id, 480, 180);
                    const audioNodeId = addNode(
                      CANVAS_NODE_TYPES.audio,
                      audioPos,
                      {
                        audioUrl: audioOutputUrl,
                        sourceFileName: audioTitle,
                        displayName: audioTitle,
                      },
                    );
                    addEdge(node.id, audioNodeId);

                    const silentPos = findNodePosition(node.id, 480, 270);
                    const silentNodeId = addNode(
                      CANVAS_NODE_TYPES.video,
                      silentPos,
                      {
                        videoUrl: silentVideoOutputUrl,
                        sourceFileName: `${silentTitle}.mp4`,
                        displayName: silentTitle,
                      },
                    );
                    addEdge(node.id, silentNodeId);
                  } catch (error) {
                    console.error("[audio-separate] failed", error);
                  } finally {
                    updateNodeData(node.id, { isSeparatingAv: false });
                  }
                };

                return (
                  <>
                    <UiChipButton
                      key="video-clip"
                      className={`${stubButtonClass} ${!hasVideo ? "opacity-50 cursor-not-allowed" : ""}`}
                      title={
                        !hasVideo
                          ? t("nodeToolbar.video.requiresVideo")
                          : undefined
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        if (!hasVideo) return;
                        updateNodeData(node.id, {
                          isClipMode: !videoData.isClipMode,
                        });
                      }}
                    >
                      <Scissors className="h-3.5 w-3.5" />
                      {t("nodeToolbar.video.clip")}
                    </UiChipButton>
                    <UiChipButton
                      key="video-hd"
                      className={`${stubButtonClass} ${!hasVideo ? "opacity-50 cursor-not-allowed" : ""}`}
                      title={
                        !hasVideo
                          ? t("nodeToolbar.video.requiresVideo")
                          : undefined
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        handleVideoUpscale();
                      }}
                    >
                      <ImageUpscale className="h-3.5 w-3.5" />
                      {t("nodeToolbar.video.hd")}
                    </UiChipButton>
                    <UiChipButton
                      key="video-analyze"
                      className={`${stubButtonClass} ${!hasVideo ? "opacity-50 cursor-not-allowed" : ""}`}
                      title={
                        !hasVideo
                          ? t("nodeToolbar.video.requiresVideo")
                          : undefined
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleVideoAnalyze();
                      }}
                    >
                      {isAnalyzing ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Wand2 className="h-3.5 w-3.5" />
                      )}
                      {t("nodeToolbar.video.analyze")}
                    </UiChipButton>
                    <DropdownMenu
                      onOpenChange={(open) => {
                        if (open) closeDownloadMenu();
                      }}
                    >
                      <DropdownMenuTrigger asChild>
                        <UiChipButton
                          key="video-subtitle-removal"
                          className={stubButtonClass}
                          title={t("nodeToolbar.video.subtitleRemovalTip")}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <Eraser className="h-3.5 w-3.5" />
                          {t("nodeToolbar.video.subtitleRemoval")}
                          <ChevronDown className="h-3 w-3" />
                        </UiChipButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="start"
                        sideOffset={6}
                        className={`${TOOLBAR_MENU_CONTENT_CLASS} min-w-[180px]`}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <DropdownMenuItem
                          className={TOOLBAR_MENU_ITEM_CLASS}
                          onSelect={() => {
                            if (!hasVideo) {
                              handleVideoStub("subtitle-smart-erase");
                              return;
                            }
                            updateNodeData(node.id, {
                              subtitleEraseMode: 'smart',
                              subtitleEraseBox: null,
                              isClipMode: false,
                            });
                            setSelectedNode(node.id);
                          }}
                        >
                          <Wand2 className="h-4 w-4" />
                          {t("nodeToolbar.video.subtitleRemovalSmart")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className={TOOLBAR_MENU_ITEM_CLASS}
                          onSelect={() => {
                            if (!hasVideo) {
                              handleVideoStub("subtitle-box-erase");
                              return;
                            }
                            updateNodeData(node.id, {
                              subtitleEraseMode: 'box',
                              subtitleEraseBox: null,
                              isClipMode: false,
                            });
                            setSelectedNode(node.id);
                          }}
                        >
                          <Crop className="h-4 w-4" />
                          {t("nodeToolbar.video.subtitleRemovalBox")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <UiChipButton
                      key="video-separate-av"
                      className={`${stubButtonClass} ${
                        !hasVideo || isSeparatingAv
                          ? "opacity-50 cursor-not-allowed"
                          : ""
                      }`}
                      title={
                        !hasVideo
                          ? t("nodeToolbar.video.requiresVideo")
                          : undefined
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleAudioSeparate();
                      }}
                    >
                      {isSeparatingAv ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <VideoIcon className="h-3.5 w-3.5" />
                      )}
                      {t("nodeToolbar.video.separateAudioVideo")}
                    </UiChipButton>
                    <UiChipButton
                      key="video-download"
                      className={`${stubButtonClass} !px-2 ${!hasVideo ? "opacity-50 cursor-not-allowed" : ""}`}
                      title={
                        !hasVideo
                          ? t("nodeToolbar.video.requiresVideo")
                          : t("nodeToolbar.download")
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleVideoDownload();
                      }}
                    >
                      <Download className="h-3.5 w-3.5" />
                    </UiChipButton>
                    <UiChipButton
                      key="video-fullscreen"
                      className={`${stubButtonClass} !px-2 ${!hasVideo ? "opacity-50 cursor-not-allowed" : ""}`}
                      title={
                        !hasVideo
                          ? t("nodeToolbar.video.requiresVideo")
                          : t("nodeToolbar.video.fullscreen")
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        handleVideoFullscreen();
                      }}
                    >
                      <Maximize2 className="h-3.5 w-3.5" />
                    </UiChipButton>
                  </>
                );
              })()}
            {isAudioNode(node) &&
              (() => {
                const audioData = node.data;
                const audioUrl =
                  typeof audioData.audioUrl === "string"
                    ? audioData.audioUrl
                    : null;
                const hasAudio = Boolean(audioUrl);
                const audioButtonClass = TOOLBAR_TEXT_BUTTON_CLASS;
                const sourceExt = audioUrl ? getAudioExtFromUrl(audioUrl) : "";
                const convertingFormat =
                  typeof audioData.convertingAudioFormat === "string"
                    ? (audioData.convertingAudioFormat as AudioDownloadFormat)
                    : null;
                const isConverting = Boolean(convertingFormat);

                // The separated-audio node stores `sourceFileName` WITHOUT an
                // extension (e.g. `xxx_背景音`), which previously produced an
                // extensionless download the OS couldn't open. Strip any trailing
                // audio extension and re-append the chosen format below.
                const baseFileName = (() => {
                  const raw =
                    typeof audioData.sourceFileName === "string" &&
                    audioData.sourceFileName.trim().length > 0
                      ? audioData.sourceFileName.trim()
                      : typeof audioData.displayName === "string" &&
                          audioData.displayName.trim().length > 0
                        ? audioData.displayName.trim()
                        : `audio-${node.id}`;
                  return raw.replace(
                    /\.(mp3|m4a|aac|wav|flac|ogg|opus|mp4|m4b)$/i,
                    "",
                  );
                })();

                const handleAudioDownload = async (
                  format: AudioDownloadFormat,
                ) => {
                  if (!hasAudio || !audioUrl || isConverting) {
                    return;
                  }
                  if (!canProduceFormat(format, sourceExt)) {
                    toast.error(t("nodeToolbar.audio.m4aSourceOnly"));
                    return;
                  }
                  const filename = `${baseFileName}.${format}`;
                  const resolvedUrl = resolveImageDisplayUrl(audioUrl);
                  // Passthrough (target container == source): download original
                  // bytes via downloadUrlAsFile (robust cross-origin fallback +
                  // correct extension), no lossy re-encode.
                  const passthrough =
                    format === sourceExt ||
                    (format === "m4a" && canProduceFormat("m4a", sourceExt));
                  if (passthrough) {
                    try {
                      await downloadUrlAsFile(resolvedUrl, filename);
                    } catch (error) {
                      console.error("[audio-download] passthrough failed", error);
                      toast.error(t("nodeToolbar.audio.downloadFailed"));
                    }
                    return;
                  }
                  updateNodeData(node.id, { convertingAudioFormat: format });
                  try {
                    const resp = await fetch(resolvedUrl);
                    if (!resp.ok) {
                      throw new Error(`fetch failed: ${resp.status}`);
                    }
                    const srcBlob = await resp.blob();
                    const outBlob = await transcodeAudio(
                      srcBlob,
                      sourceExt,
                      format,
                    );
                    downloadBlobAsFile(outBlob, filename);
                  } catch (error) {
                    console.error("[audio-download] transcode failed", error);
                    toast.error(t("nodeToolbar.audio.downloadFailed"));
                  } finally {
                    updateNodeData(node.id, { convertingAudioFormat: null });
                  }
                };

                return (
                  <DropdownMenu
                    onOpenChange={(open) => {
                      if (open) closeDownloadMenu();
                    }}
                  >
                    <DropdownMenuTrigger asChild>
                      <UiChipButton
                        key="audio-download"
                        className={`${audioButtonClass} ${
                          !hasAudio ? "opacity-50 cursor-not-allowed" : ""
                        }`}
                        title={
                          !hasAudio
                            ? t("nodeToolbar.audio.requiresAudio")
                            : t("nodeToolbar.download")
                        }
                        onClick={(event) => event.stopPropagation()}
                      >
                        {isConverting ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Download className="h-3.5 w-3.5" />
                        )}
                        {t("nodeToolbar.download")}
                        <ChevronDown className="h-3 w-3" />
                      </UiChipButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="start"
                      sideOffset={6}
                      className={`${TOOLBAR_MENU_CONTENT_CLASS} min-w-[170px]`}
                      onClick={(event) => event.stopPropagation()}
                    >
                      {AUDIO_DOWNLOAD_FORMATS.map((format) => {
                        const available = canProduceFormat(format, sourceExt);
                        return (
                          <DropdownMenuItem
                            key={format}
                            disabled={!hasAudio || !available || isConverting}
                            className={TOOLBAR_MENU_ITEM_CLASS}
                            onSelect={() => {
                              void handleAudioDownload(format);
                            }}
                          >
                            {convertingFormat === format ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Download className="h-4 w-4" />
                            )}
                            <span className="flex-1">
                              {t("nodeToolbar.audio.downloadAs", {
                                format: format.toUpperCase(),
                              })}
                            </span>
                            {!available ? (
                              <span className="text-[10px] opacity-60">
                                {t("nodeToolbar.audio.m4aSourceOnlyHint")}
                              </span>
                            ) : null}
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuContent>
                  </DropdownMenu>
                );
              })()}
            {!isImageEdit && isUngroupableGroup && (() => {
              const groupColor = groupBackgroundColor;
              return (
                <>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <UiChipButton
                        key="group-color"
                        className={TOOLBAR_TEXT_BUTTON_CLASS}
                        title="组背景色"
                        onClick={(event) => event.stopPropagation()}
                      >
                        {groupColor ? (
                          <span
                            className="h-3.5 w-3.5 rounded-full border border-white/40"
                            style={{ backgroundColor: groupColor }}
                          />
                        ) : (
                          <Palette className="h-3.5 w-3.5" />
                        )}
                        背景色
                        <ChevronDown className="h-3 w-3" />
                      </UiChipButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="start"
                      sideOffset={6}
                      className={TOOLBAR_MENU_CONTENT_CLASS}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <div className="grid grid-cols-5 gap-1.5 p-1.5">
                        <button
                          type="button"
                          title="无"
                          onClick={() => updateNodeData(nodeId, { backgroundColor: null })}
                          className={`relative flex h-6 w-6 items-center justify-center rounded-full border bg-transparent transition-transform hover:scale-110 ${
                            groupColor ? 'border-white/25' : 'border-white ring-1 ring-white/60'
                          }`}
                        >
                          <span className="absolute h-[1.5px] w-4 rotate-45 rounded bg-rose-400/80" />
                        </button>
                        {GROUP_COLOR_PRESETS.map((preset) => (
                          <button
                            key={preset.key}
                            type="button"
                            title={preset.label}
                            onClick={() =>
                              updateNodeData(nodeId, { backgroundColor: preset.value })
                            }
                            className={`h-6 w-6 rounded-full border-2 transition-transform hover:scale-110 ${
                              groupColor === preset.value
                                ? 'border-white'
                                : 'border-transparent'
                            }`}
                            style={{ backgroundColor: preset.value }}
                          />
                        ))}
                      </div>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <UiChipButton
                        key="group-arrange"
                        className={TOOLBAR_TEXT_BUTTON_CLASS}
                        title="排列方式"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <LayoutGrid className="h-3.5 w-3.5" />
                        排列
                        <ChevronDown className="h-3 w-3" />
                      </UiChipButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="start"
                      sideOffset={6}
                      className={`${TOOLBAR_MENU_CONTENT_CLASS} min-w-[120px]`}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <DropdownMenuItem
                        className={TOOLBAR_MENU_ITEM_CLASS}
                        onSelect={() => arrangeGroupChildren(nodeId, 'grid')}
                      >
                        网格
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className={TOOLBAR_MENU_ITEM_CLASS}
                        onSelect={() => arrangeGroupChildren(nodeId, 'horizontal')}
                      >
                        横向排列
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className={TOOLBAR_MENU_ITEM_CLASS}
                        onSelect={() => arrangeGroupChildren(nodeId, 'vertical')}
                      >
                        纵向排列
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <UiChipButton
                    key="group-ungroup"
                    className={`${TOOLBAR_TEXT_BUTTON_CLASS} hover:!border-amber-400/60 hover:!bg-amber-500/20 hover:!text-amber-200`}
                    onClick={(event) => {
                      event.stopPropagation();
                      closeDownloadMenu();
                      ungroupNode(nodeId);
                    }}
                  >
                    <Unlink2 className="h-3.5 w-3.5" />
                    {t("nodeToolbar.ungroup")}
                  </UiChipButton>
                </>
              );
            })()}
            {protectedProjectionKey && (
              <UiChipButton
                key="projection-refresh"
                className={
                  projectionIsStale
                    ? `${TOOLBAR_TEXT_BUTTON_CLASS} !border-amber-300/60 !bg-amber-300/15 !text-amber-100 hover:!bg-amber-300/20`
                    : TOOLBAR_TEXT_BUTTON_CLASS
                }
                title={
                  projectionIsStale
                    ? t("freezone.projections.staleBadge")
                    : undefined
                }
                onClick={(event) => {
                  event.stopPropagation();
                  closeDownloadMenu();
                  canvasEventBus.publish("freezone/projection-sync", {
                    projectionKey: protectedProjectionKey,
                  });
                }}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {projectionIsStale
                  ? t("freezone.projections.syncStale")
                  : t("freezone.projections.sync")}
              </UiChipButton>
            )}
            {!isImageGenNode(node) && !isVideoNode(node) && !isAudioNode(node) && (
              <UiChipButton
                key="node-delete"
                className={`h-9 ${TOOLBAR_BUTTON_RADIUS_CLASS} !border-transparent !bg-transparent px-3 text-sm text-rose-200/85 hover:!bg-white/[0.08] hover:!text-rose-100`}
                onClick={(event) => {
                  event.stopPropagation();
                  closeDownloadMenu();
                  if (protectedProjectionKey) {
                    canvasEventBus.publish("freezone/projection-remove", {
                      projectionKey: protectedProjectionKey,
                    });
                    return;
                  }
                  deleteNode(node.id);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {protectedProjectionKey
                  ? t("freezone.projections.remove")
                  : t("common.delete")}
              </UiChipButton>
            )}
            {canCommitNode && (
              <UiChipButton
                key="node-commit"
                className={TOOLBAR_TEXT_BUTTON_CLASS}
                onClick={(event) => {
                  event.stopPropagation();
                  closeDownloadMenu();
                  canvasEventBus.publish("freezone/commit-node", {
                    nodeId: node.id,
                  });
                }}
                title="把当前节点的内容写回主流程资产"
              >
                <Send className="h-3.5 w-3.5" />
                提交
              </UiChipButton>
            )}
          </UiPanel>
          </ZoomScaledToolbar>
        </ReactFlowNodeToolbar>
      </>
    );
  },
);

NodeActionToolbar.displayName = "NodeActionToolbar";
