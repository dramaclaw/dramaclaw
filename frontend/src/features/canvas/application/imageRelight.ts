// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  fetchFreezoneJobResult,
  submitFreezoneRelight,
  type FreezoneRelightKeyLightDirection,
} from '@/api/ops';
import { awaitTaskCompletion, isTaskPollTimeoutError } from '@/api/tasks';
import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
} from '@/features/canvas/domain/canvasNodes';
import { inheritMainlineFields } from '@/features/canvas/domain/inheritMainlineFields';
import type {
  LightEditorSubmitPayload,
  LightMainLightDescriptor,
  LightSmartModeDescriptor,
} from '@/features/canvas/ui/LightEditorPanel';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { generationTaskDescriptor } from './resumeGeneration';
import { notifyTaskStillRunning } from './errorDialog';

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

export interface RelightImageResult {
  /** 新建的 exportImage 结果节点 id。 */
  nodeId: string;
  /** 后台链（提交 → 轮询 → 回填/写错）settle 时 resolve（不 reject）。 */
  completion: Promise<void>;
}

/**
 * 重打光生成编排（从 LightEditorOverlay.handleSubmit 原样搬出，语义零变化）：
 * 同步在源节点下游建 isGenerating 的 exportImage 结果节点并连边（经
 * inheritMainlineFields 继承主线字段——1→1 relight，新节点仍代表同一 canonical
 * slot 的另一候选），然后提交 /freezone/relight → 等任务完成 → 回填产物 url；
 * 失败把错误写到结果节点。
 *
 * @param payload LightEditorPanel 的提交载荷（亮度 / 色温 / 主光方向 / 轮廓光 /
 *   智能模式 / 模型 / 画质）。
 * @returns 结果节点 id + 后台链 completion；缺 project 或源节点已不存在时返回 null。
 */
export function relightImage(
  sourceNodeId: string,
  imageSource: string,
  payload: LightEditorSubmitPayload,
): RelightImageResult | null {
  const project = readUrl().project;
  if (!project) {
    console.error('[light-editor] no project in URL — cannot submit');
    return null;
  }
  const store = useCanvasStore.getState();
  const node = store.nodes.find((candidate) => candidate.id === sourceNodeId);
  if (!node) {
    return null;
  }

  const sourceAspectRatio =
    typeof (node.data as { aspectRatio?: unknown }).aspectRatio === 'string'
      ? ((node.data as { aspectRatio?: string }).aspectRatio ?? DEFAULT_ASPECT_RATIO)
      : DEFAULT_ASPECT_RATIO;
  const position = store.findNodePosition(
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
  const nextNodeId = store.addNode(
    CANVAS_NODE_TYPES.exportImage,
    position,
    initialData as unknown as Parameters<typeof store.addNode>[2],
  );
  store.addEdge(node.id, nextNodeId);

  const completion = (async () => {
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
      useCanvasStore.getState().updateNodeData(nextNodeId, generationTaskDescriptor(ref));
      const completed = await awaitTaskCompletion(ref.task_key, project, {
        taskType: ref.task_type,
      });
      const directUrl = completed.result?.['output_url'] as string | undefined;
      let url = directUrl;
      if (!url) {
        const fallback = await fetchFreezoneJobResult(project, ref.task_type, ref.job_id);
        url = fallback.url;
      }
      useCanvasStore.getState().updateNodeData(nextNodeId, {
        imageUrl: url,
        previewImageUrl: url,
        isGenerating: false,
        generationStartedAt: null,
        generationError: null,
      });
    } catch (err) {
      if (isTaskPollTimeoutError(err)) {
        notifyTaskStillRunning();
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error('[light-editor] generation failed', err);
      useCanvasStore.getState().updateNodeData(nextNodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: message,
      });
    }
  })();

  return { nodeId: nextNodeId, completion };
}
