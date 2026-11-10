// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  isImageGenNode, isUploadNode, isImageEditNode, isExportImageNode, isStoryboardGenNode,
  isTextAnnotationNode, type CanvasNode, type CanvasEdge,
} from '../../domain/canvasNodes';
import { upstreamNodesInEdgeOrder } from '../../nodes/referenceOrdering';
import type { WorldGenerationRequestContext } from './worldGenerationRequest';

type WorldGenerationUpstream = Pick<WorldGenerationRequestContext, 'upstream' | 'sourceNode'>;

// Reproduce ThreeDWorldNode.tsx:148-179 (upstreamRef), 897-923 (selection),
// and 1015-1018 (sourceNodeForGeneration). Its real action parity test guards drift.
function referenceKind(node: CanvasNode): 'image' | 'text' | null {
  if (isImageGenNode(node)) {
    const ref = typeof node.data.referenceImageUrl === 'string' && node.data.referenceImageUrl.length > 0
      ? node.data.referenceImageUrl : null;
    return node.data.imageUrl || ref ? 'image' : null;
  }
  if (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node) || isStoryboardGenNode(node)) {
    return node.data.imageUrl ? 'image' : null;
  }
  if (isTextAnnotationNode(node)) return (node.data.content ?? '').trim() ? 'text' : null;
  return null;
}

export function selectWorldGenerationUpstream({ nodes, edges, nodeId }: {
  nodes: CanvasNode[]; edges: CanvasEdge[]; nodeId: string;
}): WorldGenerationUpstream {
  const upstreamNodes = upstreamNodesInEdgeOrder(nodes, edges, nodeId);
  const sources = [...upstreamNodes].sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0));
  const refs = sources.flatMap(node => {
    const kind = referenceKind(node);
    return kind ? [{ nodeId: node.id, kind }] : [];
  });
  const images = refs.filter(ref => ref.kind === 'image');
  const sourceNodeId = nodes.find(node => node.id === nodeId)?.data.sourceNodeId;
  const preferred = typeof sourceNodeId === 'string' ? images.find(ref => ref.nodeId === sourceNodeId) : null;
  const upstream = preferred ?? images[0] ?? refs.find(ref => ref.kind === 'text') ?? null;
  const sourceNode = upstream?.kind === 'image'
    ? upstreamNodes.find(node => node.id === upstream.nodeId) ?? null : null;
  return { upstream, sourceNode };
}
