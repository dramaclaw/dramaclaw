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
  isAudioNode,
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
import { readUrl } from "@/lib/url-params";
import { VideoComposeModal } from "@/features/canvas/compose/VideoComposeModal";
import type { ComposeTimelineState } from "@/features/canvas/compose/timelineModel";

type VideoComposeNodeProps = NodeProps & {
  id: string;
  data: VideoComposeNodeData;
  selected?: boolean;
};

const NODE_WIDTH = 240;
const NODE_HEIGHT = 136;
const MIN_UPSTREAM_VIDEOS = 2;

export const VideoComposeNode = memo(
  ({ id, data, selected }: VideoComposeNodeProps) => {
    const { t } = useTranslation();
    const updateNodeInternals = useUpdateNodeInternals();
    const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);
    const upstreamNodes = useUpstreamNodes(id);
    const [isEditorOpen, setEditorOpen] = useState(false);

    // 上游可用素材按 y 坐标排序，与时间线初始顺序一致。
    const seedNodeIds = useMemo(
      () =>
        [...upstreamNodes]
          .filter(
            (node) =>
              (isVideoNode(node) && node.data.videoUrl) ||
              (isAudioNode(node) && node.data.audioUrl),
          )
          .sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0))
          .map((node) => node.id),
      [upstreamNodes],
    );
    const videoCount = useMemo(
      () =>
        upstreamNodes.filter(
          (node) => isVideoNode(node) && Boolean(node.data.videoUrl),
        ).length,
      [upstreamNodes],
    );
    const canOpen = videoCount >= MIN_UPSTREAM_VIDEOS;

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
      if (!canOpen || !project) return;
      setEditorOpen(true);
    }, [canOpen, project]);

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
