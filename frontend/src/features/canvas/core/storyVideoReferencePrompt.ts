// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '../domain/canvasNodes';
import {
  isFmvVideoNode,
  isWorkflowContinuityTailFrameEdge,
  withoutFmvContinuityNote,
} from '../domain/fmvContinuity';
import { readKeyElementCategory } from '../domain/keyElements';
import { sortUpstreamByReferenceOrder, videoReferenceNodesInEdgeOrder } from '../nodes/referenceOrdering';
import type { CanvasStoreApi } from './canvasStore';

/** Only count images that the video submit paths can actually send to the model. */
export function submittableContinuityImage(node: CanvasNode): string | null {
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

/** Image references of a video node in submit order, skipping media that cannot be sent. */
export function orderedStoryImages(
  graph: { nodes: CanvasNode[]; edges: CanvasEdge[] },
  targetId: string,
): CanvasNode[] {
  const target = graph.nodes.find((node) => node.id === targetId);
  if (!target) return [];
  return sortUpstreamByReferenceOrder(
    videoReferenceNodesInEdgeOrder(graph.nodes, graph.edges, targetId),
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
export function syncStoryVideoReferencePrompt(store: CanvasStoreApi, targetId: string): void {
  const state = store.getState();
  const target = state.nodes.find((node) => node.id === targetId);
  if (!target || !isFmvVideoNode(target, state.edges)) return;
  const ordered = orderedStoryImages(store.getState(), targetId);
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
