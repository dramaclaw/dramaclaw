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
  syncStoryVideoReferencePrompt as syncStoryVideoReferencePromptIn,
} from '../core/storyVideoReferencePrompt';
import { attachCompletedStoryAssetIn, attachCompletedStoryFrameIn } from '../core/storyAttachment';

export { isFmvVideoNode } from '../domain/fmvContinuity';

/** Keep visible story prompts in sync with actual connected image references. */
export function syncStoryVideoReferencePrompt(targetId: string): void {
  syncStoryVideoReferencePromptIn(useCanvasStore, targetId);
}

/** Link a completed subject/scene only to clips that still request its stable story ID. */
export function attachCompletedStoryAsset(imageNodeId: string): string | null {
  return attachCompletedStoryAssetIn(useCanvasStore, imageNodeId, (key, options) => i18next.t(key, options), videoReferenceEnvelopeForNode);
}

/** Attach an approved storyboard result only to its original story segment. */
export function attachCompletedStoryFrame(imageNodeId: string): string | null {
  return attachCompletedStoryFrameIn(useCanvasStore, imageNodeId, (key, options) => i18next.t(key, options));
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
