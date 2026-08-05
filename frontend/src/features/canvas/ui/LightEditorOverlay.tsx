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
  LightEditorPanel,
  type LightEditorSubmitPayload,
  type LightMainLightDescriptor,
  type LightSmartModeDescriptor,
} from '@/features/canvas/ui/LightEditorPanel';
import {
  fetchFreezoneJobResult,
  submitFreezoneRelight,
  type FreezoneRelightKeyLightDirection,
} from '@/api/ops';
import { awaitTaskCompletion, isTaskPollTimeoutError } from '@/api/tasks';
import { notifyTaskStillRunning } from '@/features/canvas/application/errorDialog';
import { generationTaskDescriptor } from '@/features/canvas/application/resumeGeneration';
import { readUrl } from '@/lib/url-params';
import { inheritMainlineFields } from '@/features/canvas/domain/inheritMainlineFields';
import { NODE_TOOLBAR_CLASS } from './nodeToolbarConfig';
import { ZoomScaledToolbar } from './ZoomScaledToolbar';

export interface LightEditorRequestPayload {
  sourceNodeId: string;
  imageSource: string;
  brightness: number;
  color: string;
  mainLight: LightMainLightDescriptor;
  rimLight: boolean;
  smartMode: LightSmartModeDescriptor;
  prompt: string;
  displayName: string;
  generationMode: 'image_reference';
  requestAspectRatio: 'auto';
  submittedAt: string;
}

interface LightEditorOverlayProps {
  node: CanvasNode;
  imageSource: string;
  onClose: () => void;
}

const KEY_LIGHT_DIRECTIONS: readonly FreezoneRelightKeyLightDirection[] = [
  'left',
  'top',
  'right',
  'front',
  'bottom',
  'back',
] as const;

function resolveKeyLightDirection(
  mainLight: LightMainLightDescriptor,
): FreezoneRelightKeyLightDirection {
  const candidate = mainLight.nearestPreset;
  if (candidate && (KEY_LIGHT_DIRECTIONS as readonly string[]).includes(candidate)) {
    return candidate as FreezoneRelightKeyLightDirection;
  }
  return 'front';
}

function buildRelightPrompt(smart: LightSmartModeDescriptor): string {
  if (!smart.enabled) return '';
  const parts: string[] = [];
  if (smart.prompt) parts.push(smart.prompt);
  if (smart.presetPrompt) parts.push(smart.presetPrompt);
  return parts.join('\n');
}

export const LightEditorOverlay = memo(
  ({ node, imageSource, onClose }: LightEditorOverlayProps) => {
    const { t } = useTranslation();
    const addNode = useCanvasStore((state) => state.addNode);
    const addEdge = useCanvasStore((state) => state.addEdge);
    const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
    const findNodePosition = useCanvasStore((state) => state.findNodePosition);
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);

    const handleSubmit = useCallback(
      async (payload: LightEditorSubmitPayload) => {
        const project = readUrl().project;
        if (!project) {
          console.error('[light-editor] no project in URL — cannot submit');
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
        // 1→1 relight: child inherits source's mainline fields (mainline_context
        // + slot_target + committed_slot_url) so the new node still represents
        // "another candidate for the same canonical slot" — Push lands the
        // original Push target. inheritMainlineFields stamps user_spawned: true
        // and refuses to set preset_managed.
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
          const ref = await submitFreezoneRelight(project, {
            sourceUrl: imageSource.split('?')[0],
            lightingReferenceUrl: null,
            scope: 'global',
            smartMode: payload.smartMode.enabled,
            brightness: payload.brightness,
            colorHex: payload.color,
            colorTemperatureKelvin: payload.colorTemperatureKelvin,
            keyLightDirection: resolveKeyLightDirection(payload.mainLight),
            rimLight: payload.rimLight,
            prompt: buildRelightPrompt(payload.smartMode),
            imageSize: payload.imageSize,
            model: payload.apiModel,
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
          console.error('[light-editor] generation failed', err);
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
          <LightEditorPanel
            imageSource={imageSource}
            onClose={onClose}
            onSubmit={handleSubmit}
          />
        </ZoomScaledToolbar>
      </ReactFlowNodeToolbar>
    );
  }
);

LightEditorOverlay.displayName = 'LightEditorOverlay';
