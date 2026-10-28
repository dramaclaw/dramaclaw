// SPDX-License-Identifier: Elastic-2.0
import { useEffect } from 'react';
import { useCanvasStore } from '@/stores/canvasStore';
import { isFmvVideoNode } from '../../application/videoContinuity';
import type { VideoGenMode, VideoNodeData } from '../../domain/canvasNodes';
import { isVideoModeSupportedByModel, videoUpstreamImageDefaultMode, type VideoModelRef } from './videoModelCapabilities';

export function continuityGenerationMode(mode: VideoGenMode, model: VideoModelRef): VideoGenMode | null {
  if (mode !== 'textToVideo' && mode !== 'videoEdit' && isVideoModeSupportedByModel(mode, model)) return mode;
  return videoUpstreamImageDefaultMode(model);
}

/** Include the pending tail-frame input before it has been captured. */
export function useVideoContinuityMode(
  id: string, data: VideoNodeData, model: VideoModelRef,
  update: (id: string, patch: Partial<VideoNodeData>) => void,
): boolean {
  const isFmvNode = useCanvasStore((state) => {
    const node = state.nodes.find((candidate) => candidate.id === id);
    return node ? isFmvVideoNode(node, state.edges) : false;
  });
  const enabled = isFmvNode && data.continuityMode === 'auto' && data.storyRole !== 'start';
  const mode = data.genMode ?? 'textToVideo';
  useEffect(() => {
    if (!enabled || !model) return;
    const next = continuityGenerationMode(mode, model);
    if (next && next !== mode) update(id, { genMode: next });
  }, [enabled, mode, model, id, update]);
  return isFmvNode;
}
