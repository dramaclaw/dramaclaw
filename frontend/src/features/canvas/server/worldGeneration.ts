// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import * as pure from '../application/generationRequests';
import type { DirectorWorldSource } from '@/features/viewer-kit/three-d/directorManifest';
import * as p from './generationPayload';
import { node, project, productOperation } from './toolPayload';
import { invalidRequest } from './requestPayload';
import { createServerTranslate } from './i18n';
import { runServerRequest } from './requestScope';

function sourceKind(value: unknown) {
  return p.choice(value, ['master', 'reverse', 'pano']);
}

function source(value: unknown): DirectorWorldSource {
  const input = p.fields(value, ['id', 'source_type', 'source_kind', 'label', 'ply_url', 'url', 'pano_url',
    'pano_fs', 'collision_glb_url', 'slot_kind', 'fs', 'current', 'transform']);
  const sourceType = p.choice(input.source_type, ['sog', 'pano360', 'mesh']);
  p.optional(input.source_kind, value => p.choice(value, ['active', 'master', 'reverse', 'pano', 'uploaded', 'custom']));
  p.optional(input.slot_kind, value => p.choice(value, ['scene_director_pano_360', 'scene_360_candidate']));
  for (const key of ['id', 'label', 'ply_url', 'url', 'pano_url', 'pano_fs', 'collision_glb_url', 'fs']) p.optional(input[key], p.string);
  p.optional(input.current, p.boolean);
  p.optional(input.transform, value => {
    const keys = ['xOffset', 'yOffset', 'zOffset', 'yawDeg', 'pitchDeg', 'rollDeg', 'scale'];
    const transform = p.fields(value, keys);
    for (const key of keys) p.number(transform[key]);
  });
  return { ...input, source_type: sourceType };
}

function preparedRequest(value: unknown): pure.WorldGenerationPreparedRequest {
  const input = p.fields(value, ['source_node_id', 'source_url', 'source_kind', 'raw_pano_source', 'request']);
  const request = p.fields(input.request, ['method', 'path', 'body']);
  return { ok: true, sourceNodeId: p.string(input.source_node_id), sourceUrl: p.string(input.source_url),
    sourceKind: sourceKind(input.source_kind), rawPanoSource: p.nullable(input.raw_pano_source, source),
    request: { method: p.choice(request.method, ['POST']), path: p.string(request.path), body: p.record(request.body) } };
}

export async function serveWorldGenerationUpstream(payload: unknown) {
  const input = p.fields(payload, ['canvas', 'node_id', 'env']);
  const { canvas, nodeId, env } = p.graph({ ...input, env: input.env === undefined ? {} : input.env });
  p.fields(env, ['locale']);
  return pure.selectWorldGenerationUpstream({ nodes: canvas.nodes, edges: canvas.edges, nodeId });
}

export async function serveWorldGenerationRequest(payload: unknown) {
  const input = p.fields(payload, ['node_id', 'node_data', 'source_node', 'upstream', 'env']);
  const env = p.fields(input.env, ['locale', 'project', 'canvas_id', 'blocked', 'is_generating', 'product_operation']);
  const locale = p.optional(env.locale, p.string);
  const context = { nodeId: p.string(input.node_id), data: p.record(input.node_data),
    sourceNode: p.nullable(input.source_node, node), upstream: p.nullable(input.upstream, value => {
      const upstream = p.fields(value, ['node_id', 'kind']);
      return { nodeId: p.string(upstream.node_id), kind: p.choice(upstream.kind, ['image', 'text']) };
    }), projectId: project(env.project), canvasId: p.string(env.canvas_id), blocked: p.boolean(env.blocked),
    isGenerating: p.boolean(env.is_generating), productOperation: productOperation(env.product_operation) };
  return runServerRequest(locale, async () => {
    const decision = pure.buildWorldGenerationRequest({ ...context, translate: await createServerTranslate(locale) });
    if (decision.ok && /^\s*(?:data|blob):/i.test(decision.sourceUrl)) {
      return { ok: false, code: 'inline_media_reference', patches: [] };
    }
    return decision;
  });
}

export async function serveWorldGenerationPatch(payload: unknown) {
  const { input, phase, locale } = p.patch(payload);
  switch (phase) {
    case 'labels': {
      p.fields(input, ['phase', 'locale']);
      return runServerRequest(locale, async () => {
        const translate = await createServerTranslate(locale);
        return {
          pano_3dgs: translate('node.threeDWorld.pano3dgsLabel'),
          image_3dgs: translate('node.threeDWorld.image3dgsLabel'),
          world_url_missing: translate('node.threeDWorld.worldUrlMissing'),
        };
      });
    }
    case 'source_kind': {
      p.fields(input, ['phase', 'locale', 'source_node', 'visible_source_kind']);
      const sourceNode = p.nullable(input.source_node, node), visible = p.choice(input.visible_source_kind, ['master', 'pano']);
      return runServerRequest(locale, async () => pure.imageTo3gsKindForSource(sourceNode, visible));
    }
    case 'start': {
      p.fields(input, ['phase', 'locale', 'prepared_request', 'node_data', 'started_at_ms']);
      const parsed = { request: preparedRequest(input.prepared_request), data: p.record(input.node_data), startedAtMs: p.number(input.started_at_ms) };
      return runServerRequest(locale, async () => pure.worldGenerationStartPatch(parsed));
    }
    case 'accepted': {
      p.fields(input, ['phase', 'locale', 'task']);
      const task = p.task(input.task);
      return runServerRequest(locale, async () => pure.worldGenerationAcceptedPatch(task));
    }
    case 'success': {
      p.fields(input, ['phase', 'locale', 'result', 'generated_id', 'source_kind', 'raw_pano_source', 'current_sources', 'labels']);
      const labels = p.fields(input.labels, ['pano_3dgs', 'image_3dgs', 'world_url_missing']);
      const parsed = { result: input.result, generatedId: p.string(input.generated_id), sourceKind: sourceKind(input.source_kind),
        // current_sources is the world node's stored data.sources: opaque records, passed through as the browser does.
        rawPanoSource: p.nullable(input.raw_pano_source, source),
        currentSources: p.array(input.current_sources, value => p.record(value) as unknown as DirectorWorldSource),
        labels: { pano3dgs: p.string(labels.pano_3dgs), image3dgs: p.string(labels.image_3dgs), worldUrlMissing: p.string(labels.world_url_missing) } };
      return runServerRequest(locale, async () => pure.worldGenerationSuccessPatch(parsed));
    }
    case 'failure': {
      p.fields(input, ['phase', 'locale', 'outcome']);
      const outcome = p.record(input.outcome);
      let parsed: Parameters<typeof pure.worldGenerationFailureOutcome>[0];
      if (outcome.kind === 'poll_timeout') {
        p.fields(outcome, ['kind']); parsed = { kind: 'poll_timeout' };
      } else {
        p.fields(outcome, ['kind', 'message']);
        parsed = { kind: p.choice(outcome.kind, ['failed']), message: p.string(outcome.message) };
      }
      return runServerRequest(locale, async () => pure.worldGenerationFailureOutcome(parsed, await createServerTranslate(locale)));
    }
    case 'action_result': {
      let parsed: Parameters<typeof pure.worldGenerationActionResult>[0];
      if (p.hasField(input, 'error')) {
        p.fields(input, ['phase', 'locale', 'error']); parsed = { error: p.string(input.error) };
      } else {
        p.fields(input, ['phase', 'locale', 'output', 'latest_node']);
        const output = p.fields(input.output, ['ply_url', 'pano_url']);
        parsed = { output: { plyUrl: p.optional(output.ply_url, p.string), panoUrl: p.optional(output.pano_url, p.string) },
          latestNode: p.optional(input.latest_node, node) };
      }
      return runServerRequest(locale, async () => pure.worldGenerationActionResult(parsed));
    }
    default: return invalidRequest('Unknown world generation patch phase');
  }
}
