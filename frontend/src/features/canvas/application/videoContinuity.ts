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
import { sortUpstreamByReferenceOrder, videoReferenceNodesInEdgeOrder } from '../nodes/referenceOrdering';
import { readKeyElementCategory } from '../domain/keyElements';
import { videoReferenceEnvelopeForNode } from './videoReferenceEnvelope';

export { isFmvVideoNode } from '../domain/fmvContinuity';

/** Only count images that the video submit paths can actually send to the model. */
function submittableContinuityImage(node: CanvasNode): string | null {
  // `data` 是多类型 union，imageUrl 在个别成员上是对象型字段，这里只取字符串形态。
  const data = node.data as { imageUrl?: unknown; referenceImageUrl?: unknown };
  const imageString = (value: unknown): string | null =>
    typeof value === 'string' && value ? value : null;
  if (node.type === CANVAS_NODE_TYPES.imageGen) {
    return imageString(data.imageUrl) ?? imageString(data.referenceImageUrl);
  }
  if (node.type === CANVAS_NODE_TYPES.upload || node.type === CANVAS_NODE_TYPES.imageEdit ||
      node.type === CANVAS_NODE_TYPES.exportImage || node.type === CANVAS_NODE_TYPES.storyboardGen) {
    return imageString(data.imageUrl);
  }
  return null;
}

const FMV_REFERENCE_NOTE = /\n?\[FMV素材参考\][\s\S]*?\[\/FMV素材参考\]/g; // i18n-exempt: Persisted model prompt syntax/content; keep compatible with existing prompts.

function withoutFmvReferenceNote(prompt: unknown): string {
  return String(prompt || '').replace(FMV_REFERENCE_NOTE, '').trim();
}

function orderedStoryImages(targetId: string): CanvasNode[] {
  const state = useCanvasStore.getState();
  const target = state.nodes.find((node) => node.id === targetId);
  if (!target) return [];
  return sortUpstreamByReferenceOrder(
    videoReferenceNodesInEdgeOrder(state.nodes, state.edges, targetId),
    target.data.referenceOrder as string[] | undefined,
  ).filter((node) => !node.data.videoUrl && !node.data.audioUrl && Boolean(submittableContinuityImage(node)));
}

function storyReferenceSignature(images: CanvasNode[]): string {
  return JSON.stringify(images.map((node) => {
    const data = node.data as { storyAssetTarget?: { storyId?: string; kind?: string; entityId?: string };
      storyFrameTarget?: { storyId?: string; segmentId?: string } };
    const identity = data.storyAssetTarget
      ? [data.storyAssetTarget.storyId, data.storyAssetTarget.kind, data.storyAssetTarget.entityId]
      : data.storyFrameTarget
        ? [data.storyFrameTarget.storyId, 'frame', data.storyFrameTarget.segmentId]
        : submittableContinuityImage(node);
    return [node.id, identity];
  }));
}

/** Keep visible story prompts in sync with actual connected image references. */
export function syncStoryVideoReferencePrompt(targetId: string): void {
  const state = useCanvasStore.getState();
  const target = state.nodes.find((node) => node.id === targetId);
  if (!target || !isFmvVideoNode(target, state.edges)) return;
  const ordered = orderedStoryImages(targetId);
  // The captured tail frame belongs to continuity, not to the material list.
  const images = ordered.filter((node) => !state.edges.some((edge) => edge.source === node.id &&
    edge.target === targetId && isWorkflowContinuityTailFrameEdge(edge)));
  const imageIndex = (node: CanvasNode): number => ordered.findIndex((item) => item.id === node.id) + 1;
  const existingNote = String(target.data.prompt || '').match(FMV_REFERENCE_NOTE)?.[0];
  const positions = images.map(imageIndex);
  const sceneRefs = (target.data as { storySceneRefs?: Array<{ scene_id?: string; usage?: string }> }).storySceneRefs;
  const styleSceneIds = images.flatMap((node) => {
    const binding = (node.data as { storyAssetTarget?: { kind?: string; entityId?: string } }).storyAssetTarget;
    return binding?.kind === 'scene' && sceneRefs?.some((ref) =>
      ref.scene_id === binding.entityId && ref.usage === 'style') ? [node.id] : [];
  });
  const signature = storyReferenceSignature(images) +
    (positions.some((position, index) => position !== index + 1) ? JSON.stringify(positions) : '') +
    (styleSceneIds.length ? JSON.stringify(styleSceneIds) : '');
  const savedSignature = (target.data as { storyReferenceSignature?: unknown }).storyReferenceSignature;
  if (existingNote && savedSignature === signature) return;
  if (existingNote && images.length > 0) {
    const mentions = [...existingNote.matchAll(/@图片(\d+)(?!\d)/g)].map((match) => Number(match[1])); // i18n-exempt: Persisted model prompt syntax/content; keep compatible with existing prompts.
    // A complete note may have been written by the user or Agent with precise
    // character and scene roles. Do not replace it with generic descriptions
    // merely because the canvas hydrated or autosaved.
    if (savedSignature === undefined && mentions.length === images.length && images.every((image) => {
      const index = imageIndex(image);
      if (!mentions.includes(index)) return false;
      const namedMention = existingNote.match(new RegExp(`@图片${index}（([^）]+)）`)); // i18n-exempt: Persisted model prompt syntax/content; keep compatible with existing prompts.
      return !namedMention || namedMention[1] === image.data.displayName?.trim();
    })) {
      state.updateNodeData(targetId, { storyReferenceSignature: signature });
      return;
    }
  }
  const base = withoutFmvReferenceNote(target.data.prompt);
  const authoredPrompt = withoutFmvContinuityNote(base);
  // A reference list cannot stand in for the segment's actual shot prompt.
  if (!authoredPrompt) {
    if (base !== target.data.prompt || savedSignature !== signature) {
      state.updateNodeData(targetId, { prompt: base, storyReferenceSignature: signature });
    }
    return;
  }
  const references = images.flatMap((node) => {
    const mention = `@图片${imageIndex(node)}`; // i18n-exempt: Persisted model prompt syntax/content; keep compatible with existing prompts.
    if (new RegExp(`${mention}(?!\\d)`).test(authoredPrompt)) return [];
    const name = typeof node.data.displayName === 'string' && node.data.displayName.trim()
      ? `（${node.data.displayName.trim().replace(/\s+/g, ' ').slice(0, 80)}）` : '';
    const frame = node.data.storyFrameTarget as { videoNodeId?: unknown } | undefined;
    if (frame?.videoNodeId === targetId) {
      return [`${mention}${name} 是本镜头独立开场的构图参考，保持主体和场景一致。`]; // i18n-exempt: Persisted model prompt syntax/content; keep compatible with existing prompts.
    }
    const binding = (node.data as { storyAssetTarget?: { kind?: string; entityId?: string } }).storyAssetTarget;
    if (binding?.kind === 'subject') {
      const group = state.nodes.find((item) => item.id === target.parentId);
      const subjects = (group?.data as { storyCharacters?: Array<{ id?: string; kind?: string }> } | undefined)?.storyCharacters;
      const subject = subjects?.find((item) => item.id === binding.entityId);
      return [`${mention}${name} 是${subject?.kind === 'product' ? '产品主角的外观' : subject?.kind === 'object' ? '物品主体的外观' : '人物身份'}参考，保持主体视觉特征一致。`]; // i18n-exempt: Persisted model prompt syntax/content; keep compatible with existing prompts.
    }
    if (binding?.kind === 'scene') {
      const usage = sceneRefs?.find((ref) => ref.scene_id === binding.entityId)?.usage;
      return [usage === 'style'
        ? `${mention}${name} 是本镜头已规划的视觉风格参考，只借用色彩、光线和美术风格，不改变镜头所在场所或空间关系。` // i18n-exempt: Persisted model prompt syntax/content; keep compatible with existing prompts.
        : `${mention}${name} 是本镜头已规划的场景参考，保持环境和空间关系一致。`]; // i18n-exempt: Persisted model prompt syntax/content; keep compatible with existing prompts.
    }
    switch (readKeyElementCategory(node.data)) {
      case 'character': return [`${mention}${name} 是人物身份参考，保持面容、发型和服装一致。`]; // i18n-exempt: Persisted model prompt syntax/content; keep compatible with existing prompts.
      case 'scene': return [`${mention}${name} 是场景参考，保持环境和空间关系一致。`]; // i18n-exempt: Persisted model prompt syntax/content; keep compatible with existing prompts.
      case 'object': return [`${mention}${name} 是物品外观参考，保持形状、材质和细节一致。`]; // i18n-exempt: Persisted model prompt syntax/content; keep compatible with existing prompts.
      default: return [`${mention}${name} 是补充图片参考，按该素材的实际内容使用。`]; // i18n-exempt: Persisted model prompt syntax/content; keep compatible with existing prompts.
    }
  });
  const note = references.length ? `[FMV素材参考]\n${references.join('\n')}\n[/FMV素材参考]` : ''; // i18n-exempt: Persisted model prompt syntax/content; keep compatible with existing prompts.
  const prompt = [note, base].filter(Boolean).join('\n\n');
  if (prompt !== target.data.prompt || savedSignature !== signature) {
    state.updateNodeData(targetId, { prompt, storyReferenceSignature: signature });
  }
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
    const currentImages = orderedStoryImages(target.id);
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
  const ordered = orderedStoryImages(targetId);
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
