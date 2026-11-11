// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createCanvasStore, createNodeCanvasEnvironment } from '@/features/canvas/serverEntry';
import { VIDEO_MODELS } from '@/features/canvas/domain/modelOptions';
import * as pure from '@/features/canvas/application/generationRequests';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { imageModelOptionsFromPayload } from '@/features/canvas/domain/modelCatalogPayload';
import { SHARED_MODELS } from '@/features/canvas/domain/modelOptions';
import { createServerTranslate } from '@/features/canvas/server/i18n';

export const actions = [
  'run_outpaint_tool', 'run_upscale_tool', 'run_scene360_tool',
  'run_grid_multi_camera', 'run_grid_plot_four', 'run_grid_face_three_view',
  'run_grid_product_three_view', 'run_grid_serial_storyboard_25',
  'run_grid_cinematic_light_correction', 'run_grid_character_three_view',
  'run_grid_scene_setting_sheet', 'run_grid_frame_projection_3s_later',
  'run_grid_frame_projection_5s_earlier',
] as const satisfies readonly pure.ImageToolAction[];
export const task = { task_key: 'tool-task', task_type: 'tool', job_id: 'job' };
export const url = 'https://media.example.test/source.png?version=2';
export const source = (data: Record<string, unknown> = {}): CanvasNode => ({
  id: 'source', type: CANVAS_NODE_TYPES.imageGen, position: { x: 0, y: 0 }, data: { imageUrl: url, ...data },
});
export const operation = { project_id: 'project', operation_id: 'operation', generation_attempt_id: 'attempt' };
export function imagePayload(action: pure.ImageToolAction = 'run_outpaint_tool', locale = 'en') {
  return { canvas: { nodes: [source()], edges: [] }, node_id: 'source', action,
    env: { locale, project: 'tools / project', now_ms: 123.5, image_models: ['custom-model'] } };
}
export function audioPayload(locale = 'en') {
  return { canvas: { nodes: [{ id: 'audio', type: CANVAS_NODE_TYPES.audio, position: { x: 0, y: 0 },
    data: { text: '  Read this aloud.  ', audioUrl: null } }], edges: [] }, node_id: 'audio',
    env: { locale, project: 'tools / project', canvas_id: 'canvas/1', product_operation: operation } };
}
export function worldPayload(locale = 'en') {
  return { node_id: 'world', node_data: {}, source_node: source(), upstream: { node_id: 'source', kind: 'image' },
    env: { locale, project: 'tools / project', canvas_id: 'canvas/1', blocked: false, is_generating: false, product_operation: operation } };
}
export const placePayload = () => ({
  canvas: { nodes: [source(), { ...source(), id: 'obstacle', position: { x: 380, y: 0 } }], edges: [] },
  locale: 'en', child_node_id: 'placed-child',
  child: { type: CANVAS_NODE_TYPES.exportImage, data: {
    displayName: 'Tool result', imageUrl: null, generationOwner: 'server', generationRunId: 'run',
    isGenerating: true, generationStartedAt: 123,
  }, layout: { anchorNodeId: 'source', width: 360, height: 300 } },
  edge: { source: 'source', target: 'child' },
});

export async function browserPlacement(payload: ReturnType<typeof placePayload>) {
  const store = createCanvasStore(createNodeCanvasEnvironment({
    translate: await createServerTranslate(payload.locale),
    ids: { next: () => payload.child_node_id }, now: () => 123, videoModels: VIDEO_MODELS,
  }));
  store.getState().setCanvasData(payload.canvas.nodes, payload.canvas.edges);
  const { anchorNodeId, width, height } = payload.child.layout;
  const position = store.getState().findNodePosition(anchorNodeId, width, height);
  const id = store.getState().addNode(payload.child.type, position, payload.child.data);
  const edgeId = store.getState().addEdge(payload.edge.source, id);
  return { node: store.getState().nodes.find(node => node.id === id),
    edge: store.getState().edges.find(edge => edge.id === edgeId) ?? null };
}

export type Fixture = { name: string; op: string; payload: Record<string, unknown>; expected: () => unknown | Promise<unknown> };
const productOperation = { projectId: operation.project_id, operationId: operation.operation_id, generationAttemptId: operation.generation_attempt_id };
export async function toolFixtures(): Promise<Fixture[]> {
  const fixtures: Fixture[] = [];
  const add = (op: string, name: string, payload: Record<string, unknown>, expected: Fixture['expected']) => fixtures.push({ op, name, payload, expected });
  const placed = placePayload();
  add('image_tool_place', 'browser placement', placed, () => browserPlacement(placed));
  for (const locale of ['en', 'zh']) {
    const t = await createServerTranslate(locale);
    const patch = (op: string, phase: string, name: string, fields: Record<string, unknown>, expected: Fixture['expected']) =>
      add(op, `${phase}-${name}-${locale}`, { phase, locale, ...fields }, expected);
    patch('world_generation_patch', 'labels', 'browser labels', {}, () => ({
      pano_3dgs: t('node.threeDWorld.pano3dgsLabel'),
      image_3dgs: t('node.threeDWorld.image3dgsLabel'),
      world_url_missing: t('node.threeDWorld.worldUrlMissing'),
    }));
    for (const action of actions) {
      const cases: { name: string; data?: Record<string, unknown>; project?: string | null; nodes?: CanvasNode[]; models?: unknown }[] = [
        { name: 'ordinary' }, { name: 'opaque fallbacks', data: { imageUrl: null, referenceImageUrl: url, aspectRatio: 2 } },
        { name: 'missing image', data: { imageUrl: null } }, { name: 'missing node', nodes: [] },
        { name: 'no project', project: '' }, { name: 'null project', project: null },
        { name: 'data refusal', data: { imageUrl: 'data:image/png;base64,AA==' } },
        { name: 'blob refusal', data: { imageUrl: 'blob:https://media.example.test/image' } },
        { name: 'empty models', models: [] }, { name: 'wrapped models', models: { models: [{ id: 'chosen', api_model: 'chosen-api', label: 'Chosen' }] } },
        { name: 'default models', models: undefined }, { name: 'missing project', project: undefined },
      ];
      for (const test of cases) {
        const p = imagePayload(action, locale);
        const models = 'models' in test ? test.models : p.env.image_models;
        const nodes = test.nodes ?? [source(test.data)];
        const project = 'project' in test ? test.project : p.env.project;
        add('image_tool_request', `${action}-${test.name}-${locale}`, { ...p, canvas: { nodes, edges: [] }, env: { ...p.env, project, image_models: models } },
          () => pure.buildImageToolRequest({ action, nodes, nodeId: p.node_id, projectId: project, nowMs: p.env.now_ms,
            imageModels: models === undefined ? SHARED_MODELS : imageModelOptionsFromPayload(models), translate: t }));
      }
      for (const value of ['', url]) {
        patch('image_tool_patch', 'success', `${action}-${value}`, { action, url: value }, () => pure.imageToolSuccessPatch({ action, url: value }));
        patch('image_tool_patch', 'viewer_plan', action + value, { action, child_node_id: value }, () => pure.imageToolViewerPlan({ action, childNodeId: value }));
        const input: pure.ImageToolActionResultInput = action === 'run_scene360_tool'
          ? { action, childNodeId: 'child', viewerNodeId: 'viewer', url: value, task }
          : { action, childNodeId: 'child', url: value, task };
        patch('image_tool_patch', 'action_result', action + value, { action, child_node_id: 'child', ...(action === 'run_scene360_tool' ? { viewer_node_id: 'viewer' } : {}), url: value, task }, () => pure.imageToolActionResult(input));
      }
    }
    for (const ref of [task, { task_key: '', task_type: '', job_id: '' }]) {
      patch('image_tool_patch', 'accepted', ref.task_key, { task: ref }, () => pure.imageToolAcceptedPatch(ref));
      patch('world_generation_patch', 'accepted', ref.task_key, { task: ref }, () => pure.worldGenerationAcceptedPatch(ref));
    }
    for (const result of [undefined, null, {}, { output_url: null }, { output_url: '' }, { output_url: url }]) {
      patch('image_tool_patch', 'output_resolution', JSON.stringify(result) ?? 'omitted', { result, task }, () => pure.imageToolOutputResolution({ result, task }));
    }
    for (const message of ['', 'Failed']) {
      patch('image_tool_patch', 'failure', message, { message }, () => pure.imageToolFailurePatch(message));
      patch('image_tool_patch', 'action_result', message, { message }, () => pure.imageToolActionResult({ message }));
      patch('audio_translate_patch', 'result', message, { translated_text: message }, () => pure.audioTranslateResultPatch(message));
      patch('audio_translate_patch', 'action_result', message, { text: message }, () => pure.audioTranslateActionResult({ text: message }));
      patch('audio_translate_patch', 'action_result', 'error-' + message, { error: message }, () => pure.audioTranslateActionResult({ error: message }));
      patch('world_generation_patch', 'action_result', message, { error: message }, () => pure.worldGenerationActionResult({ error: message }));
      patch('world_generation_patch', 'failure', message, { outcome: { kind: 'failed', message } }, () => pure.worldGenerationFailureOutcome({ kind: 'failed', message }, t));
    }
    const audioCases = [
      {}, { node_id: 'missing' }, { env: { ...audioPayload(locale).env, project: '' } },
      { env: { ...audioPayload(locale).env, project: null, product_operation: null } },
      { env: { ...audioPayload(locale).env, canvas_id: '', product_operation: { project_id: 'p', operation_id: 'o' } } },
      ...[{ text: '' }, { text: 17 }, { text: null, segments: [{ type: 'text', value: 'Legacy ' }, { type: 'pause', value: 7 }, { type: 'text', value: 'speech' }] }, { text: ' ', voiceoverText: 'Fallback' }, { text: '', prompt: 'Piano', audioKind: 'music' }].map(data => ({ canvas: { nodes: [{ ...audioPayload().canvas.nodes[0], data }], edges: [] } })),
      { canvas: { nodes: [source()], edges: [] } },
    ];
    for (const [i, changes] of audioCases.entries()) {
      const p = { ...audioPayload(locale), ...changes };
      const op = p.env.product_operation;
      add('audio_translate_request', `audio-${i}-${locale}`, p, () => pure.buildAudioTranslateRequest({ nodes: p.canvas.nodes, nodeId: p.node_id,
        projectId: p.env.project, canvasId: p.env.canvas_id, productOperation: op ? { projectId: op.project_id, operationId: op.operation_id,
          generationAttemptId: 'generation_attempt_id' in op ? op.generation_attempt_id : undefined } : null }));
    }
    const worldCases = [
      {}, { env: { ...worldPayload(locale).env, blocked: true, project: '' } },
      { env: { ...worldPayload(locale).env, project: null } }, { env: { ...worldPayload(locale).env, project: undefined } }, { env: { ...worldPayload(locale).env, project: '' } },
      { env: { ...worldPayload(locale).env, is_generating: true } },
      { upstream: null }, { upstream: { node_id: 'text', kind: 'text' } }, { source_node: null },
      ...[{ imageUrl: null }, { imageUrl: 7, previewImageUrl: url }, { referenceImageUrl: url, imageUrl: '' },
        { imageUrl: 'data:image/png;base64,AA==' }, { imageUrl: 'blob:https://media.example.test/image' },
        { output_role: 'scene_reverse_master' }, { __freezone_source: { role: 'scene_reverse_master' } },
        { aspectRatio: '2:1' }, { media_kind: 'pano360' }, { aspectRatio: 17 }].map(data => ({ source_node: source(data) })),
      { node_data: { plyKind: 'pano' as const } }, { node_data: { plyKind: 'reverse' as const } },
      { env: { ...worldPayload(locale).env, canvas_id: '', product_operation: null } },
    ];
    for (const [i, changes] of worldCases.entries()) {
      const p = { ...worldPayload(locale), ...changes };
      const upstream = p.upstream === null ? null : { nodeId: p.upstream.node_id, kind: p.upstream.kind === 'text' ? 'text' as const : 'image' as const };
      const ctx: pure.WorldGenerationRequestContext = { nodeId: p.node_id, data: p.node_data, sourceNode: p.source_node,
        upstream, projectId: p.env.project, canvasId: p.env.canvas_id, blocked: p.env.blocked, isGenerating: p.env.is_generating,
        productOperation: p.env.product_operation ? productOperation : null, translate: t };
      const inlineSource = p.source_node?.data.imageUrl === 'data:image/png;base64,AA=='
        || p.source_node?.data.imageUrl === 'blob:https://media.example.test/image';
      add('world_generation_request', `world-${i}-${locale}`, p, () => inlineSource
        ? { ok: false, code: 'inline_media_reference', patches: [] }
        : pure.buildWorldGenerationRequest(ctx));
      if (inlineSource) continue;
      const prepared = pure.buildWorldGenerationRequest(ctx);
      if (prepared.ok) for (const started_at_ms of [0, 123.5]) {
        const prepared_request = { source_node_id: prepared.sourceNodeId, source_url: prepared.sourceUrl,
          source_kind: prepared.sourceKind, raw_pano_source: prepared.rawPanoSource, request: prepared.request };
        patch('world_generation_patch', 'start', `${i}-${started_at_ms}`, { prepared_request, node_data: p.node_data, started_at_ms },
          () => pure.worldGenerationStartPatch({ request: prepared, data: p.node_data, startedAtMs: started_at_ms }));
      }
    }
    for (const source_node of [null, source(), source({ output_role: 'scene_reverse_master' }), source({ __freezone_source: { role: 7 } })]) {
      for (const visible_source_kind of ['master', 'pano'] as const) patch('world_generation_patch', 'source_kind', JSON.stringify({ source_node, visible_source_kind }),
        { source_node, visible_source_kind }, () => pure.imageTo3gsKindForSource(source_node, visible_source_kind));
    }
    const raw = { id: 'raw', source_type: 'pano360', source_kind: 'pano', url, pano_url: url } as const;
    const current = { id: 'keep', source_type: 'sog', source_kind: 'custom', label: 'Existing',
      url, pano_url: url, pano_fs: '/assets/pano.jpg', collision_glb_url: 'https://media.example.test/collision.glb',
      slot_kind: 'scene_360_candidate', fs: '/assets/world.sog', ply_url: 'https://media.example.test/result.sog', current: true,
      transform: { xOffset: 0, yOffset: 1, zOffset: 2, yawDeg: 3, pitchDeg: 4, rollDeg: 5, scale: 1 } } as const;
    for (const source_kind of ['master', 'reverse', 'pano'] as const) for (const result of [undefined, null, {}, '', { ply_url: current.ply_url }, { url: 'https://media.example.test/result.ply' }, { nested: { sog_url: current.ply_url } }]) {
      // Stored sources are node data: the browser passes data.sources through without normalising them.
      const stored = [{ ...current, transform: { yawDeg: 90 }, stored_note: 'kept' }, { id: 'odd', source_type: 'sog', label: 7 }] as unknown as typeof current[];
      for (const current_sources of [[], [current], [{ id: 'mesh', source_type: 'mesh' as const }], stored]) {
        const labels = { pano_3dgs: 'Pano', image_3dgs: 'Image', world_url_missing: 'Missing world' };
        const raw_pano_source = source_kind === 'pano' ? raw : null;
        patch('world_generation_patch', 'success', JSON.stringify({ source_kind, result, current_sources }),
          { result, generated_id: 'caller-generated-id', source_kind, raw_pano_source, current_sources, labels },
          () => pure.worldGenerationSuccessPatch({ result, generatedId: 'caller-generated-id', sourceKind: source_kind, rawPanoSource: raw_pano_source,
            currentSources: current_sources, labels: { pano3dgs: labels.pano_3dgs, image3dgs: labels.image_3dgs, worldUrlMissing: labels.world_url_missing } }));
      }
    }
    patch('world_generation_patch', 'failure', 'timeout', { outcome: { kind: 'poll_timeout' } }, () => pure.worldGenerationFailureOutcome({ kind: 'poll_timeout' }, t));
    for (const output of [{}, { ply_url: url, pano_url: '' }]) for (const latest_node of [undefined, source(),
      { ...source(), type: CANVAS_NODE_TYPES.threeDWorld, data: { plyUrl: 'https://media.example.test/latest.sog', panoUrl: 7 } },
      { ...source(), type: CANVAS_NODE_TYPES.threeDWorld, data: { plyUrl: '', panoUrl: url } }]) {
      patch('world_generation_patch', 'action_result', JSON.stringify({ output, latest_node }), { output, latest_node },
        () => pure.worldGenerationActionResult({ output: { plyUrl: output.ply_url, panoUrl: output.pano_url }, latestNode: latest_node }));
    }
  }
  return fixtures;
}
