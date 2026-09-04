// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type {
  CanvasNodeType,
  CanvasEdge,
  CanvasNode,
  CanvasNodeData,
} from '@/features/canvas/domain/canvasNodes';
// 这里取的是 i18next 默认实例（`@/i18n` 初始化的就是它）。不 import `@/i18n`
// 本身，是因为那个模块会顺带拉进 react-i18next / HttpBackend，把它塞进这条被
// 到处 import 的底层链路上，会让所有 mock 掉 react-i18next 的测试在 import 期炸掉。
import i18n from 'i18next';
import { uploadFreezoneImage } from '@/api/ops';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

type SelectedBackgroundTarget = {
  episode: number | string;
  beat: number | string;
};

type StageSelectedBackgroundOptions = {
  sourceSkillNodeId: string;
  label?: string;
  extraData?: Partial<CanvasNodeData> & Record<string, unknown>;
};

type StageSelectedBackgroundCandidateOptions = {
  sourceNodeId: string;
  label?: string;
};

type UploadSelectedBackgroundCandidateOptions = StageSelectedBackgroundCandidateOptions & {
  successMessage?: string;
};

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function edgeOutputRole(edge: CanvasEdge): string | null {
  const handleRole = typeof edge.sourceHandle === 'string' ? edge.sourceHandle.trim() : '';
  if (handleRole) return handleRole;
  const dataRole = (edge.data as { role?: unknown } | undefined)?.role;
  return typeof dataRole === 'string' && dataRole.trim() ? dataRole.trim() : null;
}

function selectedBackgroundOutputPatchForNode(
  node: CanvasNode,
  imageUrl: string,
  target: SelectedBackgroundTarget,
  options: StageSelectedBackgroundOptions,
): Partial<CanvasNodeData> {
  const nodeData = recordValue(node.data) ?? {};
  const fallbackLabel = options.label
    ?? i18n.t('viewer.threeD.selectedBackgroundOutputLabel');
  const displayName =
    typeof nodeData.displayName === 'string' && nodeData.displayName.trim()
      ? nodeData.displayName
      : fallbackLabel;
  return {
    displayName,
    imageUrl,
    previewImageUrl: imageUrl,
    aspectRatio: '16:9',
    user_spawned: true,
    preset_managed: false,
    committed_at: null,
    committed_slot_url: null,
    slot_target: {
      kind: 'selected_background',
      episode: Number(target.episode),
      beat: Number(target.beat),
    },
    candidate_origin: {
      skill_id: 'freezone.set_selected_background',
      skill_node_id: options.sourceSkillNodeId,
    },
    output_role: 'selected_background',
    media_kind: 'image',
    ...(options.extraData ?? {}),
  } as Partial<CanvasNodeData>;
}

function selectedBackgroundCandidatePosition(sourceNode: CanvasNode): { x: number; y: number } {
  return {
    x: sourceNode.position.x + 460,
    y: sourceNode.position.y + 40,
  };
}

export function stageSelectedBackgroundOutputForSkill(
  target: SelectedBackgroundTarget,
  imageUrl: string,
  options: StageSelectedBackgroundOptions,
): string | null {
  const state = useCanvasStore.getState();
  const outputEdge = state.edges.find(
    (edge) =>
      edge.source === options.sourceSkillNodeId &&
      edgeOutputRole(edge) === 'selected_background',
  );
  const outputNode = outputEdge
    ? state.nodes.find((node) => node.id === outputEdge.target)
    : undefined;

  if (outputNode) {
    useCanvasStore.getState().updateNodeData(
      outputNode.id,
      selectedBackgroundOutputPatchForNode(outputNode, imageUrl, target, options),
    );
    return outputNode.id;
  }

  const sourceNode = state.nodes.find((node) => node.id === options.sourceSkillNodeId);
  if (!sourceNode) {
    return null;
  }

  const nodeType: CanvasNodeType = CANVAS_NODE_TYPES.imageGen;
  const nodeId = useCanvasStore.getState().addNode(
    nodeType,
    selectedBackgroundCandidatePosition(sourceNode),
    {
      ...selectedBackgroundOutputPatchForNode(
        {
          ...sourceNode,
          id: `${options.sourceSkillNodeId}-selected-background-output`,
          type: nodeType,
          data: {},
        } as CanvasNode,
        imageUrl,
        target,
        options,
      ),
    } as Partial<CanvasNodeData>,
  );
  if (!nodeId) {
    return null;
  }
  useCanvasStore.getState().addEdgeWithData(
    options.sourceSkillNodeId,
    nodeId,
    {
      edgeKind: 'mainline_data',
      propagates: true,
      role: 'selected_background',
      label: i18n.t('viewer.threeD.selectedBackgroundOutputLabel'),
    },
    {
      id: `edge_${options.sourceSkillNodeId}_to_${nodeId}_selected_background`,
      sourceHandle: 'selected_background',
      targetHandle: 'target',
    },
  );
  return nodeId;
}

export function stageSelectedBackgroundCandidateFromNode(
  target: SelectedBackgroundTarget,
  imageUrl: string,
  options: StageSelectedBackgroundCandidateOptions,
): string | null {
  const state = useCanvasStore.getState();
  const sourceNode = state.nodes.find((node) => node.id === options.sourceNodeId);
  if (!sourceNode) {
    return null;
  }

  const nodeType: CanvasNodeType = CANVAS_NODE_TYPES.imageGen;
  const nodeId = useCanvasStore.getState().addNode(
    nodeType,
    selectedBackgroundCandidatePosition(sourceNode),
    selectedBackgroundOutputPatchForNode(
      {
        ...sourceNode,
        id: `${options.sourceNodeId}-selected-background-candidate`,
        type: nodeType,
        data: {},
      } as CanvasNode,
      imageUrl,
      target,
      {
        sourceSkillNodeId: options.sourceNodeId,
        label: options.label,
      },
    ) as Partial<CanvasNodeData>,
  );
  if (!nodeId) {
    return null;
  }
  useCanvasStore.getState().addEdgeWithData(
    options.sourceNodeId,
    nodeId,
    {
      edgeKind: 'mainline_data',
      propagates: true,
      role: 'selected_background',
      label: i18n.t('canvas.selectedBackground.candidateEdgeLabel'),
    },
    {
      id: `edge_${options.sourceNodeId}_to_${nodeId}_selected_background_candidate`,
      sourceHandle: 'source',
      targetHandle: 'target',
    },
  );
  return nodeId;
}

export async function uploadAndAutoCommitSelectedBackgroundCandidate(
  target: SelectedBackgroundTarget,
  blob: Blob,
  filename: string,
  options: UploadSelectedBackgroundCandidateOptions,
): Promise<{ nodeId: string; url: string }> {
  const projectId = readUrl().project;
  if (!projectId) {
    throw new Error(i18n.t('canvas.selectedBackground.missingProject'));
  }
  const uploaded = await uploadFreezoneImage(projectId, blob, filename, { timeoutMs: false });
  const nodeId = stageSelectedBackgroundCandidateFromNode(target, uploaded.url, options);
  if (!nodeId) {
    throw new Error(i18n.t('canvas.selectedBackground.candidateCreateFailed'));
  }
  canvasEventBus.publish('freezone/commit-node', {
    nodeId,
    auto: true,
    successMessage: options.successMessage
      ?? i18n.t('canvas.selectedBackground.commitSuccess'),
  });
  return { nodeId, url: uploaded.url };
}
