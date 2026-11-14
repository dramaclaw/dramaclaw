// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createCanvasStore, createNodeCanvasEnvironment } from '../serverEntry';
import { parseCanvasPayload } from './requestPayload';
import * as pure from '../application/generationRequests';
import { imageModelOptionsFromPayload } from '../domain/modelCatalogPayload';
import { SHARED_MODELS, VIDEO_MODELS } from '../domain/modelOptions';
import * as p from './generationPayload';
import { project } from './toolPayload';
import { invalidRequest } from './requestPayload';
import { createServerTranslate } from './i18n';
import { runServerRequest } from './requestScope';

function action(value: unknown): pure.ImageToolAction {
  return p.choice(value, ['run_outpaint_tool', 'run_upscale_tool', 'run_scene360_tool',
    'run_grid_multi_camera', 'run_grid_plot_four', 'run_grid_face_three_view', 'run_grid_product_three_view',
    'run_grid_serial_storyboard_25', 'run_grid_cinematic_light_correction', 'run_grid_character_three_view',
    'run_grid_scene_setting_sheet', 'run_grid_frame_projection_3s_later', 'run_grid_frame_projection_5s_earlier']);
}

export async function serveImageToolRequest(payload: unknown) {
  const input = p.fields(payload, ['canvas', 'node_id', 'action', 'env']);
  const { canvas, nodeId, env, locale } = p.graph(input);
  p.fields(env, ['locale', 'project', 'image_models', 'now_ms']);
  const context = { nodes: canvas.nodes, nodeId, action: action(input.action), projectId: project(env.project),
    nowMs: p.number(env.now_ms), imageModels: env.image_models === undefined ? SHARED_MODELS : imageModelOptionsFromPayload(env.image_models) };
  return runServerRequest(locale, async () => {
    const decision = pure.buildImageToolRequest({ ...context, translate: await createServerTranslate(locale) });
    if (decision.ok) {
      const source = decision.body.source_url ?? decision.body.reference_url;
      if (typeof source === 'string' && (source.startsWith('data:') || source.startsWith('blob:'))) {
        return { ok: false, message: 'Inline image sources must be prepared before building an image tool request.' };
      }
    }
    return decision;
  });
}

export async function serveImageToolPatch(payload: unknown) {
  const { input, phase, locale } = p.patch(payload);
  switch (phase) {
    case 'accepted': {
      p.fields(input, ['phase', 'locale', 'task']);
      const task = p.task(input.task);
      return runServerRequest(locale, async () => pure.imageToolAcceptedPatch(task));
    }
    case 'output_resolution': {
      p.fields(input, ['phase', 'locale', 'result', 'task']);
      const task = p.task(input.task);
      const result = p.optional(input.result, value => p.nullable(value, value => {
        const result = p.record(value);
        return { output_url: p.optional(result.output_url, value => p.nullable(value, p.string)) };
      }));
      return runServerRequest(locale, async () => pure.imageToolOutputResolution({ result, task }));
    }
    case 'success': {
      p.fields(input, ['phase', 'locale', 'action', 'url']);
      const parsed = { action: action(input.action), url: p.string(input.url) };
      return runServerRequest(locale, async () => pure.imageToolSuccessPatch(parsed));
    }
    case 'failure': {
      p.fields(input, ['phase', 'locale', 'message']);
      const message = p.string(input.message);
      return runServerRequest(locale, async () => pure.imageToolFailurePatch(message));
    }
    case 'viewer_plan': {
      p.fields(input, ['phase', 'locale', 'action', 'child_node_id']);
      const parsed = { action: action(input.action), childNodeId: p.string(input.child_node_id) };
      return runServerRequest(locale, async () => pure.imageToolViewerPlan(parsed));
    }
    case 'action_result': {
      let parsed: pure.ImageToolActionResultInput;
      if (p.hasField(input, 'message')) {
        p.fields(input, ['phase', 'locale', 'message']);
        parsed = { message: p.string(input.message) };
      } else {
        const selected = action(input.action);
        p.fields(input, ['phase', 'locale', 'action', 'child_node_id', 'url', 'task', ...(selected === 'run_scene360_tool' ? ['viewer_node_id'] : [])]);
        const common = { childNodeId: p.string(input.child_node_id), url: p.string(input.url), task: p.task(input.task) };
        parsed = selected === 'run_scene360_tool' ? { ...common, action: selected, viewerNodeId: p.string(input.viewer_node_id) }
          : { ...common, action: selected };
      }
      return runServerRequest(locale, async () => pure.imageToolActionResult(parsed));
    }
    default: return invalidRequest('Unknown image tool patch phase');
  }
}

export async function serveImageToolPlace(payload: unknown) {
  const input = p.fields(payload, ['canvas', 'locale', 'child_node_id', 'child', 'edge']);
  const { canvas } = parseCanvasPayload({ canvas: input.canvas, envelopes: [] });
  const locale = p.string(input.locale);
  const childNodeId = p.string(input.child_node_id);
  const child = p.fields(input.child, ['type', 'data', 'layout']);
  const type = p.choice(child.type, ['exportImageNode']);
  const data = p.record(child.data);
  const layout = p.fields(child.layout, ['anchorNodeId', 'width', 'height']);
  const anchorNodeId = p.string(layout.anchorNodeId);
  const width = p.number(layout.width), height = p.number(layout.height);
  const edge = p.fields(input.edge, ['source', 'target']);
  const source = p.string(edge.source);
  p.choice(edge.target, ['child']);
  return runServerRequest(locale, async () => {
    let allocated = false;
    const ids = { next: () => {
      if (allocated) throw new Error('Image tool placement allocates one node');
      allocated = true;
      return childNodeId;
    } };
    const store = createCanvasStore(createNodeCanvasEnvironment({
      translate: await createServerTranslate(locale), ids, now: Date.now, videoModels: VIDEO_MODELS,
    }));
    store.getState().setCanvasData(canvas.nodes, canvas.edges);
    const position = store.getState().findNodePosition(anchorNodeId, width, height);
    const id = store.getState().addNode(type, position, data);
    const edgeId = store.getState().addEdge(source, id);
    const state = store.getState();
    return { node: state.nodes.find(node => node.id === id),
      edge: edgeId === null ? null : state.edges.find(edge => edge.id === edgeId) ?? null };
  });
}
