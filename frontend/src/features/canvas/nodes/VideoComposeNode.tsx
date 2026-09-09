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
import { readUrl } from "@/lib/url-params";
import {
  buildInitialTimeline,
  reconcileDraftWithUpstream,
  VideoComposeModal,
} from "@/features/canvas/compose/VideoComposeModal";
import {
  buildComposePayload,
  hasExportableClips,
  hasOverlappingVideoClips,
  type ComposeTimelineState,
} from "@/features/canvas/compose/timelineModel";
import { fetchFreezoneJobResult, submitFreezoneVideoCompose } from "@/api/ops";
import { awaitTaskCompletion } from "@/api/tasks";
import { orderedComposeSeedNodeIds } from "@/features/canvas/compose/composeInputOrdering";
import {
  publishNodeActionAccepted,
  publishNodeActionError,
  publishNodeActionSuccess,
  subscribeNodeAction,
} from "@/features/canvas/application/nodeActionResult";

type VideoComposeNodeProps = NodeProps & {
  id: string;
  data: VideoComposeNodeData;
  selected?: boolean;
};

const NODE_WIDTH = 240;
const NODE_HEIGHT = 136;
const MIN_UPSTREAM_VIDEOS = 2;
const MIN_AUTO_COMPOSE_VIDEOS = 1;
const MIN_AUTO_COMPOSE_MEDIA = 2;

export const VideoComposeNode = memo(
  ({ id, data, selected }: VideoComposeNodeProps) => {
    const { t } = useTranslation();
    const updateNodeInternals = useUpdateNodeInternals();
    const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
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
      setSelectedNode(id);
      setEditorOpen(true);
      return true;
    }, [canOpen, id, project, setSelectedNode]);

    const handleAutoCompose = useCallback(async () => {
      if (!project || !canAutoCompose) {
        throw new Error("自动合成至少需要 1 个视频和共计 2 个已完成媒体节点");
      }
      const draft = data.draftTimeline as ComposeTimelineState | undefined;
      const timeline = draft?.tracks?.length
        ? reconcileDraftWithUpstream(draft, seedNodeIds)
        : buildInitialTimeline(seedNodeIds);
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
        await awaitTaskCompletion(ref.task_key, project);
        const result = await fetchFreezoneJobResult(
          project,
          "freezone_video_compose",
          ref.job_id,
        );
        if (!result.url) throw new Error("视频合成完成但未返回成片地址");
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
          resultVideoUrl: result.url,
          previewImageUrl: resultCoverUrl,
          resolution: timeline.resolution,
          draftTimeline: timeline,
          isGenerating: false,
          generationStartedAt: null,
          generationError: null,
        });
        return { videoUrl: result.url, output_url: result.url };
      } catch (error) {
        updateNodeData(id, {
          isGenerating: false,
          generationStartedAt: null,
          generationError: error instanceof Error ? error.message : String(error),
        });
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
              className="flex h-10 w-full items-center justify-center rounded-[12px] border border-white/15 bg-white/[0.04] px-4 text-center text-[13px] text-text-dark transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-45"
            >
              {t("videoCompose.node.open")}
            </button>
            <span className="text-[12px] text-text-muted/90">
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
              // 合成完成：在本节点下游新建一个视频节点承载结果，并连边、聚焦。
              // 封面（若设置）写进结果视频节点 + 本合成节点的 previewImageUrl。
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
              store.setSelectedNode(newId);
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
