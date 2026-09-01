// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Film,
  Languages,
  Library,
  Loader2,
  Music,
  Pause,
  Plus,
  Volume2,
  VolumeX,
} from "lucide-react";

import type {
  Seedance2SceneOptimize,
  VideoGenCount,
  VideoGenMode,
  VideoGenQuality,
  VideoNodeData,
} from "@/features/canvas/domain/canvasNodes";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import type { UpstreamContent } from "@/features/canvas/application/ports";
import type {
  FreezoneVideoAspectRatio,
  MediaModelParameterDefinition,
} from "@/api/ops";
import { useModelTaskAccess } from "@/lib/model-task-access";
import { useCanvasStore } from "@/stores/canvasStore";
import { ReferenceTextChip } from "@/features/canvas/nodes/shared/ReferenceTextChip";
import { ReferenceDetachButton } from "@/features/canvas/nodes/shared/ReferenceDetachButton";
import {
  clampVideoDuration,
  isHappyHorseVideoModel,
  type ReferenceMediaCapEntry,
  type ReferenceMediaItem,
} from "@/features/canvas/nodes/shared/videoFormOptions";
import {
  isVideoModeSupportedByModel,
  videoModelReferenceDisabledReason,
} from "@/features/canvas/nodes/shared/videoModelCapabilities";
import {
  PromptMentionEditor,
  type MentionCandidate,
  type PromptMentionEditorHandle,
} from "@/features/canvas/nodes/PromptMentionEditor";
import { NodeContextPromptPaletteButton } from "@/features/canvas/nodes/ContextPromptPaletteButton";
import {
  contextPromptPaletteInsertionText,
  type ContextPromptPaletteEntry,
} from "@/features/canvas/nodes/contextPromptPalette";
import { CameraMovementPickerPopover } from "@/features/canvas/nodes/CameraMovementPickerPopover";
import {
  findCameraMovementPreset,
  type CameraMovementPreset,
} from "@/features/canvas/domain/cameraMovementPresets";
import { ProviderModelPicker } from "@/features/canvas/ui/ProviderModelPicker";
import {
  filterMediaModelParamsForMode,
  MediaModelParameterChip,
} from "@/features/canvas/ui/MediaModelParameterChip";
import {
  CreditCostPill,
  type CreditPromotionDisplay,
} from "@/components/credits/credit-visual";
import { CANVAS_NODE_INPUT_PLACEHOLDER_CLASS } from "@/features/canvas/ui/nodeFrameStyles";
import {
  NODE_COUNT_POPOVER_CLASS,
  NODE_CONTEXT_CONTROL_TRIGGER_CLASS,
  NODE_CREDIT_PILL_FLAT_CLASS,
  NODE_FLOATING_PANEL_SURFACE_CLASS,
  NODE_GENERATE_BUTTON_BASE_CLASS,
  NODE_GENERATE_BUTTON_DISABLED_CLASS,
  NODE_GENERATE_BUTTON_ENABLED_CLASS,
  NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS,
  NODE_INLINE_ICON_BUTTON_CLASS,
  NODE_REFERENCE_MEDIA_CHIP_CLASS,
  NODE_REFERENCE_MEDIA_DETACH_CLASS,
  NODE_TEXT_CONTROL_ICON_CLASS,
  NODE_TEXT_CONTROL_TRIGGER_CLASS,
} from "@/features/canvas/ui/nodeControlStyles";

const MODE_TABS: ReadonlyArray<{ key: VideoGenMode; labelKey: string }> = [
  { key: "textToVideo", labelKey: "node.videoNode.tabs.textToVideo" },
  { key: "allReference", labelKey: "node.videoNode.tabs.allReference" },
  { key: "firstFrame", labelKey: "node.videoNode.tabs.firstFrame" },
  { key: "imageToVideo", labelKey: "node.videoNode.tabs.imageToVideo" },
  { key: "firstLastFrame", labelKey: "node.videoNode.tabs.firstLastFrame" },
  { key: "imageReference", labelKey: "node.videoNode.tabs.imageReference" },
  { key: "videoEdit", labelKey: "node.videoNode.tabs.videoEdit" },
];

// HappyHorse 的模式面板顺序：文生视频 → 首帧 → 图片参考 → 视频编辑。
// 与上游文档 4 大功能一一对应，且与产品设计稿一致。
const HAPPYHORSE_TAB_ORDER: ReadonlyArray<VideoGenMode> = [
  "textToVideo",
  "firstFrame",
  "imageToVideo",
  "imageReference",
  "videoEdit",
];

const COUNT_OPTIONS: ReadonlyArray<VideoGenCount> = [1, 2, 4];
const VIDEO_PARAM_POPOVER_CLASS =
  `nodrag nowheel absolute bottom-full left-0 z-50 mb-2 w-[320px] p-4 ${NODE_FLOATING_PANEL_SURFACE_CLASS}`;
const VIDEO_PARAM_LABEL_CLASS =
  "mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-dark/72";
const VIDEO_PARAM_BUTTON_BASE_CLASS =
  "inline-flex items-center justify-center rounded px-2 py-2 text-xs transition-colors";
const VIDEO_PARAM_ACTIVE_BUTTON_CLASS =
  "bg-white/[0.13] text-text-dark ring-1 ring-white/24";
const VIDEO_PARAM_IDLE_BUTTON_CLASS =
  "bg-white/[0.07] text-text-muted/95 hover:bg-white/[0.11] hover:text-text-dark";
const VIDEO_PARAM_ROW_CLASS = "mb-4 gap-2";
const VIDEO_COUNT_OPTION_BASE_CLASS =
  "block w-full rounded-[6px] px-3 py-1.5 text-left text-xs transition-colors";
const VIDEO_MODE_POPOVER_CLASS =
  `nodrag nowheel fixed z-[10000] w-[132px] overflow-visible p-1 ${NODE_FLOATING_PANEL_SURFACE_CLASS}`;
// 禁用模式的 hover 提示气泡：悬浮在菜单右侧，深色圆角小胶囊，与设计稿一致。
const VIDEO_MODE_TOOLTIP_CLASS =
  "pointer-events-none absolute left-full top-1/2 z-[10001] ml-2 -translate-y-1/2 " +
  "whitespace-nowrap rounded-md bg-[#1f1f22] px-2.5 py-1.5 text-[11px] font-medium " +
  "text-white/90 shadow-lg ring-1 ring-white/10";

interface GenModeSelectProps {
  value: VideoGenMode;
  modelId: string | null | undefined;
  supportedModes?: string[];
  upstreamCounts: { videos: number; images: number; audios: number };
  onChange: (next: VideoGenMode) => void;
}

export function videoModeDisabledReason(
  mode: VideoGenMode,
  modelId: string | null | undefined,
  upstreamCounts: { videos: number; images: number; audios: number },
  supportedModes?: string[],
): string | null {
  // HappyHorse 的模式可用性完全由上游节点类型决定（文档 4 大功能）：
  //   文生视频  — 仅无上游时可用
  //   首帧      — 仅上游正好 1 张图片时可用
  //   图片参考  — 上游 1~9 张图片时可用
  //   视频编辑  — 仅上游有 1 个视频时可用
  // 不可用时返回 hover 文案（提示用户需要连接什么）。
  if (isHappyHorseVideoModel(modelId)) {
    const { images, videos } = upstreamCounts;
    switch (mode) {
      case "textToVideo":
        if (videos > 0) return "已连接视频节点，请使用「视频编辑」";
        if (images > 0) return "已连接图片节点，请选择「首帧」或「图片参考」";
        return null;
      case "firstFrame":
        if (videos > 0) return "已连接视频节点，「首帧」不可用";
        if (images === 0) return "需要连接图片节点（1个）";
        if (images > 1) return "「首帧」仅支持单张图片，请用「图片参考」";
        return null;
      case "imageToVideo":
        if (videos > 0) return "已连接视频节点，「图生视频」不可用";
        if (images === 0) return "需要连接图片节点（1个）";
        if (images > 1) return "「图生视频」仅支持单张图片，请用「图片参考」";
        return null;
      case "imageReference": // 图片参考 (r2v)
        if (videos > 0) return "已连接视频节点，「图片参考」不可用";
        if (images === 0) return "需要连接图片节点（1~9个）";
        if (images > 9) return "「图片参考」最多支持 9 张图片";
        return null;
      case "videoEdit":
        if (videos === 0) return "需要连接视频节点（1个）";
        if (videos > 1) return "「视频编辑」仅支持连接 1 个视频节点";
        return null;
      default:
        return "HappyHorse 不支持该模式";
    }
  }
  // 「视频编辑」以上游视频**为输入**，不能被下面那条「有视频就只剩全能参考」连坐。
  // 它和「全能参考」是仅有的两个消费视频素材的模式 —— 提交守卫
  // `videoSubmitMediaRejectionReason` 早就写着 `mode !== "allReference" && mode !==
  // "videoEdit"`，这里漏了同一条豁免。视频编辑一度是 HappyHorse 专属（见
  // `isVideoModeSupportedByModel` 的注释），后来目录里的 seedance-2.0-mini 这类模型
  // 也声明了 `video_edit`，tab 露出来了、却被这条旧规则一并置灰，于是「接上视频想切
  // 视频编辑」被自己挡死。
  const model = supportedModes?.length
    ? { apiModel: modelId ?? undefined, supportedModes }
    : modelId;
  const supportsVideoEdit = isVideoModeSupportedByModel("videoEdit", model);
  if (mode === "videoEdit") {
    if (!supportsVideoEdit) return "该模型不支持「视频编辑」";
    if (upstreamCounts.videos === 0) return "需要连接视频节点（1个）";
    if (upstreamCounts.videos > 1) return "「视频编辑」仅支持连接 1 个视频节点";
    return null;
  }
  if (upstreamCounts.videos > 0 && mode !== "allReference") {
    return supportsVideoEdit
      ? "上游含视频素材时只能用「全能参考」或「视频编辑」"
      : "上游含视频素材时只能用「全能参考」";
  }
  if (
    mode === "textToVideo" &&
    (upstreamCounts.images > 0 || upstreamCounts.audios > 0)
  ) {
    return "已引用图片/音频素材时不可用";
  }
  if (mode === "imageToVideo" && upstreamCounts.videos >= 2) {
    return "上游有多个视频时不可用";
  }
  if (mode === "firstLastFrame" && upstreamCounts.images > 2) {
    return "上游图片超过 2 张时不可用";
  }
  return null;
}

function GenModeSelect({
  value,
  modelId,
  supportedModes,
  upstreamCounts,
  onChange,
}: GenModeSelectProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [hoveredKey, setHoveredKey] = useState<VideoGenMode | null>(null);
  const [popoverPosition, setPopoverPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  // HappyHorse 的模式面板对齐文档 4 大功能：文生视频 / 首帧 / 图片参考 / 视频编辑。
  //   - 隐藏「首尾帧」「全能参考」：HappyHorse 无这两种能力，点了只会报错。
  //   - 把「图生视频」显示为「首帧」：它本就是单图首帧 i2v，直接叫「首帧」跟「图片
  //     参考」一眼分清。
  //   - 上游接入视频后，「首帧」「图片参考」整项隐藏（文档：视频节点下没有这两个
  //     选项），只保留「文生视频」(禁用) 与「视频编辑」。
  // 非 HappyHorse 不暴露「视频编辑」(它是 HappyHorse 专属功能)。
  // 媒体目录声明了 supportedModes 就完全以它为准（Admin 配置是最新事实），
  // 下面那套按模型 id 推断的规则只是没配置时的兜底。
  const visibleTabs = useMemo(() => {
    if (supportedModes?.length) {
      const keyMap: Record<VideoGenMode, string> = {
        textToVideo: "text_to_video",
        firstFrame: "first_frame",
        imageToVideo: "image_reference",
        firstLastFrame: "first_last_frame",
        imageReference: "image_reference",
        allReference: "all_reference",
        videoEdit: "video_edit",
      };
      return MODE_TABS.filter((tab) => supportedModes.includes(keyMap[tab.key]));
    }
    if (!isHappyHorseVideoModel(modelId)) {
      return MODE_TABS.filter((tab) =>
        isVideoModeSupportedByModel(tab.key, modelId),
      );
    }
    const order =
      upstreamCounts.videos > 0
        ? (["textToVideo", "videoEdit"] as VideoGenMode[])
        : HAPPYHORSE_TAB_ORDER;
    return order
      .map((key) => MODE_TABS.find((tab) => tab.key === key))
      .filter((tab): tab is (typeof MODE_TABS)[number] => Boolean(tab))
      .map((tab) =>
        tab.key === "imageToVideo"
          ? { ...tab, labelKey: "node.videoNode.tabs.firstFrame" }
          : tab,
      );
  }, [modelId, supportedModes, upstreamCounts.videos]);
  const activeTab = visibleTabs.find((tab) => tab.key === value) ?? visibleTabs[0];

  const syncPopoverPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const margin = 8;
    setPopoverPosition({
      left: Math.min(Math.max(margin, rect.left), window.innerWidth - 132 - margin),
      top: rect.bottom + 8,
    });
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setHoveredKey(null);
      return;
    }
    syncPopoverPosition();
    const onPointerDown = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        popoverRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setIsOpen(false);
    };
    const onViewportChange = () => syncPopoverPosition();
    document.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [isOpen, syncPopoverPosition]);

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        className={NODE_CONTEXT_CONTROL_TRIGGER_CLASS}
      >
        <span>{t(activeTab.labelKey)}</span>
        <ChevronDown className="h-3 w-3 text-text-muted/90" />
      </button>
      {isOpen && popoverPosition && createPortal(
        <div
          ref={popoverRef}
          className={VIDEO_MODE_POPOVER_CLASS}
          style={{
            left: popoverPosition.left,
            top: popoverPosition.top,
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {visibleTabs.map((tab) => {
            const isActive = tab.key === value;
            const disabledReason = videoModeDisabledReason(
              tab.key,
              modelId,
              upstreamCounts,
              supportedModes,
            );
            const isDisabled = disabledReason != null && !isActive;
            // 禁用按钮在多数浏览器里不触发 mouse 事件，hover 提示挂在外层 div 上；
            // 提示气泡定位到菜单右侧，与设计稿一致。
            return (
              <div
                key={tab.key}
                className="relative"
                onMouseEnter={() =>
                  isDisabled ? setHoveredKey(tab.key) : setHoveredKey(null)
                }
                onMouseLeave={() =>
                  setHoveredKey((prev) => (prev === tab.key ? null : prev))
                }
              >
                <button
                  type="button"
                  disabled={isDisabled}
                  onClick={() => {
                    if (isDisabled) return;
                    onChange(tab.key);
                    setIsOpen(false);
                  }}
                  className={`block w-full rounded-[6px] px-3 py-1.5 text-left text-xs transition-colors ${
                    isActive
                      ? VIDEO_PARAM_ACTIVE_BUTTON_CLASS
                      : isDisabled
                        ? "cursor-not-allowed text-text-muted/40"
                        : "text-text-muted/95 hover:bg-white/[0.11] hover:text-text-dark"
                  }`}
                >
                  {t(tab.labelKey)}
                </button>
                {isDisabled && hoveredKey === tab.key && disabledReason && (
                  <div className={VIDEO_MODE_TOOLTIP_CLASS}>{disabledReason}</div>
                )}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

interface VideoConfigChipProps {
  aspectRatio: FreezoneVideoAspectRatio;
  aspectRatioOptions: readonly FreezoneVideoAspectRatio[];
  quality: VideoGenQuality;
  qualityOptions: readonly VideoGenQuality[];
  durationSec: number;
  durationBounds: { min: number; max: number };
  sceneOptimize?: Seedance2SceneOptimize;
  sceneOptimizeOptions: readonly Seedance2SceneOptimize[];
  generateAudio: boolean;
  onChange: (patch: Partial<VideoNodeData>) => void;
}

function VideoConfigChip({
  aspectRatio,
  aspectRatioOptions,
  quality,
  qualityOptions,
  durationSec,
  durationBounds,
  sceneOptimize,
  sceneOptimizeOptions,
  generateAudio,
  onChange,
}: VideoConfigChipProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  // Local draft for the direct-entry duration box. The field stays free text
  // while editing so a half-typed value isn't fought by clamping, but we still
  // want the slider and bottom chip to track the box live — so on each keystroke
  // we commit as soon as the draft is a *complete integer already inside* the
  // model's bounds. An out-of-range interim (the "1" of "12" when min is 5) is
  // held as draft only and NOT committed, so the user is never stranded at the
  // min mid-typing; blur/Enter clamps anything still out of range on the way out.
  const [durationDraft, setDurationDraft] = useState<string>(String(durationSec));
  useEffect(() => {
    setDurationDraft(String(durationSec));
  }, [durationSec]);
  const handleDurationInput = (raw: string) => {
    setDurationDraft(raw);
    const parsed = Number(raw);
    if (
      raw.trim() !== "" &&
      Number.isInteger(parsed) &&
      parsed >= durationBounds.min &&
      parsed <= durationBounds.max &&
      parsed !== durationSec
    ) {
      onChange({ durationSec: parsed });
    }
  };
  const commitDuration = () => {
    const parsed = Number(durationDraft);
    if (durationDraft.trim() === "" || !Number.isFinite(parsed)) {
      setDurationDraft(String(durationSec)); // revert empty/garbage to current
      return;
    }
    const clamped = clampVideoDuration(parsed, durationBounds);
    setDurationDraft(String(clamped));
    if (clamped !== durationSec) onChange({ durationSec: clamped });
  };

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
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [isOpen]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        className={NODE_TEXT_CONTROL_TRIGGER_CLASS}
      >
        <span>
          {aspectRatio === "auto"
            ? t("node.videoNode.aspect.auto")
            : aspectRatio}
        </span>
        <span className="text-text-muted/80">·</span>
        <span>{quality}</span>
        <span className="text-text-muted/80">·</span>
        <span>{durationSec}s</span>
        {generateAudio ? (
          <Volume2 className="ml-0.5 h-3.5 w-3.5 text-text-muted/90" />
        ) : (
          <VolumeX className="ml-0.5 h-3.5 w-3.5 text-text-muted/90" />
        )}
        <ChevronDown className="h-3 w-3 text-text-muted/90" />
      </button>
      {isOpen && (
        <div
          ref={popoverRef}
          className={VIDEO_PARAM_POPOVER_CLASS}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <div className={VIDEO_PARAM_LABEL_CLASS}>
            {t("node.videoNode.aspect.title")}
          </div>
          <div className={`grid grid-cols-5 ${VIDEO_PARAM_ROW_CLASS}`}>
            {aspectRatioOptions.map((ratio) => {
              const isActive = aspectRatio === ratio;
              return (
                <button
                  key={ratio}
                  type="button"
                  onClick={() => onChange({ aspectRatio: ratio })}
                  className={`${VIDEO_PARAM_BUTTON_BASE_CLASS} ${
                    isActive
                      ? VIDEO_PARAM_ACTIVE_BUTTON_CLASS
                      : VIDEO_PARAM_IDLE_BUTTON_CLASS
                  }`}
                >
                  {ratio === "auto" ? t("node.videoNode.aspect.auto") : ratio}
                </button>
              );
            })}
          </div>

          <div className={VIDEO_PARAM_LABEL_CLASS}>
            {t("node.videoNode.quality.title")}
          </div>
          <div className={`grid grid-cols-3 ${VIDEO_PARAM_ROW_CLASS}`}>
            {qualityOptions.map((q) => {
              const isActive = quality === q;
              return (
                <button
                  key={q}
                  type="button"
                  onClick={() => onChange({ quality: q })}
                  className={`${VIDEO_PARAM_BUTTON_BASE_CLASS} ${
                    isActive
                      ? VIDEO_PARAM_ACTIVE_BUTTON_CLASS
                      : VIDEO_PARAM_IDLE_BUTTON_CLASS
                  }`}
                >
                  {q}
                </button>
              );
            })}
          </div>

          <div className={VIDEO_PARAM_LABEL_CLASS}>
            {t("node.videoNode.duration.title")}
          </div>
          <div className="mb-4 flex items-center gap-3">
            <input
              type="range"
              min={durationBounds.min}
              max={durationBounds.max}
              step={1}
              value={durationSec}
              onChange={(event) =>
                onChange({
                  durationSec: clampVideoDuration(Number(event.target.value), durationBounds),
                })
              }
              className="video-duration-slider min-w-0 flex-1"
            />
            <div className="flex shrink-0 items-center gap-1">
              <input
                type="number"
                inputMode="numeric"
                min={durationBounds.min}
                max={durationBounds.max}
                step={1}
                value={durationDraft}
                onChange={(event) => handleDurationInput(event.target.value)}
                onBlur={commitDuration}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitDuration();
                    event.currentTarget.blur();
                  }
                }}
                aria-label={t("node.videoNode.duration.title")}
                className="h-7 w-12 rounded border border-white/12 bg-white/[0.07] px-1.5 text-center text-xs tabular-nums text-text-dark outline-none transition-colors focus:border-white/28 focus:bg-white/[0.11] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <span className="text-[11px] text-text-muted/80">s</span>
            </div>
          </div>

          {sceneOptimizeOptions.length > 0 && (
            <>
              <div className={VIDEO_PARAM_LABEL_CLASS}>
                {t("node.videoNode.sceneOptimize.title")}
              </div>
              <div className={`grid grid-cols-2 ${VIDEO_PARAM_ROW_CLASS}`}>
                {sceneOptimizeOptions.map((option) => {
                  const isActive = sceneOptimize === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      onClick={() => onChange({ sceneOptimize: option })}
                      className={`${VIDEO_PARAM_BUTTON_BASE_CLASS} ${
                        isActive
                          ? VIDEO_PARAM_ACTIVE_BUTTON_CLASS
                          : VIDEO_PARAM_IDLE_BUTTON_CLASS
                      }`}
                    >
                      {t(`node.videoNode.sceneOptimize.options.${option}`)}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          <div className={VIDEO_PARAM_LABEL_CLASS}>
            {t("node.videoNode.audio.title")}
          </div>
          <div className="flex items-center justify-between rounded-md bg-white/[0.045] px-2.5 py-1.5">
            <span className="text-xs font-medium text-text-dark/88">
              {generateAudio
                ? t("node.videoNode.audio.on")
                : t("node.videoNode.audio.off")}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={generateAudio}
              aria-label={t("node.videoNode.audio.title")}
              onClick={() => onChange({ generateAudio: !generateAudio })}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors ${
                generateAudio
                  ? "border-white/24 bg-white/[0.18]"
                  : "border-white/10 bg-white/[0.08]"
              }`}
            >
              <span
                className={`h-4 w-4 rounded-full bg-text-dark shadow-[0_2px_8px_rgba(0,0,0,0.35)] transition-transform ${
                  generateAudio ? "translate-x-[18px]" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface CameraMovementChipProps {
  templates: ReadonlyArray<CameraMovementPreset>;
  isLoading: boolean;
  selectedId: string | null;
  onChange: (next: string | null) => void;
}

const CAMERA_MOVEMENT_POPOVER_WIDTH = 640;
const CAMERA_MOVEMENT_POPOVER_MAX_HEIGHT = 560;
const CAMERA_MOVEMENT_POPOVER_GAP = 8;

function CameraMovementChip({
  templates,
  isLoading,
  selectedId,
  onChange,
}: CameraMovementChipProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(
    null,
  );

  // Position above the chip whenever it opens or the viewport changes. We
  // render the popover into <body> via portal so it can sit above the
  // react-flow NodeToolbar (z-[120]) — without portal it lives inside the
  // video node's transformed stacking context and gets covered.
  useEffect(() => {
    if (!isOpen) return;
    const updateAnchor = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const popHeight = Math.min(
        CAMERA_MOVEMENT_POPOVER_MAX_HEIGHT,
        rect.top - CAMERA_MOVEMENT_POPOVER_GAP - 8,
      );
      const wantTop = rect.top - popHeight - CAMERA_MOVEMENT_POPOVER_GAP;
      // If we can't fit above, fall back to below.
      const top =
        wantTop < 8 ? rect.bottom + CAMERA_MOVEMENT_POPOVER_GAP : wantTop;
      const wantLeft = rect.left;
      const left = Math.max(
        8,
        Math.min(
          wantLeft,
          window.innerWidth - CAMERA_MOVEMENT_POPOVER_WIDTH - 8,
        ),
      );
      setAnchor({ left, top });
    };
    updateAnchor();
    window.addEventListener("resize", updateAnchor);
    window.addEventListener("scroll", updateAnchor, true);
    return () => {
      window.removeEventListener("resize", updateAnchor);
      window.removeEventListener("scroll", updateAnchor, true);
    };
  }, [isOpen]);

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
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [isOpen]);

  const selectedPreset = findCameraMovementPreset(templates, selectedId);
  const label = selectedPreset?.label ?? "运镜";
  const isActive = Boolean(selectedPreset);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        className={`${NODE_TEXT_CONTROL_TRIGGER_CLASS} group/camera px-1.5 ${isActive ? "text-text-dark" : ""}`}
      >
        <Film className={`${NODE_TEXT_CONTROL_ICON_CLASS} group-hover/camera:text-text-dark`} />
        <span>{label}</span>
      </button>
      {isOpen &&
        anchor &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-[10000]"
            style={{ left: anchor.left, top: anchor.top }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <CameraMovementPickerPopover
              templates={templates}
              isLoading={isLoading}
              selectedId={selectedId}
              onConfirm={(nextId) => {
                onChange(nextId);
                setIsOpen(false);
              }}
              onClose={() => setIsOpen(false)}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

interface CharacterLibraryChipProps {
  onOpen: () => void;
}

function CharacterLibraryChip({ onOpen }: CharacterLibraryChipProps) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      className={`${NODE_TEXT_CONTROL_TRIGGER_CLASS} group/asset px-1.5`}
    >
      <Library className={`${NODE_TEXT_CONTROL_ICON_CLASS} group-hover/asset:text-text-dark`} />
      <span>资产库</span>
    </button>
  );
}

function ExternalAssetChip({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      className={`${NODE_TEXT_CONTROL_TRIGGER_CLASS} group/external px-1.5`}
    >
      <Plus className={`${NODE_TEXT_CONTROL_ICON_CLASS} group-hover/external:text-text-dark`} />
      <span>外部素材</span>
    </button>
  );
}

interface CountPickerProps {
  value: VideoGenCount;
  onChange: (next: VideoGenCount) => void;
}

function CountPicker({ value, onChange }: CountPickerProps) {
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
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [isOpen]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        className={NODE_TEXT_CONTROL_TRIGGER_CLASS}
      >
        <span>{t("node.videoNode.count.format", { count: value })}</span>
        <ChevronUp className="h-3 w-3 text-text-muted/90" />
      </button>
      {isOpen && (
        <div
          ref={popoverRef}
          className={NODE_COUNT_POPOVER_CLASS}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {COUNT_OPTIONS.map((option) => {
            const isActive = option === value;
            return (
              <button
                key={option}
                type="button"
                onClick={() => {
                  onChange(option);
                  setIsOpen(false);
                }}
                className={`${VIDEO_COUNT_OPTION_BASE_CLASS} ${
                  isActive
                    ? VIDEO_PARAM_ACTIVE_BUTTON_CLASS
                    : "text-text-muted/95 hover:bg-white/[0.11] hover:text-text-dark"
                }`}
              >
                {t("node.videoNode.count.format", { count: option })}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface ReferenceMediaRowProps {
  items: ReadonlyArray<ReferenceMediaCapEntry>;
  /** 当前模式的逐类型上限（含模型覆盖）；null = 该模式不限制，不标灰任何 chip。 */
  caps: { image: number; video: number; audio: number } | null;
  /** 当前 genMode；用来决定 firstLastFrame 模式下给前两张图片打 首帧/尾帧 角标。 */
  genMode: VideoGenMode;
  onFocus: (nodeId: string) => void;
  onDetach: (nodeId: string) => void;
  // 拖动 chip 换位后，回传新的「按可视顺序排列的上游节点 id 列表」。
  onReorder: (orderedNodeIds: string[]) => void;
}

function ReferenceMediaRow({
  items,
  caps,
  genMode,
  onFocus,
  onDetach,
  onReorder,
}: ReferenceMediaRowProps) {
  // 同时管理整行音频的「当前播放节点」—— 同一时间只允许一个 audio chip 在
  // 播放。点击另一个会切换；再点同一个会暂停。
  const [playingAudioNodeId, setPlayingAudioNodeId] = useState<string | null>(
    null,
  );
  // 拖拽换位的临时状态：正在被拖的 chip / 当前悬停落点 chip。
  const [dragNodeId, setDragNodeId] = useState<string | null>(null);
  const [overNodeId, setOverNodeId] = useState<string | null>(null);

  const clearDrag = useCallback(() => {
    setDragNodeId(null);
    setOverNodeId(null);
  }, []);

  const handleDrop = useCallback(
    (targetNodeId: string) => {
      const sourceId = dragNodeId;
      clearDrag();
      if (!sourceId || sourceId === targetNodeId) return;
      const ids = items.map((entry) => entry.item.nodeId);
      const from = ids.indexOf(sourceId);
      const to = ids.indexOf(targetNodeId);
      if (from === -1 || to === -1) return;
      ids.splice(from, 1);
      ids.splice(to, 0, sourceId);
      onReorder(ids);
    },
    [dragNodeId, items, onReorder, clearDrag],
  );

  return (
    <div className="ml-4 flex shrink-0 items-center gap-1.5">
      {items.map((entry) => {
        const { item, typeIndex, withinCap } = entry;
        // 「超出当前模式上限」只在 REFERENCE_CAPS_BY_MODE 里登记过的模式生效。
        const overCap = caps != null && !withinCap;
        const modeCap = caps?.[item.kind] ?? 0;
        const modeLabel =
          {
            textToVideo: "文生视频",
            firstFrame: "首帧",
            imageToVideo: "图生视频",
            imageReference: "多图参考",
            firstLastFrame: "首尾帧",
            videoEdit: "视频编辑",
            allReference: "全能参考",
          }[genMode] ?? "当前模式";
        const overCapTitle = overCap
          ? `${
              item.kind === "image"
                ? "图片"
                : item.kind === "video"
                  ? "视频"
                  : "音频"
            }引用超出${modeLabel}上限（${modeCap}${
              item.kind === "image" ? "张" : "段"
            }），本次生成不会使用该素材`
          : undefined;
        // 首尾帧模式下，前两张图片打 首帧/尾帧 角标；超出 cap 的图片就回退到
        // 数字角标，让用户看到「这张图被忽略」的同时仍能在 prompt 里通过原序号
        // 对照——不过那种状态主要靠自动切换到 allReference 兜底，正常不会发生。
        const slotLabel =
          genMode === "firstLastFrame" &&
          item.kind === "image" &&
          withinCap
            ? typeIndex === 1
              ? "首帧"
              : typeIndex === 2
                ? "尾帧"
                : undefined
            : undefined;
        let chip: ReactNode;
        if (item.kind === "image") {
          chip = (
            <ReferenceImageChip
              item={item}
              index={typeIndex - 1}
              slotLabel={slotLabel}
              onFocus={onFocus}
              onDetach={onDetach}
            />
          );
        } else if (item.kind === "video") {
          chip = (
            <ReferenceVideoChip
              item={item}
              index={typeIndex - 1}
              onFocus={onFocus}
              onDetach={onDetach}
            />
          );
        } else {
          chip = (
            <ReferenceAudioChip
              item={item}
              index={typeIndex - 1}
              isPlaying={playingAudioNodeId === item.nodeId}
              onToggle={(playing) =>
                setPlayingAudioNodeId(playing ? item.nodeId : null)
              }
              onFocus={onFocus}
              onDetach={onDetach}
            />
          );
        }

        const isDragging = dragNodeId === item.nodeId;
        const isDropTarget =
          overNodeId === item.nodeId && dragNodeId !== null && !isDragging;

        return (
          <div
            key={item.nodeId}
            title={overCapTitle}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", item.nodeId);
              setDragNodeId(item.nodeId);
            }}
            onDragOver={(event) => {
              if (!dragNodeId) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              if (overNodeId !== item.nodeId) setOverNodeId(item.nodeId);
            }}
            onDragLeave={() => {
              setOverNodeId((cur) => (cur === item.nodeId ? null : cur));
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
              handleDrop(item.nodeId);
            }}
            onDragEnd={clearDrag}
            className={`nodrag relative cursor-grab rounded-md transition active:cursor-grabbing ${
              isDragging ? "opacity-40" : ""
            } ${
              isDropTarget
                ? "ring-2 ring-accent ring-offset-1 ring-offset-surface-dark"
                : ""
            } ${
              // omni 上限外的 chip：去饱和 + 半透明 + 琥珀色描边；hover 时通过
              // 父层 title 显示「超出上限不会使用」。配 detach 按钮提示用户主动
              // 移除超额素材。
              overCap
                ? "opacity-50 grayscale ring-1 ring-amber-400/45 ring-offset-1 ring-offset-surface-dark"
                : ""
            }`}
          >
            {chip}
            {overCap && (
              <span className="pointer-events-none absolute -bottom-1 -left-1 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500/90 text-[10px] font-bold leading-none text-surface-dark shadow ring-1 ring-surface-dark">
                !
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function useHoverPreviewPos(
  buttonRef: React.RefObject<HTMLElement | null>,
  width: number,
) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const PREVIEW_OFFSET = 10;
  const show = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(
      8,
      Math.min(
        window.innerWidth - width - 8,
        rect.left + rect.width / 2 - width / 2,
      ),
    );
    const top = rect.top - PREVIEW_OFFSET;
    setPos({ left, top });
  }, [buttonRef, width]);
  const hide = useCallback(() => setPos(null), []);
  return { pos, show, hide };
}

interface ReferenceImageChipProps {
  item: Extract<ReferenceMediaItem, { kind: "image" }>;
  index: number;
  /** 给角标显示自定义文案（如「首帧」「尾帧」）。未设置时使用数字角标。 */
  slotLabel?: string;
  onFocus: (nodeId: string) => void;
  onDetach: (nodeId: string) => void;
}

function ReferenceImageChip({
  item,
  index,
  slotLabel,
  onFocus,
  onDetach,
}: ReferenceImageChipProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const PREVIEW_W = 140;
  const { pos, show, hide } = useHoverPreviewPos(buttonRef, PREVIEW_W);
  const label =
    item.displayName?.trim() || slotLabel || `引用 ${index + 1}`;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onFocus(item.nodeId);
        }}
        onMouseEnter={show}
        onMouseLeave={hide}
        className={`nodrag ${NODE_REFERENCE_MEDIA_CHIP_CLASS}`}
        title={label}
      >
        <img
          src={resolveImageDisplayUrl(item.imageUrl)}
          alt={label}
          className="h-full w-full object-cover"
          draggable={false}
        />
        {slotLabel ? (
          // 首尾帧角标：结构信息（不是序号），保留。前端按产品要求不再显示
          // 「图片N」的数字角标——引用统一呈现为「图片」，序号只存在于提交给
          // 后端的 prompt（@图片N）里，不在引用缩略图上暴露。
          <span
            className="pointer-events-none absolute bottom-1 left-1 z-10 text-[9px] font-medium leading-none text-white"
            style={{ textShadow: "0 0 2px rgba(0,0,0,0.65), 0 1px 1px rgba(0,0,0,0.55)" }}
          >
            {slotLabel}
          </span>
        ) : null}
        <ReferenceDetachButton
          nodeId={item.nodeId}
          onDetach={onDetach}
          className={NODE_REFERENCE_MEDIA_DETACH_CLASS}
        />
      </button>
      {pos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[400] -translate-y-full"
            style={{ left: pos.left, top: pos.top, width: PREVIEW_W }}
          >
            <div className="overflow-hidden rounded-xl border border-white/15 bg-surface-dark/95 shadow-2xl backdrop-blur-sm">
              <img
                src={resolveImageDisplayUrl(item.imageUrl)}
                alt={label}
                className="block h-auto w-full object-contain"
                draggable={false}
              />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

interface ReferenceVideoChipProps {
  item: Extract<ReferenceMediaItem, { kind: "video" }>;
  index: number;
  onFocus: (nodeId: string) => void;
  onDetach: (nodeId: string) => void;
}

function ReferenceVideoChip({ item, index, onFocus, onDetach }: ReferenceVideoChipProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const PREVIEW_W = 140;
  const { pos, show, hide } = useHoverPreviewPos(buttonRef, PREVIEW_W);
  const label = item.displayName?.trim() || `视频引用 ${index + 1}`;

  // chip 缩略图：有 previewImageUrl 用静态图；否则用一个 muted 静止 <video>
  // 显示首帧。preload=metadata 让 Safari/Chrome 自动定位到首帧。
  const thumb = item.thumbUrl ? (
    <img
      src={resolveImageDisplayUrl(item.thumbUrl)}
      alt={label}
      className="h-full w-full object-cover"
      draggable={false}
    />
  ) : (
    <video
      src={resolveImageDisplayUrl(item.videoUrl)}
      className="h-full w-full object-cover"
      muted
      playsInline
      preload="metadata"
      draggable={false}
    />
  );

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onFocus(item.nodeId);
        }}
        onMouseEnter={show}
        onMouseLeave={hide}
        className={`nodrag ${NODE_REFERENCE_MEDIA_CHIP_CLASS}`}
        title={label}
      >
        {thumb}
        <ReferenceDetachButton
          nodeId={item.nodeId}
          onDetach={onDetach}
          className={NODE_REFERENCE_MEDIA_DETACH_CLASS}
        />
      </button>
      {pos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[400] -translate-y-full"
            style={{ left: pos.left, top: pos.top, width: PREVIEW_W }}
          >
            <div className="overflow-hidden rounded-xl border border-white/15 bg-surface-dark/95 shadow-2xl backdrop-blur-sm">
              {/* hover 时 autoplay + loop + muted —— 不弹声音不打扰其它正在
                  播放的 audio chip。 */}
              <video
                src={resolveImageDisplayUrl(item.videoUrl)}
                autoPlay
                loop
                muted
                playsInline
                className="block h-auto w-full object-contain"
              />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

interface ReferenceAudioChipProps {
  item: Extract<ReferenceMediaItem, { kind: "audio" }>;
  index: number;
  isPlaying: boolean;
  onToggle: (playing: boolean) => void;
  onFocus: (nodeId: string) => void;
  onDetach: (nodeId: string) => void;
}

function ReferenceAudioChip({
  item,
  index,
  isPlaying,
  onToggle,
  onFocus,
  onDetach,
}: ReferenceAudioChipProps) {
  // 用 ref 持有一个 HTMLAudioElement —— 比挂在 DOM 上的 <audio> 简单：可以
  // 直接 .play()/.pause()，也方便处理同时只放一个的逻辑（父层告诉这个
  // chip 它不再是当前正在播的）。
  const audioRef = useRef<HTMLAudioElement | null>(null);
  if (audioRef.current === null && typeof Audio !== "undefined") {
    audioRef.current = new Audio();
  }

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const src = resolveImageDisplayUrl(item.audioUrl);
    if (audio.src !== src) {
      audio.src = src;
    }
  }, [item.audioUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      void audio.play().catch(() => {
        // 自动播放被浏览器拦或资源加载失败 —— 回滚父层状态。
        onToggle(false);
      });
    } else {
      audio.pause();
    }
  }, [isPlaying, onToggle]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const handleEnded = () => onToggle(false);
    audio.addEventListener("ended", handleEnded);
    return () => audio.removeEventListener("ended", handleEnded);
  }, [onToggle]);

  // 卸载时停掉播放，避免脏状态留在浏览器。
  useEffect(() => {
    return () => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.pause();
      audio.src = "";
    };
  }, []);

  const label = item.displayName?.trim() || `音频引用 ${index + 1}`;

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        // 单击：切换播放；同时把焦点切到上游节点（方便用户跳过去看）。
        onFocus(item.nodeId);
        onToggle(!isPlaying);
      }}
      className={`group/refmedia nodrag relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border transition-colors ${
        isPlaying
          ? "border-accent/60 bg-[rgb(var(--accent-rgb)/0.15)]"
          : "border-white/10 bg-white/[0.04] hover:border-white/30"
      }`}
      title={label}
    >
      {isPlaying ? (
        <Pause className="h-4 w-4 text-accent" />
      ) : (
        <Music className="h-4 w-4 text-text-dark/90" />
      )}
      <ReferenceDetachButton
        nodeId={item.nodeId}
        onDetach={onDetach}
        className={NODE_REFERENCE_MEDIA_DETACH_CLASS}
      />
    </button>
  );
}

export interface VideoGenerationFormProps {
  /**
   * 目标节点 id：仅用于本组件内部按钮的定位标识（NodeContextPromptPaletteButton）
   * 和调用 useCanvasStore().updateNodeData 时的 nodeId，不读取任何 React Flow 上下文。
   */
  nodeId: string;

  // ── 运镜 / 资产库 / 模式 / 引用 chips 行 ──
  cameraTemplates: ReadonlyArray<CameraMovementPreset>;
  cameraTemplatesLoading: boolean;
  cameraMovementId: string | null;
  onOpenCharacterLibrary: () => void;
  onOpenExternalAssets?: () => void;
  genMode: VideoGenMode;
  /** 送进模式菜单判可用性的模型标识（优先 apiModel，回落 id）。 */
  genModeModelId: string | null | undefined;
  /** 媒体目录声明的可用模式（后端 key）；有它就以它为准，能力推断只是兜底。 */
  genModeSupportedModes?: string[];
  /**
   * 模式菜单用的上游计数。**与 `modelUpstreamCounts` 是两份**：HappyHorse 的可选
   * 模式由上游节点类型（含未填图的空节点）决定，其余模型按已解析素材 URL 计数，
   * 该条件判断留在宿主（VideoNode）里，本组件只负责显示。
   */
  genModeUpstreamCounts: { videos: number; images: number; audios: number };
  upstreamTextContents: readonly UpstreamContent[];
  onDetachUpstream: (sourceNodeId: string) => void;
  /** 已按引用顺序排好、并补过「同类型序号 + 是否在模式上限内」的引用素材。 */
  referenceMediaItems: ReadonlyArray<ReferenceMediaCapEntry>;
  /** 当前模式的逐类型素材上限（含模型覆盖）；null = 该模式不限制。 */
  referenceCaps: { image: number; video: number; audio: number } | null;

  // ── 提示词编辑器 ──
  // prompt 的 draft 状态、IME 合成态由宿主持有——节点上「生成失败」横幅的重试按钮
  // 需要读同一份 prompt 判断是否可提交，draft 状态若下沉到本组件会导致两处失配。
  prompt: string;
  onPromptChange: (next: string) => void;
  onCompositionStart: () => void;
  onCompositionEnd: (next: string) => void;
  mentionCandidates: MentionCandidate[];
  /** 上游拼接的文本，非空时提示词占位符文案不同。 */
  upstreamTextJoined: string;

  // ── 参数行 ──
  modelId: string;
  /**
   * 换模型不是一次纯 patch：新模型不支持当前 genMode 时要连带重置模式，还要把
   * 选择记到「下次新建视频节点继承」里。这套策略留在宿主，本组件只上报选择。
   */
  onModelChange: (nextModelId: string) => void;
  /** 模型下拉里判「该模型吃不下当前素材」用的上游计数（始终按已解析素材 URL）。 */
  modelUpstreamCounts: { images: number; videos: number; audios: number };
  aspectRatio: FreezoneVideoAspectRatio;
  /** 可选比例：模型在媒体目录里声明了就用它的，否则是内置的 7 个预设。 */
  aspectRatioOptions: readonly FreezoneVideoAspectRatio[];
  quality: VideoGenQuality;
  qualityOptions: readonly VideoGenQuality[];
  durationSec: number;
  durationBounds: { min: number; max: number };
  sceneOptimize?: Seedance2SceneOptimize;
  sceneOptimizeOptions: readonly Seedance2SceneOptimize[];
  generateAudio: boolean;
  /** 媒体目录里勾了 humanReview 的模型才显示「真人验证」开关。 */
  showHumanReview: boolean;
  humanReview: boolean;
  /** 所选模型声明的自定义参数表单（MediaModelParameterChip）。 */
  modelParameters: MediaModelParameterDefinition[] | undefined;
  modelParams: Record<string, unknown> | undefined;
  count: VideoGenCount;
  isTranslatingPrompt: boolean;
  isGenerating: boolean;
  /**
   * 翻译按钮的禁用态由宿主算好传进来（与 `submitDisabled` 对称）：视频节点这条
   * 门槛看的是**已落库的 prompt**（`data.prompt`），不是编辑器里的草稿——IME
   * 合成途中草稿已有字符但还没写回 store，此时按钮仍应保持禁用。
   */
  translateDisabled: boolean;
  onTranslate: () => void;

  // ── 提交 ──
  totalCreditCostDisplay: string | null;
  /** 与 `totalCreditCostDisplay` 成对：缺了它促销标签只会兜底成通用的「促销中」。 */
  creditPromotion: CreditPromotionDisplay | null;
  submitDisabled: boolean;
  submitDisabledReason?: string | null;
  onSubmit: () => void;

  /**
   * 纯排版适配位（不改任何字段/行为）：默认在 chips 行右侧留出 `pr-10` 给宿主
   * 叠在右上角的「放大」按钮（VideoNode 的 PanelExpandButton）。没有那个按钮的
   * 宿主传 true 收掉这段留白，避免 chips 行凭空缺一块。
   */
  compact?: boolean;
}

/**
 * 视频生成节点的**纯表单内容层**：运镜 / 资产库 / 生成模式 / 引用素材 chips +
 * 提示词输入 + 模型选择 + 参数（比例/清晰度/时长/场景优化/音频/真人验证/数量）+
 * 翻译按钮 + 算力 + 提交按钮。不含任何 React Flow 依赖（无 useReactFlow /
 * useNodeId / NodeToolbar / useUpdateNodeInternals），因此既能挂在画布节点下方的
 * 浮动面板里（VideoNode + OperationPanelShell），也能塞进故事板详情之类的独立布局。
 *
 * 与图片侧（ImageGenerationForm）同一套路：纯字段 patch 直接走
 * `useCanvasStore().updateNodeData`，带策略的动作（换模型的 genMode 重置、提交、
 * 翻译、取消引用、打开资产库弹窗）一律由宿主用回调注入——**genMode 状态机、
 * references 收集、提交编排都仍在 VideoNode 里**，本组件不持有它们。
 *
 * 面板的「收起/放大」壳体（OperationPanelShell）、在画布上的绝对定位、以及
 * 「生成失败」重试横幅（复用同一个 onSubmit/submitDisabled）都由宿主负责。
 */
export const VideoGenerationForm = memo((props: VideoGenerationFormProps) => {
  const {
    nodeId,
    cameraTemplates,
    cameraTemplatesLoading,
    cameraMovementId,
    onOpenCharacterLibrary,
    onOpenExternalAssets,
    genMode,
    genModeModelId,
    genModeSupportedModes,
    genModeUpstreamCounts,
    upstreamTextContents,
    onDetachUpstream,
    referenceMediaItems,
    referenceCaps,
    prompt,
    onPromptChange,
    onCompositionStart,
    onCompositionEnd,
    mentionCandidates,
    upstreamTextJoined,
    modelId,
    onModelChange,
    modelUpstreamCounts,
    aspectRatio,
    aspectRatioOptions,
    quality,
    qualityOptions,
    durationSec,
    durationBounds,
    sceneOptimize,
    sceneOptimizeOptions,
    generateAudio,
    showHumanReview,
    humanReview,
    modelParameters,
    modelParams,
    count,
    isTranslatingPrompt,
    isGenerating,
    translateDisabled,
    onTranslate,
    totalCreditCostDisplay,
    creditPromotion,
    submitDisabled,
    submitDisabledReason,
    onSubmit,
    compact = false,
  } = props;

  const { t } = useTranslation();
  // `submitDisabled` already carries the org admission block from the owning
  // node; this is only for the button's title, so a blocked member is told why.
  const modelTaskAccess = useModelTaskAccess();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const promptEditorRef = useRef<PromptMentionEditorHandle | null>(null);

  // 弹层与编辑器同在面板里、编辑器恒已挂载，故插入直接走命令式 API，回调保持稳定引用
  // （无需依赖 prompt，避免每次按键重建回调、连带调色盘按钮重渲染）。
  const insertContextPaletteEntry = useCallback(
    (entry: ContextPromptPaletteEntry) => {
      promptEditorRef.current?.insertTextAtCursor(
        contextPromptPaletteInsertionText(entry),
      );
    },
    [],
  );

  return (
    <>
      <div
        className={`flex shrink-0 items-center overflow-x-auto px-3 pb-2 ${
          compact ? "" : "pr-10 "
        }pt-3`}
      >
        <div className="flex shrink-0 items-center gap-2">
          <CameraMovementChip
            templates={cameraTemplates}
            isLoading={cameraTemplatesLoading}
            selectedId={cameraMovementId}
            onChange={(nextId) =>
              updateNodeData(nodeId, { cameraMovement: nextId })
            }
          />
          <CharacterLibraryChip onOpen={onOpenCharacterLibrary} />
          {onOpenExternalAssets ? (
            <ExternalAssetChip onOpen={onOpenExternalAssets} />
          ) : null}
        </div>
        <div className="ml-3 flex shrink-0 items-center gap-3">
          <GenModeSelect
            value={genMode}
            modelId={genModeModelId}
            supportedModes={genModeSupportedModes}
            upstreamCounts={genModeUpstreamCounts}
            // 换模式要顺手裁掉只属于上一个模式的自定义参数：参数表是按模式声明
            // 的，留着的键会原样发给后端，轻则被忽略重则报参数不合法。
            onChange={(nextMode) =>
              updateNodeData(nodeId, {
                genMode: nextMode,
                modelParams: filterMediaModelParamsForMode(
                  modelParameters,
                  modelParams,
                  nextMode,
                ),
              })
            }
          />
          <NodeContextPromptPaletteButton
            nodeId={nodeId}
            onInsert={insertContextPaletteEntry}
          />
          {upstreamTextContents.map((content) => (
            <ReferenceTextChip
              key={`upstream-text-${content.nodeId}`}
              nodeId={content.nodeId}
              text={content.text ?? ""}
              sourceLabel={content.displayName ?? content.nodeType}
              onDetach={onDetachUpstream}
            />
          ))}
        </div>
        {referenceMediaItems.length > 0 && (
          <ReferenceMediaRow
            items={referenceMediaItems}
            caps={referenceCaps}
            genMode={genMode}
            onFocus={(focusNodeId) => setSelectedNode(focusNodeId)}
            onDetach={onDetachUpstream}
            onReorder={(ids) => updateNodeData(nodeId, { referenceOrder: ids })}
          />
        )}
      </div>

      <PromptMentionEditor
        ref={promptEditorRef}
        value={prompt}
        onChange={onPromptChange}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        onKeyDown={(event) => event.stopPropagation()}
        candidates={mentionCandidates}
        placeholder={
          upstreamTextJoined.length > 0
            ? "上游内容已自动接入，可继续补充提示词…"
            : t("node.videoNode.placeholder")
        }
        className={`nodrag nowheel min-h-0 w-full flex-1 overflow-y-auto whitespace-pre-wrap break-words border-none bg-transparent px-3 py-2 text-sm leading-6 text-text-dark outline-none ${CANVAS_NODE_INPUT_PLACEHOLDER_CLASS}`}
      />

      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <ProviderModelPicker
            selectedModelId={modelId}
            onChange={onModelChange}
            domain="video"
            popoverPlacement="top"
            getOptionDisabledReason={(model) =>
              videoModelReferenceDisabledReason(
                model,
                modelUpstreamCounts,
              )
            }
          />
          <VideoConfigChip
            aspectRatio={aspectRatio}
            aspectRatioOptions={aspectRatioOptions}
            quality={quality}
            qualityOptions={qualityOptions}
            durationSec={durationSec}
            durationBounds={durationBounds}
            sceneOptimize={sceneOptimize}
            sceneOptimizeOptions={sceneOptimizeOptions}
            generateAudio={generateAudio}
            onChange={(patch) => updateNodeData(nodeId, patch)}
          />
          <MediaModelParameterChip
            parameters={modelParameters}
            values={modelParams}
            mode={genMode}
            onChange={(next) => updateNodeData(nodeId, { modelParams: next })}
          />
          {showHumanReview && (
            <button
              type="button"
              role="switch"
              aria-checked={humanReview}
              title="素材含真实人脸时开启，可能增加审核时间，不保证通过。"
              onClick={(event) => {
                event.stopPropagation();
                updateNodeData(nodeId, { humanReview: !humanReview });
              }}
              className={`nodrag inline-flex h-7 items-center gap-1.5 rounded px-1 text-xs font-medium transition-colors ${
                humanReview
                  ? "text-text-dark"
                  : "text-text-dark/72 hover:text-text-dark"
              }`}
            >
              <span>真人验证</span>
              <span
                className={`relative inline-flex h-3.5 w-6 shrink-0 items-center rounded-full transition-colors ${
                  humanReview
                    ? "bg-[rgb(var(--accent-rgb))]"
                    : "bg-white/15"
                }`}
              >
                <span
                  className={`inline-block h-2.5 w-2.5 transform rounded-full bg-white transition-transform ${
                    humanReview ? "translate-x-3" : "translate-x-0.5"
                  }`}
                />
              </span>
            </button>
          )}
          <CountPicker
            value={count}
            onChange={(nextCount) => updateNodeData(nodeId, { count: nextCount })}
          />
          <button
            type="button"
            title="翻译提示词（中英文互译）"
            disabled={translateDisabled}
            onClick={(event) => {
              event.stopPropagation();
              onTranslate();
            }}
            className={`${NODE_INLINE_ICON_BUTTON_CLASS} ${
              isTranslatingPrompt
                ? NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS
                : ""
            }`}
          >
            {isTranslatingPrompt ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Languages className="h-4 w-4" />
            )}
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <CreditCostPill
            display={totalCreditCostDisplay}
            promotion={creditPromotion}
            disabled={submitDisabled}
            className={NODE_CREDIT_PILL_FLAT_CLASS}
          />
          <button
            type="button"
            disabled={submitDisabled}
            title={
              isGenerating
                ? t("node.videoNode.submitBusy")
                : (modelTaskAccess.message ?? submitDisabledReason ??
                  t("node.videoNode.submit"))
            }
            onClick={(event) => {
              event.stopPropagation();
              onSubmit();
            }}
            className={`${NODE_GENERATE_BUTTON_BASE_CLASS} ${
              submitDisabled
                ? NODE_GENERATE_BUTTON_DISABLED_CLASS
                : NODE_GENERATE_BUTTON_ENABLED_CLASS
            }`}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </div>
    </>
  );
});

VideoGenerationForm.displayName = "VideoGenerationForm";
