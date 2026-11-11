// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskPollTimeoutError } from '@/api/tasks';
import type { FreezoneJobRef } from '@/api/ops';
import { buildImageToolRequest, GRID_RUN_ACTIONS } from '@/features/canvas/application/generationRequests/imageToolRequest';
import type { ImageToolAction } from '@/features/canvas/application/generationRequests/imageToolRequest';
import {
  imageToolAcceptedPatch, imageToolOutputResolution, imageToolSuccessPatch,
  imageToolFailurePatch, imageToolViewerPlan, imageToolActionResult,
} from '@/features/canvas/application/generationRequests/imageToolResult';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { DEFAULT_SHARED_MODEL_ID } from '@/features/canvas/domain/defaultModelIds';
import { DEFAULT_UPSCALE_MODEL_ID } from '@/features/canvas/domain/modelOptions';
import type { ModelOption } from '@/features/canvas/domain/modelOptions';
import { collectImportGraph } from './importGraph';
import captured from './imageToolExpected.json';

const nowMs = 1234567890000;
const projectId = 'image tools / parity';
const sourceUrl = 'https://media.example.test/source.png?version=7&size=large';
const outputUrl = 'https://media.example.test/result.png';
const translate = (key: string) => `translated:${key}`;
// Independent action inventory: removing a mapping cannot silently remove coverage.
const actions = [
  'run_outpaint_tool', 'run_upscale_tool', 'run_scene360_tool',
  'run_grid_multi_camera', 'run_grid_plot_four', 'run_grid_face_three_view',
  'run_grid_product_three_view', 'run_grid_serial_storyboard_25',
  'run_grid_cinematic_light_correction', 'run_grid_character_three_view',
  'run_grid_scene_setting_sheet', 'run_grid_frame_projection_3s_later',
  'run_grid_frame_projection_5s_earlier',
] as const satisfies readonly ImageToolAction[];
const model = (id: string, apiModel: string): ModelOption => ({ id, apiModel, providerId: 'newapi', label: id });
const catalogs = [
  { name: 'defaults after first', models: [model('first', 'first-api'), model(DEFAULT_SHARED_MODEL_ID, 'default-api'),
    ...(DEFAULT_UPSCALE_MODEL_ID === DEFAULT_SHARED_MODEL_ID ? [] : [model(DEFAULT_UPSCALE_MODEL_ID, 'upscale-api')])] },
  { name: 'without defaults', models: [model('first', 'first-api'), model('second', 'second-api')] },
  { name: 'empty', models: [] },
  { name: 'empty api model', models: [model('first', '')] },
];
function sourceNode(data: Record<string, unknown> = {}): CanvasNode {
  return { id: 'source', type: CANVAS_NODE_TYPES.imageEdit, position: { x: 30, y: 60 }, data: {
    imageUrl: sourceUrl, aspectRatio: '16:9', projection_key: 'projection',
    committed_slot_url: 'https://media.example.test/slot.png',
    slot_target: { kind: 'scene_master', scene_id: 'scene-1' },
    mainline_context: [{ kind: 'scene', projectId, sceneId: 'scene-1', label: 'Scene' }],
    preset_managed: true, ...data,
  } } as CanvasNode;
}
type Fixture = {
  action: ImageToolAction;
  models?: ModelOption[];
  result?: { output_url?: string | null } | null;
  fallbackUrl?: string;
  fault?: 'submit' | 'wait' | 'fetch';
  thrown?: unknown;
  nodes?: CanvasNode[];
  project?: string;
};
function comparePure(fixture: Fixture) {
  const name = expect.getState().currentTestName!.split(' > ').slice(-1)[0];
  const expected = captured[name as keyof typeof captured];
  const nodes = fixture.nodes ?? [sourceNode()];
  const before = structuredClone(nodes);
  const request = buildImageToolRequest({
    action: fixture.action, nodes, nodeId: 'source', projectId: fixture.project ?? projectId,
    imageModels: fixture.models ?? catalogs[0].models, translate, nowMs,
  });
  expect(nodes).toStrictEqual(before);
  const envelope = { requestId: 'image-tool-request', nodeId: 'source', action: fixture.action };
  if (!request.ok) {
    expect(expected).toStrictEqual({
      submitted: [], accepted: [], children: [], layouts: [], edges: [], patches: [],
      result: { ...envelope, ...imageToolActionResult({ message: request.message }) }, trace: ['result'],
    });
    return;
  }
  const task: FreezoneJobRef = { task_key: 'image-tool-task', job_id: 'image-tool-job',
    task_type: fixture.action === 'run_outpaint_tool' ? 'freezone_outpaint'
      : fixture.action === 'run_upscale_tool' ? 'freezone_upscale'
        : fixture.action === 'run_scene360_tool' ? 'freezone_scene_360' : 'freezone_template_edit' };
  const thrown = fixture.thrown ?? new Error('Tool failed');
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  const patches: Record<string, unknown>[] = fixture.fault === 'submit' ? [] : [imageToolAcceptedPatch(task)];
  let url = '';
  if (fixture.fault) patches.push(imageToolFailurePatch(message));
  else {
    const resolution = imageToolOutputResolution({
      result: fixture.result === undefined ? { output_url: outputUrl } : fixture.result, task,
    });
    url = resolution.kind === 'resolved' ? resolution.url : fixture.fallbackUrl ?? outputUrl;
    patches.push(imageToolSuccessPatch({ action: fixture.action, url }));
  }
  const viewer = fixture.fault ? null : imageToolViewerPlan({ action: fixture.action, childNodeId: 'child' });
  const result = fixture.fault ? imageToolActionResult({ message })
    : fixture.action === 'run_scene360_tool'
      ? imageToolActionResult({ action: fixture.action, childNodeId: 'child', viewerNodeId: 'viewer', url, task })
      : imageToolActionResult({ action: fixture.action, childNodeId: 'child', url, task });
  const actual = {
    submitted: [{ route: request.route, body: request.body }], accepted: [envelope],
    children: [{ type: request.child.type, data: request.child.data },
      ...(viewer ? [{ type: viewer.node.type }] : [])],
    layouts: [request.child.layout, ...(viewer ? [viewer.node.layout] : [])],
    edges: [request.edge, ...(viewer ? [viewer.edge] : [])], patches,
    result: { ...envelope, ...result },
    trace: ['accepted', 'node', 'edge', 'submit', ...(fixture.fault === 'submit' ? [] : ['patch']),
      'patch', ...(viewer ? ['node', 'edge'] : []), 'result'],
  };
  expect(JSON.parse(JSON.stringify(actual))).toStrictEqual(expected);
  expect(JSON.stringify(request.body)).toBe(JSON.stringify(expected.submitted[0].body));
  if (fixture.action !== 'run_scene360_tool') {
    expect(JSON.stringify(request.child.data)).toBe(JSON.stringify(expected.children[0].data));
  }
}

describe('pure image tool requests and results', () => {
  for (const action of actions) {
    it.each([
      { name: 'direct output', result: { output_url: outputUrl } },
      { name: 'missing output fallback', result: {} },
      { name: 'null result fallback', result: null },
      { name: 'empty direct output', result: { output_url: '' } },
      { name: 'null output fallback', result: { output_url: null } },
      { name: 'empty fetched output', result: {}, fallbackUrl: '' },
    ])(`${action}: $name`, async fixture => { await comparePure({ action, ...fixture }); });
    it.each(['submit', 'wait', 'fetch'] as const)(`${action}: %s failure`, async fault => {
      await comparePure({ action, fault, result: {} });
    });
    it.each([
      { name: 'missing source', nodes: [sourceNode({ imageUrl: null })] },
      { name: 'missing node', nodes: [] },
      { name: 'missing project', project: '' },
    ])(`${action}: $name refusal`, async fixture => { await comparePure({ action, ...fixture }); });
  }
  for (const action of ['run_outpaint_tool', 'run_upscale_tool'] as const) {
    it.each(catalogs)(`${action}: $name catalog`, async ({ models }) => { await comparePure({ action, models }); });
  }
  it.each([
    { name: 'image reference fallback', node: { ...sourceNode(), type: CANVAS_NODE_TYPES.imageGen,
      data: { referenceImageUrl: sourceUrl } } },
    { name: 'upload preview fallback and numeric ratio', node: { ...sourceNode(), type: CANVAS_NODE_TYPES.upload,
      data: { previewImageUrl: sourceUrl, aspectRatio: 2 } } },
    { name: 'export image and empty ratio', node: { ...sourceNode(), type: CANVAS_NODE_TYPES.exportImage,
      data: { imageUrl: sourceUrl, aspectRatio: '' } } },
  ])('$name', async ({ node }) => { await comparePure({ action: 'run_outpaint_tool', nodes: [node as CanvasNode] }); });
  it.each([
    { name: 'empty Error message', thrown: new Error('') },
    { name: 'non-Error rejection', thrown: 'Raw failure' },
    { name: 'poll timeout', thrown: new TaskPollTimeoutError('image-tool-task', 1000) },
  ])('$name is an ordinary tool failure', async ({ thrown }) => {
    await comparePure({ action: 'run_scene360_tool', fault: 'wait', thrown });
  });  for (const action of ['run_outpaint_tool', 'run_upscale_tool', 'run_grid_multi_camera'] as const) {
    it.each(['data:image/png;base64,AA==', 'blob:https://media.example.test/image'])(
      `${action}: inline %s`, async imageUrl => {
        await comparePure({ action, nodes: [sourceNode({ imageUrl })] });
      });
  }

});

describe('pure image-tool boundary', () => {
  it('exports the complete grid action mapping', () => {
    expect(Object.keys(GRID_RUN_ACTIONS)).toStrictEqual(actions.slice(3));
  });
  it('loads the barrel without browser dependencies', () => {
    const srcRoot = path.resolve(__dirname, '../../..');
    const graph = collectImportGraph([path.join(srcRoot, 'features/canvas/application/generationRequests/index.ts')], srcRoot);
    expect([...graph.files].filter(file => /^(api|lib|stores|hooks|components|routes)\//.test(path.relative(srcRoot, file))
      || file.endsWith('.tsx'))).toStrictEqual([]);
    expect([...graph.packages.keys()].filter(name => !['i18next', 'uuid', 'zustand/vanilla'].includes(name))).toStrictEqual([]);
  });
});
