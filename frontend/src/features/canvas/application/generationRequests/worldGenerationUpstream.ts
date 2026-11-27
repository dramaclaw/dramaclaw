// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  isImageGenNode, isUploadNode, isImageEditNode, isExportImageNode, isStoryboardGenNode,
  isTextAnnotationNode, type CanvasNode, type CanvasEdge,
} from '../../domain/canvasNodes';
import { upstreamNodesInEdgeOrder } from '../../nodes/referenceOrdering';
import type { WorldGenerationRequestContext } from './worldGenerationRequest';

type WorldGenerationUpstream = Pick<WorldGenerationRequestContext, 'upstream' | 'sourceNode'>;

export function worldUpstreamReference(node: CanvasNode):
  | { nodeId: string; kind: 'image'; imageUrl: string }
  | { nodeId: string; kind: 'text'; textContent: string }
  | null {
  if (isImageGenNode(node) || isUploadNode(node) || isImageEditNode(node)
    || isExportImageNode(node) || isStoryboardGenNode(node)) {
    const ref = isImageGenNode(node) && typeof node.data.referenceImageUrl === 'string'
      && node.data.referenceImageUrl.length > 0 ? node.data.referenceImageUrl : null;
    const imageUrl = isImageGenNode(node)
      ? node.data.imageUrl || ref : node.data.imageUrl;
    return imageUrl
      ? { nodeId: node.id, kind: 'image', imageUrl: imageUrl as string } : null;
  }
  if (isTextAnnotationNode(node)) {
    const textContent = (node.data.content ?? '').trim();
    return textContent ? { nodeId: node.id, kind: 'text', textContent } : null;
  }
  return null;
}

export function selectWorldUpstreamFromNodes({ upstreamNodes, sourceNodeId }: {
  upstreamNodes: CanvasNode[]; sourceNodeId: unknown;
}): WorldGenerationUpstream {
  const sources = [...upstreamNodes].sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0));
  const refs = sources.flatMap(node => {
    const ref = worldUpstreamReference(node);
    return ref ? [{ nodeId: ref.nodeId, kind: ref.kind }] : [];
  });
  const images = refs.filter(ref => ref.kind === 'image');
  const preferred = typeof sourceNodeId === 'string' ? images.find(ref => ref.nodeId === sourceNodeId) : null;
  const upstream = preferred ?? images[0] ?? refs.find(ref => ref.kind === 'text') ?? null;
  const sourceNode = upstream?.kind === 'image'
    ? upstreamNodes.find(node => node.id === upstream.nodeId) ?? null : null;
  return { upstream, sourceNode };
}

export function selectWorldGenerationUpstream({ nodes, edges, nodeId }: {
  nodes: CanvasNode[]; edges: CanvasEdge[]; nodeId: string;
}): WorldGenerationUpstream {
  return selectWorldUpstreamFromNodes({
    upstreamNodes: upstreamNodesInEdgeOrder(nodes, edges, nodeId),
    sourceNodeId: nodes.find(node => node.id === nodeId)?.data.sourceNodeId,
  });
}
