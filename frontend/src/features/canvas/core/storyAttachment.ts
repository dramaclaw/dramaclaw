// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { CANVAS_NODE_TYPES, type CanvasNode } from '../domain/canvasNodes';
import { isWorkflowContinuityTailFrameEdge } from '../domain/fmvContinuity';
import { VIDEO_MODELS } from '../domain/modelOptions';
import { videoReferenceEnvelopeInCatalog, type VideoReferenceEnvelopeResolver } from '../domain/videoReferenceLimits';
import type { CanvasStoreApi } from './canvasStore';
import type { CanvasEnvironment } from './environment';
import { orderedStoryImages, submittableContinuityImage, syncStoryVideoReferencePrompt } from './storyVideoReferencePrompt';

const defaultEnvelope: VideoReferenceEnvelopeResolver = target => videoReferenceEnvelopeInCatalog(target, VIDEO_MODELS);

/** Link a completed subject/scene only to clips that still request its stable story ID. */
export function attachCompletedStoryAssetIn(
  store: CanvasStoreApi,
  imageNodeId: string,
  translate: CanvasEnvironment['translate'],
  resolveEnvelope: VideoReferenceEnvelopeResolver = defaultEnvelope,
): string | null {
  const state = store.getState();
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
    return translate('canvas.story.messages.assetPlanChanged');
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
    if (!target || !matches) return translate('canvas.story.messages.segmentPlanMismatch', { segmentId: String(segmentId) });
    const currentImages = orderedStoryImages(store.getState(), target.id);
    const hasTail = state.edges.some((edge) => edge.target === target.id &&
      isWorkflowContinuityTailFrameEdge(edge));
    const imageLimit = Math.max(0, resolveEnvelope(target).image -
      (target.data.continuityMode === 'auto' && !hasTail ? 1 : 0));
    if (currentImages.length >= imageLimit && !currentImages.some((node) => node.id === imageNodeId)) {
      return translate('canvas.story.messages.referenceLimit', { segmentId: String(segmentId) });
    }
    targets.push(target);
  }
  const createdEdges: string[] = [];
  for (const target of targets) {
    if (!store.getState().edges.some((edge) => edge.source === imageNodeId &&
        edge.target === target.id && edge.data?.link_type === 'media_input_for')) {
      const edgeId = state.addEdgeWithData(imageNodeId, target.id, {
        link_type: 'media_input_for', edgeKind: 'story_visual_reference',
      });
      if (!edgeId) {
        for (const createdId of createdEdges) state.deleteEdge(createdId);
        return translate('canvas.story.messages.assetConnectionFailed', { segmentId: String(target.data.storySegmentId) });
      }
      createdEdges.push(edgeId);
    }
  }
  for (const target of targets) {
    syncStoryVideoReferencePrompt(store, target.id);
  }
  return null;
}

/** Attach an approved storyboard result only to its original story segment. */
export function attachCompletedStoryFrameIn(
  store: CanvasStoreApi,
  imageNodeId: string,
  translate: CanvasEnvironment['translate'],
): string | null {
  const state = store.getState();
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
    return translate('canvas.story.messages.storyboardTargetChanged');
  }
  const referenceIds = Array.isArray(frame.referenceNodeIds)
    ? frame.referenceNodeIds.filter((id): id is string => typeof id === 'string' && !!id)
    : [];
  if (referenceIds.some((id) => {
    const reference = state.nodes.find((node) => node.id === id);
    return !reference || !submittableContinuityImage(reference);
  })) return translate('canvas.story.messages.referencesUnavailable');
  for (const referenceId of referenceIds) {
    if (!store.getState().edges.some((edge) => edge.source === referenceId &&
        edge.target === target.id && edge.data?.link_type === 'media_input_for') &&
        !state.addEdgeWithData(referenceId, target.id, {
          link_type: 'media_input_for', edgeKind: 'story_visual_reference',
        })) {
      syncStoryVideoReferencePrompt(store, target.id);
      return translate('canvas.story.messages.referencesConnectionFailed');
    }
  }
  if (target.data.continuityMode !== 'auto' &&
      !store.getState().edges.some((edge) => edge.source === imageNodeId &&
        edge.target === target.id && edge.data?.link_type === 'media_input_for')) {
    if (!state.addEdgeWithData(imageNodeId, target.id, {
      link_type: 'media_input_for', edgeKind: 'story_frame_reference',
    })) {
      syncStoryVideoReferencePrompt(store, target.id);
      return translate('canvas.story.messages.storyboardConnectionFailed');
    }
  }
  syncStoryVideoReferencePrompt(store, target.id);
  return null;
}

/** Apply the same post-batch attachments and outgoing prompt sync in either host. */
export function syncCompletedStoryFramesIn(
  store: CanvasStoreApi,
  imageNodeIds: Iterable<string>,
  translate: CanvasEnvironment['translate'],
  resolveEnvelope: VideoReferenceEnvelopeResolver = defaultEnvelope,
): string[] {
  const warnings: string[] = [];
  for (const imageNodeId of imageNodeIds) {
    const frameError = attachCompletedStoryFrameIn(store, imageNodeId, translate);
    const assetError = attachCompletedStoryAssetIn(store, imageNodeId, translate, resolveEnvelope);
    if (frameError) warnings.push(frameError);
    if (assetError) warnings.push(assetError);
    for (const edge of store.getState().edges.filter(item => item.source === imageNodeId)) {
      syncStoryVideoReferencePrompt(store, edge.target);
    }
  }
  return warnings;
}
