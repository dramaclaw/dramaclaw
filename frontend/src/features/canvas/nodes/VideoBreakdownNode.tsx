// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from "@xyflow/react";
import { Loader2, MousePointerClick, ScanSearch, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { useCanvasStore } from "@/stores/canvasStore";
import { useCanvasPickStore } from "@/stores/canvasPickStore";
import { useUpstreamNodes } from "@/features/canvas/application/useUpstreamGraph";
import {
  CANVAS_NODE_TYPES,
  VIDEO_BREAKDOWN_DIMENSIONS,
  isVideoNode,
  type VideoBreakdownDimension,
  type VideoBreakdownNodeData,
} from "@/features/canvas/domain/canvasNodes";
import { resolveNodeDisplayName } from "@/features/canvas/domain/nodeDisplay";
import {
  NodeHeader,
  NODE_HEADER_FLOATING_POSITION_CLASS,
} from "@/features/canvas/ui/NodeHeader";
import {
  CANVAS_NODE_INPUT_SURFACE_CLASS,
  canvasNodeFrameClass,
} from "@/features/canvas/ui/nodeFrameStyles";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import { ensureWebSafeVideo } from "@/features/canvas/application/videoTranscode";
import {
  isVideoFile,
  VIDEO_FILE_ACCEPT,
} from "@/features/canvas/application/videoFileTypes";
import {
  submitFreezoneVideoBreakdown,
  uploadFreezoneVideo,
  type FreezoneVideoBreakdownResult,
} from "@/api/ops";
import { awaitTaskCompletion } from "@/api/tasks";
import { readUrl } from "@/lib/url-params";

type VideoBreakdownNodeProps = NodeProps & {
  id: string;
  data: VideoBreakdownNodeData;
  selected?: boolean;
};

const NODE_WIDTH = 300;
const NODE_HEIGHT = 292;

/** 本节点只服务 seedance 2.5 的拉片能力，角标写死，不做模型选择。 */
const TARGET_MODEL_BADGE = "SD 2.5";

export const VideoBreakdownNode = memo(
  ({ id, data, selected }: VideoBreakdownNodeProps) => {
    const { t } = useTranslation();
    const updateNodeInternals = useUpdateNodeInternals();
    const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);
    const addVideoBreakdownGroups = useCanvasStore(
      (state) => state.addVideoBreakdownGroups,
    );
    const startPick = useCanvasPickStore((state) => state.startPick);
    const upstreamNodes = useUpstreamNodes(id);

    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [isSourceMenuOpen, setSourceMenuOpen] = useState(false);

    useEffect(() => {
      updateNodeInternals(id);
    }, [id, updateNodeInternals]);

    // 上游连着的视频节点优先：那根边就是「素材从哪来」的事实来源，断开边就该退回
    // 空态。本地上传没有上游边，落在 data.sourceVideoUrl 上。
    const upstreamVideo = useMemo(
      () =>
        upstreamNodes.find((node) => isVideoNode(node) && Boolean(node.data.videoUrl)) ??
        null,
      [upstreamNodes],
    );
    const videoUrl =
      (upstreamVideo && isVideoNode(upstreamVideo)
        ? upstreamVideo.data.videoUrl
        : null) ?? data.sourceVideoUrl ?? null;
    const sourceLabel =
      (upstreamVideo
        ? resolveNodeDisplayName(CANVAS_NODE_TYPES.video, upstreamVideo.data)
        : data.sourceFileName) ?? null;

    const videoSource = videoUrl ? resolveImageDisplayUrl(videoUrl) : null;
    const isUploading = Boolean(data.isUploading);
    const isBreakingDown = Boolean(data.isBreakingDown);
    const breakdownError =
      typeof data.breakdownError === "string" && data.breakdownError.length > 0
        ? data.breakdownError
        : null;

    const dimensions = useMemo<VideoBreakdownDimension[]>(
      () =>
        Array.isArray(data.dimensions) && data.dimensions.length > 0
          ? data.dimensions
          : [...VIDEO_BREAKDOWN_DIMENSIONS],
      [data.dimensions],
    );

    const resolvedTitle = useMemo(
      () => resolveNodeDisplayName(CANVAS_NODE_TYPES.videoBreakdown, data),
      [data],
    );
    const cardToneClass = canvasNodeFrameClass({ selected });

    const toggleDimension = useCallback(
      (dimension: VideoBreakdownDimension) => {
        const next = dimensions.includes(dimension)
          ? dimensions.filter((item) => item !== dimension)
          : [...VIDEO_BREAKDOWN_DIMENSIONS].filter(
              (item) => item === dimension || dimensions.includes(item),
            );
        // 至少留一个维度，全关掉的话「开始拉片」就没有任何产出。
        if (next.length === 0) return;
        updateNodeData(id, { dimensions: next });
      },
      [dimensions, id, updateNodeData],
    );

    const processFile = useCallback(
      async (file: File) => {
        if (!isVideoFile(file)) return;
        const projectId = readUrl().project;
        if (!projectId) {
          console.error("[video-breakdown] no project in URL");
          return;
        }
        updateNodeData(id, { sourceFileName: file.name, isUploading: true });
        try {
          // 与视频节点同源的处理：HEVC 等 Web 不兼容编码先转 H.264 再上传，
          // 否则 Edge 这类没有对应解码器的浏览器只有声音没画面。
          const prepared = await ensureWebSafeVideo(file);
          const uploaded = await uploadFreezoneVideo(
            projectId,
            prepared.file,
            prepared.file.name,
          );
          updateNodeData(id, {
            sourceVideoUrl: uploaded.url,
            sourceFileName: file.name,
            sourceNodeId: null,
            isUploading: false,
          });
        } catch (error) {
          console.error("[video-breakdown] upload failed", error);
          updateNodeData(id, { isUploading: false, sourceFileName: null });
          toast.error(t("videoBreakdown.uploadFailed"));
        }
      },
      [id, t, updateNodeData],
    );

    const handleFileChange = useCallback(
      async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) await processFile(file);
        event.target.value = "";
      },
      [processFile],
    );

    const handlePickFromCanvas = useCallback(() => {
      setSourceMenuOpen(false);
      startPick({ requesterNodeId: id, kind: "video" });
    }, [id, startPick]);

    const handleStartBreakdown = useCallback(async () => {
      if (!videoUrl || isBreakingDown) return;
      const projectId = readUrl().project;
      if (!projectId) {
        console.error("[video-breakdown] no project in URL");
        return;
      }

      updateNodeData(id, {
        isBreakingDown: true,
        breakdownStartedAt: Date.now(),
        breakdownError: null,
      });

      try {
        const ref = await submitFreezoneVideoBreakdown(projectId, {
          videoUrl,
          dimensions,
        });
        const taskKey =
          typeof ref?.task_key === "string" ? ref.task_key : null;
        // 端点正常走异步任务（返回 task_key）；同步返回结果时直接当结果用，
        // 与视频解读那条链路保持一致。
        const result = taskKey
          ? ((((
              await awaitTaskCompletion(taskKey, projectId, {
                taskType: ref.task_type,
              })
            ).result ?? {}) as unknown) as FreezoneVideoBreakdownResult)
          : (ref as unknown as FreezoneVideoBreakdownResult);

        const groupIds = addVideoBreakdownGroups(id, result, {
          storyboardFallbackLabel: (index) =>
            t("videoBreakdown.groups.storyboard", {
              index: String(index).padStart(2, "0"),
            }),
          motionFallbackLabel: t("videoBreakdown.groups.motion"),
          musicFallbackLabel: t("videoBreakdown.groups.music"),
        });

        if (!groupIds || groupIds.length === 0) {
          // 任务成功但三个维度一个产出都没有（例如全维度关掉、或源视频无音轨且
          // 抽帧全失败）——不能静默，否则用户看不到任何反馈。
          updateNodeData(id, {
            isBreakingDown: false,
            breakdownError: t("videoBreakdown.emptyResult"),
          });
          toast.error(t("videoBreakdown.emptyResult"));
          return;
        }

        updateNodeData(id, { isBreakingDown: false, breakdownError: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[video-breakdown] failed", error);
        updateNodeData(id, { isBreakingDown: false, breakdownError: message });
        toast.error(t("videoBreakdown.failed"));
      }
    }, [
      addVideoBreakdownGroups,
      dimensions,
      id,
      isBreakingDown,
      t,
      updateNodeData,
      videoUrl,
    ]);

    return (
      <div
        className="group relative h-full w-full overflow-visible"
        style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
        onClick={() => setSelectedNode(id)}
      >
        <Handle
          type="target"
          position={Position.Left}
          id="target"
          className="!h-2 !w-2 !border-0 !bg-[rgb(148,163,184)]"
        />
        <Handle
          type="source"
          position={Position.Right}
          id="source"
          className="!h-2 !w-2 !border-0 !bg-[rgb(148,163,184)]"
        />

        <NodeHeader
          className={NODE_HEADER_FLOATING_POSITION_CLASS}
          icon={<ScanSearch className="h-4 w-4" />}
          titleText={resolvedTitle}
          editable
          onTitleChange={(next) => updateNodeData(id, { displayName: next })}
        />

        <div
          className={`relative flex h-full w-full flex-col gap-3 overflow-hidden rounded-[var(--node-radius)] border p-3 ${CANVAS_NODE_INPUT_SURFACE_CLASS} ${cardToneClass}`}
        >
          <div className="flex items-center justify-between">
            <span className="text-[12px] leading-none text-text-muted/90">
              {t("videoBreakdown.sourceLabel")}
            </span>
            <span className="rounded-full border border-cyan-300/25 bg-cyan-300/[0.12] px-2 py-0.5 text-[11px] font-medium leading-none text-cyan-200">
              {TARGET_MODEL_BADGE}
            </span>
          </div>

          <div className="relative">
            {videoSource ? (
              <div className="relative h-[120px] w-full overflow-hidden rounded-[10px] border border-white/12 bg-black/40">
                <video
                  src={videoSource}
                  className="h-full w-full object-cover"
                  muted
                  playsInline
                  preload="metadata"
                />
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/75 to-transparent px-2 py-1.5">
                  <span className="max-w-[60%] overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-white/85">
                    {sourceLabel ?? t("videoBreakdown.attached")}
                  </span>
                  <button
                    type="button"
                    className="nodrag rounded-md border border-white/20 bg-black/45 px-2 py-0.5 text-[11px] text-white/85 transition-colors hover:bg-black/65"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSourceMenuOpen((open) => !open);
                    }}
                  >
                    {t("videoBreakdown.replace")}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                disabled={isUploading}
                onClick={(event) => {
                  event.stopPropagation();
                  setSourceMenuOpen((open) => !open);
                }}
                className="nodrag flex h-[120px] w-full flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed border-white/18 bg-white/[0.02] text-text-muted transition-colors hover:border-white/28 hover:bg-white/[0.04] disabled:cursor-progress"
              >
                {isUploading ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin text-white/60" />
                    <span className="text-[12px]">
                      {t("videoBreakdown.uploading")}
                    </span>
                  </>
                ) : (
                  <>
                    <Upload className="h-5 w-5 text-white/45" />
                    <span className="text-[12px]">
                      {t("videoBreakdown.emptyHint")}
                    </span>
                  </>
                )}
              </button>
            )}

            {isSourceMenuOpen && (
              <>
                {/* 点空白关菜单。放在菜单下面一层，覆盖整块画布区域。 */}
                <div
                  className="fixed inset-0 z-30"
                  onClick={(event) => {
                    event.stopPropagation();
                    setSourceMenuOpen(false);
                  }}
                />
                <div className="absolute left-1/2 top-1/2 z-40 w-[168px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[10px] border border-white/12 bg-[#242426] p-1 shadow-[0_12px_28px_rgba(0,0,0,0.45)]">
                  <button
                    type="button"
                    className="nodrag flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] text-text-dark transition-colors hover:bg-white/[0.08]"
                    onClick={(event) => {
                      event.stopPropagation();
                      setSourceMenuOpen(false);
                      fileInputRef.current?.click();
                    }}
                  >
                    <Upload className="h-3.5 w-3.5 text-white/55" />
                    {t("videoBreakdown.uploadVideo")}
                  </button>
                  <button
                    type="button"
                    className="nodrag flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px] text-text-dark transition-colors hover:bg-white/[0.08]"
                    onClick={(event) => {
                      event.stopPropagation();
                      handlePickFromCanvas();
                    }}
                  >
                    <MousePointerClick className="h-3.5 w-3.5 text-white/55" />
                    {t("videoBreakdown.pickFromCanvas")}
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-[12px] leading-none text-text-muted/90">
              {t("videoBreakdown.dimensionsLabel")}
            </span>
            <div className="flex items-center gap-1.5">
              {VIDEO_BREAKDOWN_DIMENSIONS.map((dimension) => {
                const active = dimensions.includes(dimension);
                return (
                  <button
                    key={dimension}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleDimension(dimension);
                    }}
                    className={`nodrag flex-1 rounded-full border px-2 py-1 text-[12px] leading-none transition-colors ${
                      active
                        ? "border-cyan-300/30 bg-cyan-300/[0.14] text-cyan-100"
                        : "border-white/12 bg-white/[0.03] text-text-muted hover:bg-white/[0.06]"
                    }`}
                  >
                    {t(`videoBreakdown.dimension.${dimension}`)}
                  </button>
                );
              })}
            </div>
          </div>

          {breakdownError && !isBreakingDown ? (
            <p className="line-clamp-2 text-[11px] leading-tight text-red-300/90">
              {breakdownError}
            </p>
          ) : null}

          <button
            type="button"
            disabled={!videoSource || isBreakingDown}
            onClick={(event) => {
              event.stopPropagation();
              void handleStartBreakdown();
            }}
            className="nodrag mt-auto flex h-9 w-full items-center justify-center gap-2 rounded-[10px] border border-white/15 bg-white/[0.06] text-[13px] text-text-dark transition-colors hover:bg-white/[0.1] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {isBreakingDown && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {isBreakingDown
              ? t("videoBreakdown.running")
              : t("videoBreakdown.start")}
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept={VIDEO_FILE_ACCEPT}
          className="hidden"
          onChange={handleFileChange}
        />
      </div>
    );
  },
);

VideoBreakdownNode.displayName = "VideoBreakdownNode";
