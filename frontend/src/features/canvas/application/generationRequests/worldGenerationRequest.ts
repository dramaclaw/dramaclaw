// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { nodeContextWireFields } from './nodeContextWire';

import type { CanvasEnvironment } from '../../core/environment';
import type { CanvasNode, ThreeDWorldNodeData } from '../../domain/canvasNodes';
import { directorPanoSourceFromCanvasNode, imageUrlFromCanvasNode, isPanoImageCanvasNode } from '../../domain/directorWorldSources';
import type { DirectorWorldSource } from '@/features/viewer-kit/three-d/directorManifest';
import type { WorkflowProductOperationContext } from '../workflowExecutionActivity';

export type FreezoneImageTo3GSKind = 'master' | 'reverse' | 'pano';
export type DirectorImageSourceKind = 'master' | 'pano';
export interface WorldGenerationRequestContext {
  nodeId: string;
  projectId: string | null | undefined;
  /** URL canvas with the caller's nullish 'default' fallback already applied. */
  canvasId: string;
  data: ThreeDWorldNodeData;
  blocked: boolean;
  /** Resolved useNodeGenerationTaskState flag, rather than only data.isGenerating. */
  isGenerating: boolean;
  /** Resolved component selection, including its image-first and vertical-order rules. */
  upstream: { nodeId: string; kind: 'image' | 'text' } | null;
  /** Source selected by that render's upstream projection; text selections use null. */
  sourceNode: CanvasNode | null;
  productOperation: WorkflowProductOperationContext | null;
  translate: CanvasEnvironment['translate'];
}
export type WorldGenerationRequestResult =
  | { ok: false; code: 'model_access_blocked' | 'no_project' | 'no_upstream' | 'generation_in_progress'
      | 'text_unsupported' | 'missing_source_node' | 'missing_source_url';
      patches: Partial<ThreeDWorldNodeData>[] }
  | { ok: true; sourceNodeId: string; sourceUrl: string; sourceKind: FreezoneImageTo3GSKind;
      rawPanoSource: DirectorWorldSource | null;
      request: { method: 'POST'; path: string; body: Record<string, unknown> } };
export type WorldGenerationPreparedRequest = Extract<WorldGenerationRequestResult, { ok: true }>;

export function imageTo3gsKindForSource(
  sourceNode: CanvasNode | null,
  visibleSourceKind: DirectorImageSourceKind,
): FreezoneImageTo3GSKind {
  if (visibleSourceKind === 'pano') return 'pano';
  const source = sourceNode?.data as { output_role?: unknown; __freezone_source?: unknown } | undefined;
  const outputRole = typeof source?.output_role === 'string' ? source.output_role : '';
  const sourceRole = typeof (source?.__freezone_source as { role?: unknown } | undefined)?.role === 'string'
    ? (source?.__freezone_source as { role?: string }).role
    : '';
  return outputRole === 'scene_reverse_master' || sourceRole === 'scene_reverse_master'
    ? 'reverse'
    : 'master';
}

export function worldVisibleSourceKind(
  data: ThreeDWorldNodeData,
  sourceNode: CanvasNode | null,
): DirectorImageSourceKind {
  if (data.plyKind === 'pano' || data.plyKind === 'master') return data.plyKind;
  return sourceNode && isPanoImageCanvasNode(sourceNode) ? 'pano' : 'master';
}

/**
 * handleSubmit guard order, raw pano preparation, and the image-to-3gs wire request.
 * Refusals return the exact ordered writes (usually none), then the caller publishes
 * success with an empty handler output and any latest stored world URLs.
 */
export function buildWorldGenerationRequest(ctx: WorldGenerationRequestContext): WorldGenerationRequestResult {
  if (ctx.blocked) return { ok: false, code: 'model_access_blocked', patches: [] };
  if (!ctx.projectId) return { ok: false, code: 'no_project',
    patches: [{ errorMessage: ctx.translate('node.threeDWorld.noProject') }] };
  if (!ctx.upstream) return { ok: false, code: 'no_upstream', patches: [] };
  if (ctx.isGenerating) return { ok: false, code: 'generation_in_progress', patches: [] };
  if (ctx.upstream.kind === 'text') return { ok: false, code: 'text_unsupported',
    patches: [{ errorMessage: ctx.translate('node.threeDWorld.textTo3dUnsupported') }] };
  const sourceNode = ctx.sourceNode;
  if (!sourceNode) return { ok: false, code: 'missing_source_node', patches: [] };
  const sourceUrl = imageUrlFromCanvasNode(sourceNode);
  if (!sourceUrl) return { ok: false, code: 'missing_source_url', patches: [] };
  const selectedImageSourceKind = worldVisibleSourceKind(ctx.data, sourceNode);
  const sourceKind = imageTo3gsKindForSource(sourceNode, selectedImageSourceKind);
  const rawPanoSource = sourceKind === 'pano'
    ? directorPanoSourceFromCanvasNode(sourceNode) ?? {
        id: `upstream-pano:${sourceNode.id}`,
        source_type: 'pano360' as const,
        source_kind: 'pano' as const,
        label: ctx.translate('node.threeDWorld.pano360Label'),
        url: sourceUrl,
        pano_url: sourceUrl,
        slot_kind: 'scene_director_pano_360' as const,
      }
    : null;
  return { ok: true, sourceNodeId: sourceNode.id, sourceUrl, sourceKind, rawPanoSource,
    request: { method: 'POST', path: `projects/${encodeURIComponent(ctx.projectId)}/freezone/image-to-3gs`, body: {
      source_url: sourceUrl, source_kind: sourceKind,
      ...nodeContextWireFields({ canvasId: ctx.canvasId, nodeId: ctx.nodeId, productOperation: ctx.productOperation }),
    } },
  };
}
