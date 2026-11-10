import i18next from 'i18next';
// SPDX-License-Identifier: Elastic-2.0
import { useCanvasStore } from '@/stores/canvasStore';
import { CANVAS_NODE_TYPES, STORY_CHOICE_EDGE_TYPE, type CanvasNode, type CanvasEdge } from '../domain/canvasNodes';
import {
  isFmvVideoNode,
  isWorkflowContinuityTailFrameEdge,
  withoutFmvContinuityNote,
} from '../domain/fmvContinuity';
import { getOrCaptureVideoFrame } from './videoCaptureFrame';
import { videoReferenceEnvelopeForNode } from './videoReferenceEnvelope';
import {
  orderedStoryImages,
  submittableContinuityImage,
  syncStoryVideoReferencePrompt as syncStoryVideoReferencePromptIn,
} from '../core/storyVideoReferencePrompt';

export { isFmvVideoNode } from '../domain/fmvContinuity';

/** Keep visible story prompts in sync with actual connected image references. */
export function syncStoryVideoReferencePrompt(targetId: string): void {
  syncStoryVideoReferencePromptIn(useCanvasStore, targetId);
}

/** Link a completed subject/scene only to clips that still request its stable story ID. */
export function attachCompletedStoryAsset(imageNodeId: string): string | null {
  const state = useCanvasStore.getState();
  const image = state.nodes.find((node) => node.id === imageNodeId);
  if (!image || image.type !== CANVAS_NODE_TYPES.imageGen) return null;
  const binding = (image.data as { storyAssetTarget?: {
    storyId?: unknown; kind?: unknown; entityId?: unknown; segmentIds?: unknown;
  } }).storyAssetTarget;
  if (!binding) return null;
  if (!submittableContinuityImage(image) || image.data.isGenerating) return null;
  const group = state.nodes.find((node) => node.type === CANVAS_NODE_TYPES.group &&
    node.data.storyGroup === true && node.data.interactiveStoryId === binding.storyId);
  const groupData = group?.data as { storyCharacters?: Array<{ id?: string }>;
    storyScenes?: Array<{ id?: string }> } | undefined;
  const entityList = binding.kind === 'subject' ? groupData?.storyCharacters :
    binding.kind === 'scene' ? groupData?.storyScenes : undefined;
  if (!group || !entityList?.some((item) => item.id === binding.entityId) ||
      !Array.isArray(binding.segmentIds) || !binding.segmentIds.length) {
    return i18next.t('canvas.story.messages.assetPlanChanged');
  }
  const targets: CanvasNode[] = [];
  for (const segmentId of binding.segmentIds) {
    const target = state.nodes.find((node) => node.type === CANVAS_NODE_TYPES.video &&
      node.parentId === group.id && node.data.storySegmentId === segmentId);
    const data = target?.data as { storyCharacterIds?: string[];
      storySceneRefs?: Array<{ scene_id?: string }> } | undefined;
    const matches = binding.kind === 'subject'
      ? data?.storyCharacterIds?.includes(String(binding.entityId))
      : data?.storySceneRefs?.some((ref) => ref.scene_id === binding.entityId);
    if (!target || !matches) return i18next.t('canvas.story.messages.segmentPlanMismatch', { segmentId: String(segmentId) });
    const currentImages = orderedStoryImages(useCanvasStore.getState(), target.id);
    const hasTail = state.edges.some((edge) => edge.target === target.id &&
      isWorkflowContinuityTailFrameEdge(edge));
    const imageLimit = Math.max(0, videoReferenceEnvelopeForNode(target).image -
      (target.data.continuityMode === 'auto' && !hasTail ? 1 : 0));
    if (currentImages.length >= imageLimit && !currentImages.some((node) => node.id === imageNodeId)) {
      return i18next.t('canvas.story.messages.referenceLimit', { segmentId: String(segmentId) });
    }
    targets.push(target);
  }
  const createdEdges: string[] = [];
  for (const target of targets) {
    if (!useCanvasStore.getState().edges.some((edge) => edge.source === imageNodeId &&
        edge.target === target.id && edge.data?.link_type === 'media_input_for')) {
      const edgeId = state.addEdgeWithData(imageNodeId, target.id, {
        link_type: 'media_input_for', edgeKind: 'story_visual_reference',
      });
      if (!edgeId) {
        for (const createdId of createdEdges) state.deleteEdge(createdId);
        return i18next.t('canvas.story.messages.assetConnectionFailed', { segmentId: String(target.data.storySegmentId) });
      }
      createdEdges.push(edgeId);
    }
  }
  for (const target of targets) {
    syncStoryVideoReferencePrompt(target.id);
  }
  return null;
}

/** Attach an approved storyboard result only to its original story segment. */
export function attachCompletedStoryFrame(imageNodeId: string): string | null {
  const state = useCanvasStore.getState();
  const image = state.nodes.find((node) => node.id === imageNodeId);
  if (!image || image.type !== CANVAS_NODE_TYPES.imageGen) return null;
  const frame = image.data.storyFrameTarget as {
    storyId?: unknown; segmentId?: unknown; videoNodeId?: unknown; referenceNodeIds?: unknown;
  } | undefined;
  if (!frame) return null;
  if (typeof image.data.imageUrl !== 'string' || !image.data.imageUrl || image.data.isGenerating) return null;
  const target = state.nodes.find((node) => node.id === frame.videoNodeId);
  const group = state.nodes.find((node) => node.id === target?.parentId);
  if (target?.type !== CANVAS_NODE_TYPES.video || target.data.storySegmentId !== frame.segmentId ||
      group?.type !== CANVAS_NODE_TYPES.group || group.data.storyGroup !== true ||
      group.data.interactiveStoryId !== frame.storyId) {
    return i18next.t('canvas.story.messages.storyboardTargetChanged');
  }
  const referenceIds = Array.isArray(frame.referenceNodeIds)
    ? frame.referenceNodeIds.filter((id): id is string => typeof id === 'string' && !!id)
    : [];
  if (referenceIds.some((id) => {
    const reference = state.nodes.find((node) => node.id === id);
    return !reference || !submittableContinuityImage(reference);
  })) return i18next.t('canvas.story.messages.referencesUnavailable');
  for (const referenceId of referenceIds) {
    if (!useCanvasStore.getState().edges.some((edge) => edge.source === referenceId &&
        edge.target === target.id && edge.data?.link_type === 'media_input_for') &&
        !state.addEdgeWithData(referenceId, target.id, {
          link_type: 'media_input_for', edgeKind: 'story_visual_reference',
        })) {
      syncStoryVideoReferencePrompt(target.id);
      return i18next.t('canvas.story.messages.referencesConnectionFailed');
    }
  }
  if (target.data.continuityMode !== 'auto' &&
      !useCanvasStore.getState().edges.some((edge) => edge.source === imageNodeId &&
        edge.target === target.id && edge.data?.link_type === 'media_input_for')) {
    if (!state.addEdgeWithData(imageNodeId, target.id, {
      link_type: 'media_input_for', edgeKind: 'story_frame_reference',
    })) {
      syncStoryVideoReferencePrompt(target.id);
      return i18next.t('canvas.story.messages.storyboardConnectionFailed');
    }
  }
  syncStoryVideoReferencePrompt(target.id);
  return null;
}

/** Playback edges become production dependencies only after continuity is enabled. */
export function videoContinuitySources(targetId: string, nodes: CanvasNode[], edges: CanvasEdge[]): CanvasNode[] {
  const target = nodes.find((node) => node.id === targetId);
  if (!target || !isFmvVideoNode(target, edges) || target.data.continuityMode !== 'auto' || target.data.storyRole === 'start') return [];
  const ids = new Set(edges.filter((edge) => edge.target === targetId && edge.source !== targetId && (
    edge.data?.link_type === 'dependency_for' ||
    (target.data.continuityMode === 'auto' && edge.type === STORY_CHOICE_EDGE_TYPE)
  )).map((edge) => edge.source));
  const sources = nodes.filter((node) => ids.has(node.id) && node.type === CANVAS_NODE_TYPES.video);
  const selected = target.data.continuitySourceNodeId;
  return typeof selected === 'string' && selected ? sources.filter((node) => node.id === selected) : sources;
}

export async function ensureVideoContinuity(targetId: string, projectId?: string): Promise<void> {
  let state = useCanvasStore.getState();
  const target = state.nodes.find((node) => node.id === targetId);
  if (!target || !isFmvVideoNode(target, state.edges)) return;
  if (target.data.continuityMode !== 'auto' && target.data.continuityMode !== 'independent') return;
  if (target.data.continuityMode === 'independent') {
    for (const edge of state.edges.filter((edge) => edge.target === targetId && isWorkflowContinuityTailFrameEdge(edge))) {
      state.deleteEdge(edge.id);
    }
    const prompt = withoutFmvContinuityNote(target.data.prompt);
    if (prompt !== target.data.prompt) state.updateNodeData(targetId, { prompt });
    syncStoryVideoReferencePrompt(targetId);
    return;
  }
  const sources = videoContinuitySources(targetId, state.nodes, state.edges);
  if (target.data.continuitySourceNodeId && !sources.length && target.data.storyRole !== 'start') {
    throw new Error(i18next.t('canvas.story.messages.continuitySourceInvalid'));
  }
  if (!sources.length) return;
  if (sources.length > 1) throw new Error(i18next.t('canvas.story.messages.continuitySourceRequired'));
  const source = sources[0]!;
  if (!source.data.videoUrl || source.data.isGenerating) throw new Error(i18next.t('canvas.story.messages.previousShotIncomplete'));
  if (target.data.genMode === 'textToVideo' || target.data.genMode === 'videoEdit') {
    throw new Error(i18next.t('canvas.story.messages.imageInputRequired'));
  }
  const captured = await getOrCaptureVideoFrame(source.id, 'last', projectId);
  if (!captured.nodeId) throw new Error(captured.error || i18next.t('canvas.story.messages.previousFrameFailed'));
  state = useCanvasStore.getState();
  const currentSource = state.nodes.find((node) => node.id === source.id);
  const currentTarget = state.nodes.find((node) => node.id === targetId);
  if (!currentTarget || currentSource?.data.videoUrl !== source.data.videoUrl ||
      currentSource?.data.generationTaskJobId !== source.data.generationTaskJobId ||
      currentTarget.data.continuityMode !== target.data.continuityMode ||
      !videoContinuitySources(targetId, state.nodes, state.edges).some((node) => node.id === source.id)) {
    throw new Error(i18next.t('canvas.story.messages.continuitySourceChanged'));
  }
  // Replace only automatically managed references, preserving manual references.
  const oldEdges = state.edges.filter((edge) => edge.target === targetId &&
    isWorkflowContinuityTailFrameEdge(edge) && edge.source !== captured.nodeId);
  for (const edge of oldEdges) state.deleteEdge(edge.id);
  state.updateNodeData(captured.nodeId, {
    workflowContinuityFrame: { sourceVideoNodeId: source.id, targetVideoNodeId: targetId, kind: 'video_tail_frame' },
  });
  state = useCanvasStore.getState();
  const existingEdge = state.edges.find((edge) => edge.source === captured.nodeId && edge.target === targetId);
  if (!existingEdge) {
    const edgeId = state.addEdgeWithData(captured.nodeId, targetId, {
      link_type: 'media_input_for', edgeKind: 'workflow_continuity_tail_frame', keyframeSlot: 'first',
    });
    if (!edgeId) throw new Error(i18next.t('canvas.story.messages.frameBindingFailed'));
  } else if (existingEdge.data?.keyframeSlot !== 'first') {
    state.replaceEdges(state.edges.map((edge) => edge.id === existingEdge.id
      ? { ...edge, data: { ...edge.data, link_type: 'media_input_for', keyframeSlot: 'first' } }
      : edge));
  }
  state = useCanvasStore.getState();
  const ordered = orderedStoryImages(useCanvasStore.getState(), targetId);
  const index = ordered.findIndex((node) => node.id === captured.nodeId) + 1;
  if (index === 0) throw new Error(i18next.t('canvas.story.messages.frameReferenceMissing'));
  syncStoryVideoReferencePrompt(targetId);
  const prompt = withoutFmvContinuityNote(useCanvasStore.getState().nodes.find((node) => node.id === targetId)?.data.prompt);
  const continuityNote = [
    `[FMV自动承接]本镜头的首帧必须从 @图片${index}（上一镜视频截取的尾帧）开始；先保持截图中的人物、物品、姿态和构图，再按本镜剧情继续动作。若下文要求换场或跳时间，先呈现该截图，再通过可见转场进入新场景，不要直接以新场景开场。没有单独的人物或物品参考图时，继续沿用该尾帧中的身份和外观。`, // i18n-exempt: Persisted model prompt syntax/content; keep compatible with existing prompts.
    '[/FMV自动承接]', // i18n-exempt: Persisted model prompt syntax/content; keep compatible with existing prompts.
  ].join('\n');
  state.updateNodeData(targetId, {
    prompt: `${continuityNote}\n\n${prompt}`.trim(),
  });
}
