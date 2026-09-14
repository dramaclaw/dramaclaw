import {
  CANVAS_NODE_TYPES,
  isStoryGroupNode,
  type CanvasNode,
  type StoryMediaMetadata,
  type VideoNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { resolveNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';

export interface ChoiceLoopVideoCandidate {
  nodeId: string;
  label: string;
  url: string;
  durationMs: number | null;
  source: 'generated' | 'imported';
}

/** Videos outside story groups can be attached as waiting loops without adding graph edges. */
export function choiceLoopVideoCandidates(
  nodes: CanvasNode[],
  targetNodeId: string,
): ChoiceLoopVideoCandidate[] {
  const storyGroupIds = new Set(nodes.filter(isStoryGroupNode).map((node) => node.id));
  return nodes
    .filter((node) => {
      if (node.id === targetNodeId || node.type !== CANVAS_NODE_TYPES.video) return false;
      if (node.parentId && storyGroupIds.has(node.parentId)) return false;
      return typeof (node.data as VideoNodeData).videoUrl === 'string'
        && Boolean((node.data as VideoNodeData).videoUrl?.trim());
    })
    .map((node) => {
      const data = node.data as VideoNodeData;
      return {
        nodeId: node.id,
        label: resolveNodeDisplayName(CANVAS_NODE_TYPES.video, data),
        url: data.videoUrl!.trim(),
        durationMs: typeof data.durationMs === 'number' && data.durationMs > 0
          ? data.durationMs
          : null,
        source: typeof data.generationTaskJobId === 'string'
          ? ('generated' as const)
          : ('imported' as const),
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

function nextLoopMedia(
  current: VideoNodeData['storyChoiceLoop'],
  candidate: ChoiceLoopVideoCandidate,
): StoryMediaMetadata {
  const currentVersion = current?.media?.version ?? 0;
  return {
    source: candidate.source,
    status: 'ready',
    url: candidate.url,
    version: Math.max(1, currentVersion + 1),
  };
}

export function bindChoiceLoopPatch(
  current: VideoNodeData['storyChoiceLoop'],
  candidate: ChoiceLoopVideoCandidate,
): Partial<VideoNodeData> {
  return {
    choiceLoopVideoUrl: candidate.url,
    storyChoiceLoop: {
      description: current?.description?.trim() || '选择界面循环动画',
      ...(current?.productionNotes ? { productionNotes: current.productionNotes } : {}),
      media: nextLoopMedia(current, candidate),
    },
  };
}

export function clearChoiceLoopMediaPatch(
  current: VideoNodeData['storyChoiceLoop'],
): Partial<VideoNodeData> {
  if (!current) return { choiceLoopVideoUrl: null };
  return {
    choiceLoopVideoUrl: null,
    storyChoiceLoop: {
      description: current.description,
      ...(current.productionNotes ? { productionNotes: current.productionNotes } : {}),
      media: {
        source: 'placeholder',
        status: 'missing',
        version: Math.max(1, current.media?.version ?? 1),
      },
    },
  };
}
