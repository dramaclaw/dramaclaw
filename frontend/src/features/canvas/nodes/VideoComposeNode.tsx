// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from "@xyflow/react";
import { Film } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useCanvasStore } from "@/stores/canvasStore";
import { selectNodeExclusively } from "@/features/canvas/application/nodeSelection";
import { useUpstreamNodes } from "@/features/canvas/application/useUpstreamGraph";
import {
  CANVAS_NODE_TYPES,
  isVideoNode,
  type CanvasNodeData,
  type VideoComposeNodeData,
} from "@/features/canvas/domain/canvasNodes";
import { localizeNodeDisplayName } from "@/features/canvas/domain/nodeDisplay";
import {
  NodeHeader,
  NODE_HEADER_FLOATING_POSITION_CLASS,
} from "@/features/canvas/ui/NodeHeader";
import {
  CANVAS_NODE_INPUT_SURFACE_CLASS,
  canvasNodeFrameClass,
} from "@/features/canvas/ui/nodeFrameStyles";
import { AddNodeToChatButton } from "@/features/canvas/ui/AddNodeToChatButton";
import {
  NODE_PRIMARY_ACTION_BASE_CLASS,
  NODE_PRIMARY_ACTION_DISABLED_CLASS,
  NODE_PRIMARY_ACTION_ENABLED_CLASS,
} from "@/features/canvas/ui/nodeControlStyles";
import { readUrl, writeUrl } from "@/lib/url-params";
import {
  resolveComposeTimeline,
  VideoComposeModal,
} from "@/features/canvas/compose/VideoComposeModal";
import { openFilmStudioEnabled } from "@/lib/runtime-config";
import {
  buildComposePayload,
  hasExportableClips,
  hasOverlappingVideoClips,
  type ComposeTimelineState,
} from "@/features/canvas/compose/timelineModel";
import { fetchFreezoneJobResult, submitFreezoneVideoCompose } from "@/api/ops";
import { awaitTaskCompletion, isTaskPollTimeoutError } from "@/api/tasks";
import { notifyTaskStillRunning } from "@/features/canvas/application/errorDialog";
import { orderedComposeSeedNodeIds } from "@/features/canvas/compose/composeInputOrdering";
import {
  publishNodeActionAccepted,
  publishNodeActionError,
  publishNodeActionSuccess,
  subscribeNodeAction,
} from "@/features/canvas/application/nodeActionResult";
import {
  CLEARED_GENERATION_TASK_FIELDS,
  generationTaskDescriptor,
} from "@/features/canvas/application/resumeGeneration";
import {
  reconcileCompletedVideoComposeProjection,
} from "@/features/canvas/application/videoComposeProjection";

type VideoComposeNodeProps = NodeProps & {
  id: string;
  data: VideoComposeNodeData;
  selected?: boolean;
};

const NODE_WIDTH = 360;
const NODE_HEIGHT = 220;
const MIN_UPSTREAM_VIDEOS = 2;
const MIN_AUTO_COMPOSE_VIDEOS = 1;
const MIN_AUTO_COMPOSE_MEDIA = 2;

export const VideoComposeNode = memo(
  ({ id, data, selected }: VideoComposeNodeProps) => {
    const { t } = useTranslation();
    const updateNodeInternals = useUpdateNodeInternals();
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);
    const upstreamNodes = useUpstreamNodes(id);
    const [isEditorOpen, setEditorOpen] = useState(false);

    const seedNodeIds = useMemo(
      () => orderedComposeSeedNodeIds(upstreamNodes, data.compositionInputOrder),
      [data.compositionInputOrder, upstreamNodes],
    );
    const videoCount = useMemo(
      () =>
        upstreamNodes.filter(
          (node) => isVideoNode(node) && Boolean(node.data.videoUrl),
        ).length,
      [upstreamNodes],
    );
    const canOpen = videoCount >= MIN_UPSTREAM_VIDEOS;
    const canAutoCompose =
      videoCount >= MIN_AUTO_COMPOSE_VIDEOS && seedNodeIds.length >= MIN_AUTO_COMPOSE_MEDIA;

    const resolvedTitle = useMemo(
      () => localizeNodeDisplayName(CANVAS_NODE_TYPES.videoCompose, data, t),
      [data, t],
    );
    const cardToneClass = canvasNodeFrameClass({ selected });

    const project = readUrl().project;
    const canvasId = readUrl().canvas ?? "default";

    useEffect(() => {
      updateNodeInternals(id);
    }, [id, updateNodeInternals]);

    const handleOpen = useCallback(() => {
      if (!project) return false;
      if (!canOpen) return false;
      selectNodeExclusively(id);
      if (openFilmStudioEnabled()) {
        // 本机显式启用时，整页工作区由地址栏驱动：刷新、后退仍停在此节点。
        writeUrl({ compose: id });
      } else {
        // 默认和远程部署保留原时间线编辑器；Studio 只监听后端回环地址，不能把
        // 该地址交给另一台机器上的浏览器，也不能以公开共享端口绕过租户隔离。
        setEditorOpen(true);
      }
      return true;
    }, [canOpen, id, project]);

    const handleAutoCompose = useCallback(async () => {
      if (!project || !canAutoCompose) {
        throw new Error("自动合成至少需要 1 个视频和共计 2 个已完成媒体节点");
      }
      let taskCompleted = false;
      const draft = data.draftTimeline as ComposeTimelineState | undefined;
      const timeline = await resolveComposeTimeline(draft, seedNodeIds);
      if (!hasExportableClips(timeline)) throw new Error("视频合成没有可用素材");
      if (hasOverlappingVideoClips(timeline)) {
        throw new Error("视频轨道存在重叠片段，请先在时间线中调整");
      }
      updateNodeData(id, {
        isGenerating: true,
        generationStartedAt: Date.now(),
        generationError: null,
      });
      try {
        const ref = await submitFreezoneVideoCompose(
          project,
          buildComposePayload(timeline, {
            title: resolvedTitle,
            canvasId,
            nodeId: id,
            fps: 30,
          }),
        );
        updateNodeData(id, generationTaskDescriptor(ref));
        await awaitTaskCompletion(ref.task_key, project, {
          taskType: ref.task_type,
        });
        taskCompleted = true;
        const result = await fetchFreezoneJobResult(
          project,
          "freezone_video_compose",
          ref.job_id,
        );
        if (!result.url) throw new Error("视频合成完成但未返回成片地址");
        const projectionReconcile =
          await reconcileCompletedVideoComposeProjection({
            projectId: project,
            canvasId,
            nodeId: id,
            taskKey: ref.task_key,
            jobId: ref.job_id,
          });
        const output = {
          videoUrl: result.url,
          output_url: result.url,
          task_key: ref.task_key,
          task_type: ref.task_type,
          job_id: ref.job_id,
        };
        // The user navigated away while the task was finishing. The worker's
        // projection is already durable; do not write its result into whatever
        // canvas runtime is active now.
        if (projectionReconcile === "runtime_missing") return output;
        const resultCoverUrl = result.cover_url ?? timeline.cover?.url ?? null;
        const store = useCanvasStore.getState();
        const existingResult = store.nodes.find((node) =>
          isVideoNode(node) && node.data.composeSourceNodeId === id,
        );
        if (existingResult && isVideoNode(existingResult)) {
          store.updateNodeData(existingResult.id, {
            videoUrl: result.url,
            previewImageUrl: resultCoverUrl,
          });
        } else {
          const position = store.findNodePosition(id, 580, 380);
          const resultNodeId = store.addNode(CANVAS_NODE_TYPES.video, position, {
            videoUrl: result.url,
            previewImageUrl: resultCoverUrl,
            displayName: t("videoCompose.node.resultName"),
            sourceFileName: null,
            composeSourceNodeId: id,
          } as Partial<CanvasNodeData>);
          store.addEdge(id, resultNodeId);
        }
        updateNodeData(id, {
          ...CLEARED_GENERATION_TASK_FIELDS,
          resultVideoUrl: result.url,
          resultVideoTaskKey: ref.task_key,
          resultVideoJobId: ref.job_id,
          previewImageUrl: resultCoverUrl,
          resolution: timeline.resolution,
          draftTimeline: timeline,
          generationError: null,
        });
        return output;
      } catch (error) {
        if (isTaskPollTimeoutError(error)) {
          notifyTaskStillRunning(t);
          throw error;
        }
        // Once completion is observed, the worker may already have advanced
        // the server canvas revision. Keep the durable task descriptor intact
        // if fetching/rebasing the result fails; a refresh can recover it
        // without issuing another stale autosave.
        if (!taskCompleted) {
          updateNodeData(id, {
            ...CLEARED_GENERATION_TASK_FIELDS,
            generationError: error instanceof Error ? error.message : String(error),
          });
        }
        throw error;
      }
    }, [
      canAutoCompose,
      canvasId,
      data.draftTimeline,
      id,
      project,
      resolvedTitle,
      seedNodeIds,
      t,
      updateNodeData,
    ]);

    useEffect(
      () => subscribeNodeAction(({ nodeId, action, requestId }) => {
        if (nodeId !== id) return;
        if (action === "open_video_compose_modal") {
          publishNodeActionAccepted(requestId, id, action);
          if (!handleOpen()) {
            publishNodeActionError(requestId, id, action, "视频合成至少需要 2 个已完成视频输入");
            return;
          }
          publishNodeActionSuccess(requestId, id, action, { openedUiAction: true });
          return;
        }
        if (action !== "auto_compose_video") return;
        publishNodeActionAccepted(requestId, id, action);
        void handleAutoCompose()
          .then((output) => publishNodeActionSuccess(requestId, id, action, output))
          .catch((error) => publishNodeActionError(requestId, id, action, error));
      }),
      [handleAutoCompose, handleOpen, id],
    );

    return (
      <div
        className="group relative h-full w-full overflow-visible"
        style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
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

        <AddNodeToChatButton nodeId={id} />

        <NodeHeader
          className={NODE_HEADER_FLOATING_POSITION_CLASS}
          icon={<Film className="h-4 w-4" />}
          titleText={resolvedTitle}
          editable
          onTitleChange={(next) => updateNodeData(id, { displayName: next })}
        />

        <div
          className={`relative flex h-full w-full flex-col overflow-hidden rounded-[var(--node-radius)] border ${CANVAS_NODE_INPUT_SURFACE_CLASS} transition-colors ${cardToneClass}`}
        >
          {/* 入口节点只负责打开时间线编辑器；合成结果在下游视频节点承载。 */}
          <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-5 py-4 text-center">
            <button
              type="button"
              disabled={!canOpen}
              onClick={(event) => {
                event.stopPropagation();
                handleOpen();
              }}
              className={`${NODE_PRIMARY_ACTION_BASE_CLASS} ${canOpen ? NODE_PRIMARY_ACTION_ENABLED_CLASS : NODE_PRIMARY_ACTION_DISABLED_CLASS}`}
            >
              {t("videoCompose.node.open")}
            </button>
            <span className="text-[12px] leading-5 text-text-muted/90">
              {t("videoCompose.node.hint", { min: MIN_UPSTREAM_VIDEOS })}
            </span>
          </div>
        </div>

        {isEditorOpen && project && (
          <VideoComposeModal
            project={project}
            canvasId={canvasId}
            seedNodeIds={seedNodeIds}
            initialTimeline={
              (data.draftTimeline as ComposeTimelineState | undefined) ?? null
            }
            onPersistDraft={(timeline) =>
              updateNodeData(id, { draftTimeline: timeline })
            }
            onClose={() => setEditorOpen(false)}
            onComposed={(url, coverUrl) => {
              const store = useCanvasStore.getState();
              const position = store.findNodePosition(id, 580, 380);
              const newId = store.addNode(CANVAS_NODE_TYPES.video, position, {
                videoUrl: url,
                previewImageUrl: coverUrl,
                displayName: t("videoCompose.node.resultName"),
                sourceFileName: null,
                composeSourceNodeId: id,
              } as Partial<CanvasNodeData>);
              store.addEdge(id, newId);
              selectNodeExclusively(newId);
              store.requestFocusNode(newId);
              updateNodeData(id, {
                resultVideoUrl: url,
                previewImageUrl: coverUrl,
              });
              setEditorOpen(false);
            }}
          />
        )}
      </div>
    );
  },
);

VideoComposeNode.displayName = "VideoComposeNode";
