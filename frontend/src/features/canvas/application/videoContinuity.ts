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

function fmvSupplementalReference(node: CanvasNode, index: number): string {
  const reference = `@图片${index}`;
  const name = typeof node.data.displayName === 'string' && node.data.displayName.trim()
    ? `（${node.data.displayName.trim().replace(/\s+/g, ' ').slice(0, 80)}）` : '';
  switch (readKeyElementCategory(node.data)) {
    case 'character': return `${reference}${name} 是人物身份参考，保持人物面容、发型和服装一致，不替代开场帧。`;
    case 'object': return `${reference}${name} 是物品外观参考，保持物品形状、材质和细节一致，不替代开场帧。`;
    case 'scene': return `${reference}${name} 是场景参考，只用于对应场景的环境细节，不替代开场帧。`;
    default: return `${reference}${name} 是补充图片参考，按该素材的实际内容使用，不替代开场帧。`;
  }
}

const FMV_REFERENCE_NOTE = /\n?\[FMV素材参考\][\s\S]*?\[\/FMV素材参考\]/g;

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

/** Keep visible story prompts in sync with actual connected image references. */
export function syncStoryVideoReferencePrompt(targetId: string): void {
  const state = useCanvasStore.getState();
  const target = state.nodes.find((node) => node.id === targetId);
  if (!target || !isFmvVideoNode(target, state.edges)) return;
  const base = withoutFmvReferenceNote(target.data.prompt);
  const authoredPrompt = withoutFmvContinuityNote(base);
  // A reference list cannot stand in for the segment's actual shot prompt.
  if (!authoredPrompt) {
    if (base !== target.data.prompt) state.updateNodeData(targetId, { prompt: base });
    return;
  }
  const references = orderedStoryImages(targetId).flatMap((node, index) => {
    const mention = `@图片${index + 1}`;
    if (new RegExp(`${mention}(?!\\d)`).test(authoredPrompt)) return [];
    const name = typeof node.data.displayName === 'string' && node.data.displayName.trim()
      ? `（${node.data.displayName.trim().replace(/\s+/g, ' ').slice(0, 80)}）` : '';
    const frame = node.data.storyFrameTarget as { videoNodeId?: unknown } | undefined;
    if (frame?.videoNodeId === targetId) {
      return [`${mention}${name} 是本镜头独立开场的构图参考，保持主体和场景一致。`];
    }
    switch (readKeyElementCategory(node.data)) {
      case 'character': return [`${mention}${name} 是人物身份参考，保持面容、发型和服装一致。`];
      case 'scene': return [`${mention}${name} 是场景参考，保持环境和空间关系一致。`];
      case 'object': return [`${mention}${name} 是物品外观参考，保持形状、材质和细节一致。`];
      default: return [`${mention}${name} 是补充图片参考，按该素材的实际内容使用。`];
    }
  });
  const note = references.length ? `[FMV素材参考]\n${references.join('\n')}\n[/FMV素材参考]` : '';
  const prompt = [note, base].filter(Boolean).join('\n\n');
  if (prompt !== target.data.prompt) state.updateNodeData(targetId, { prompt });
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
    return '分镜目标已变化，未自动连接到故事视频节点。';
  }
  const referenceIds = Array.isArray(frame.referenceNodeIds)
    ? frame.referenceNodeIds.filter((id): id is string => typeof id === 'string' && !!id)
    : [];
  if (referenceIds.some((id) => {
    const reference = state.nodes.find((node) => node.id === id);
    return !reference || !submittableContinuityImage(reference);
  })) return '分镜已生成，但人物或场景参考图尚不可用，未完成视频素材连接。';
  for (const referenceId of referenceIds) {
    if (!useCanvasStore.getState().edges.some((edge) => edge.source === referenceId &&
        edge.target === target.id && edge.data?.link_type === 'media_input_for') &&
        !state.addEdgeWithData(referenceId, target.id, {
          link_type: 'media_input_for', edgeKind: 'story_visual_reference',
        })) {
      syncStoryVideoReferencePrompt(target.id);
      return '分镜已生成，但人物或场景参考图无法接入目标视频。';
    }
  }
  if (target.data.continuityMode !== 'auto' &&
      !useCanvasStore.getState().edges.some((edge) => edge.source === imageNodeId &&
        edge.target === target.id && edge.data?.link_type === 'media_input_for')) {
    if (!state.addEdgeWithData(imageNodeId, target.id, {
      link_type: 'media_input_for', edgeKind: 'story_frame_reference',
    })) {
      syncStoryVideoReferencePrompt(target.id);
      return '分镜图片已生成，但目标视频无法接入该图片参考。';
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
    throw new Error('指定的承接来源不在当前上游，请重新选择。');
  }
  if (!sources.length) return;
  if (sources.length > 1) throw new Error('此镜头有多个上游，请指定承接来源或设为独立开场。');
  const source = sources[0]!;
  if (!source.data.videoUrl || source.data.isGenerating) throw new Error('上一镜头尚未完成，请完成后再生成连续镜头。');
  if (target.data.genMode === 'textToVideo' || target.data.genMode === 'videoEdit') {
    throw new Error('连续镜头需要支持图片输入的生成模式，请选择首帧或图片参考模式。');
  }
  const captured = await getOrCaptureVideoFrame(source.id, 'last', projectId);
  if (!captured.nodeId) throw new Error(captured.error || '上一镜尾帧抽取失败。');
  state = useCanvasStore.getState();
  const currentSource = state.nodes.find((node) => node.id === source.id);
  const currentTarget = state.nodes.find((node) => node.id === targetId);
  if (!currentTarget || currentSource?.data.videoUrl !== source.data.videoUrl ||
      currentSource?.data.generationTaskJobId !== source.data.generationTaskJobId ||
      currentTarget.data.continuityMode !== target.data.continuityMode ||
      !videoContinuitySources(targetId, state.nodes, state.edges).some((node) => node.id === source.id)) {
    throw new Error('承接来源已变化，请重新生成。');
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
    if (!edgeId) throw new Error('尾帧参考绑定失败，未启动视频生成。');
  } else if (existingEdge.data?.keyframeSlot !== 'first') {
    state.replaceEdges(state.edges.map((edge) => edge.id === existingEdge.id
      ? { ...edge, data: { ...edge.data, link_type: 'media_input_for', keyframeSlot: 'first' } }
      : edge));
  }
  state = useCanvasStore.getState();
  const ordered = orderedStoryImages(targetId);
  const index = ordered.findIndex((node) => node.id === captured.nodeId) + 1;
  if (index === 0) throw new Error('尾帧参考未进入图片列表，已停止视频生成。');
  const prompt = withoutFmvReferenceNote(withoutFmvContinuityNote(currentTarget.data.prompt));
  const extraReferences = currentTarget.data.genMode === 'allReference' || currentTarget.data.genMode === 'imageReference'
    ? ordered.flatMap((node, imageIndex) => node.id === captured.nodeId
      ? [] : [fmvSupplementalReference(node, imageIndex + 1)])
    : [];
  const continuityNote = [
    `[FMV自动承接]本镜头的首帧必须从 @图片${index}（上一镜视频截取的尾帧）开始；先保持截图中的人物、物品、姿态和构图，再按本镜剧情继续动作。若下文要求换场或跳时间，先呈现该截图，再通过可见转场进入新场景，不要直接以新场景开场。没有单独的人物或物品参考图时，继续沿用该尾帧中的身份和外观。`,
    ...extraReferences,
    '[/FMV自动承接]',
  ].join('\n');
  state.updateNodeData(targetId, {
    prompt: `${continuityNote}\n\n${prompt}`.trim(),
  });
}
