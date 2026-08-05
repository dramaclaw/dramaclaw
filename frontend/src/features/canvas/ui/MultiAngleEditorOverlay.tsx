// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback } from 'react';
import { NodeToolbar as ReactFlowNodeToolbar, Position } from '@xyflow/react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import {
  MultiAngleEditorPanel,
  type MultiAngleSubmitPayload,
  type MultiAnglePresetKey,
} from '@/features/canvas/ui/MultiAngleEditorPanel';
import {
  fetchFreezoneJobResult,
  submitFreezoneMultiView,
  type FreezoneMultiViewPreset,
} from '@/api/ops';
import { awaitTaskCompletion, isTaskPollTimeoutError } from '@/api/tasks';
import { notifyTaskStillRunning } from '@/features/canvas/application/errorDialog';
import { generationTaskDescriptor } from '@/features/canvas/application/resumeGeneration';
import { readUrl } from '@/lib/url-params';
import { inheritMainlineFields } from '@/features/canvas/domain/inheritMainlineFields';
import { NODE_TOOLBAR_CLASS } from './nodeToolbarConfig';
import { ZoomScaledToolbar } from './ZoomScaledToolbar';

interface MultiAngleEditorOverlayProps {
  node: CanvasNode;
  imageSource: string;
  onClose: () => void;
}

const PRESET_MAP: Record<MultiAnglePresetKey, FreezoneMultiViewPreset> = {
  custom: 'custom',
  fisheye: 'fisheye',
  tilted: 'oblique',
  frontTopDown: 'front',
  frontBottomUp: 'front_up',
  panoramaTopDown: 'custom',
  backView: 'back',
};

function normalizeYaw(deg: number): number {
  let v = ((deg + 180) % 360) - 180;
  if (v <= -180) v += 360;
  return v;
}

export const MultiAngleEditorOverlay = memo(
  ({ node, imageSource, onClose }: MultiAngleEditorOverlayProps) => {
    const { t } = useTranslation();
    const addNode = useCanvasStore((state) => state.addNode);
    const addEdge = useCanvasStore((state) => state.addEdge);
    const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
    const findNodePosition = useCanvasStore((state) => state.findNodePosition);
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);

    const handleSubmit = useCallback(
      async (payload: MultiAngleSubmitPayload) => {
        const project = readUrl().project;
        if (!project) {
          console.error('[multi-angle] no project in URL — cannot submit');
          return;
        }

        const sourceAspectRatio =
          typeof (node.data as { aspectRatio?: unknown }).aspectRatio === 'string'
            ? ((node.data as { aspectRatio?: string }).aspectRatio ?? DEFAULT_ASPECT_RATIO)
            : DEFAULT_ASPECT_RATIO;
        const position = findNodePosition(
          node.id,
          EXPORT_RESULT_NODE_DEFAULT_WIDTH,
          EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
        );
        const generationStartedAt = Date.now();
        // 1→1 spawn from MultiAngleEditor (one camera angle at a time).
        // User-confirmed: even when this overlay spawns N candidates in
        // sequence, all of them inherit the same slot_target — Push lands
        // whichever one the user picks. inheritMainlineFields stamps
        // user_spawned: true and refuses preset_managed.
        const initialData = inheritMainlineFields(
          { data: node.data as Record<string, unknown> },
          {
            displayName: payload.displayName,
            imageUrl: null,
            previewImageUrl: null,
            aspectRatio: sourceAspectRatio,
            resultKind: 'generic',
            isGenerating: true,
            generationStartedAt,
            generationDurationMs: 60000,
          },
        );
        const nextNodeId = addNode(
          CANVAS_NODE_TYPES.exportImage,
          position,
          initialData as unknown as Parameters<typeof addNode>[2],
        );
        addEdge(node.id, nextNodeId);
        setSelectedNode(nextNodeId);
        onClose();

        try {
          const ref = await submitFreezoneMultiView(project, {
            sourceUrl: imageSource.split('?')[0],
            preset: PRESET_MAP[payload.preset],
            yawDegrees: normalizeYaw(payload.horizontalDeg),
            pitchDegrees: payload.verticalDeg,
            shotSize: payload.zoom,
            prompt: payload.promptOverride ?? '',
            model: payload.apiModel,
            imageSize: payload.imageSize,
          });
          updateNodeData(nextNodeId, generationTaskDescriptor(ref));
          const completed = await awaitTaskCompletion(ref.task_key, project, { taskType: ref.task_type });
          const directUrl = completed.result?.['output_url'] as string | undefined;
          let url = directUrl;
          if (!url) {
            const fallback = await fetchFreezoneJobResult(project, ref.task_type, ref.job_id);
            url = fallback.url;
          }
          updateNodeData(nextNodeId, {
            imageUrl: url,
            previewImageUrl: url,
            isGenerating: false,
            generationStartedAt: null,
            generationError: null,
          });
        } catch (err) {
          // 轮询超时 ≠ 生成失败：后端还在跑，节点上的任务句柄仍可续接。
          // 写错误横幅会把一个还活着的任务标成失败，并清掉句柄。
          if (isTaskPollTimeoutError(err)) {
            notifyTaskStillRunning(t);
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          console.error('[multi-angle] generation failed', err);
          updateNodeData(nextNodeId, {
            isGenerating: false,
            generationStartedAt: null,
            generationError: message,
          });
        }
      },
      [
        addEdge,
        addNode,
        findNodePosition,
        imageSource,
        node,
        onClose,
        setSelectedNode,
        t,
        updateNodeData,
      ],
    );

    return (
      <ReactFlowNodeToolbar
        nodeId={node.id}
        isVisible
        position={Position.Bottom}
        align="start"
        offset={16}
        className={NODE_TOOLBAR_CLASS}
      >
        {/* 操作区跟随画布缩放（align=start → 锚点左上角，贴节点底边）。 */}
        <ZoomScaledToolbar origin="top left">
          <MultiAngleEditorPanel
            imageSource={imageSource}
            onClose={onClose}
            onSubmit={handleSubmit}
          />
        </ZoomScaledToolbar>
      </ReactFlowNodeToolbar>
    );
  },
);

MultiAngleEditorOverlay.displayName = 'MultiAngleEditorOverlay';
