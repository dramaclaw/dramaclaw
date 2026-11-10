// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { expect, it } from 'vitest';
import { servePlanWorkflow } from '@/features/canvas/server/planWorkflow';
import { InvalidRequest } from '@/features/canvas/server/requestPayload';

const canvas = { nodes: [
  { id: 'text', type: 'textAnnotationNode', position: { x: 0, y: 0 }, data: { content: '', workflowCatalog: { recipeId: 'general-text' } } },
  { id: 'image', type: 'imageGenNode', position: { x: 300, y: 0 }, data: { prompt: 'A scene' } },
  { id: 'video', type: 'videoNode', position: { x: 600, y: 0 }, data: { prompt: 'A shot' } },
], edges: [{ id: 'a', source: 'text', target: 'image' }, { id: 'b', source: 'image', target: 'video' }] };

it('serves a JSON workflow plan without a browser', async () => {
  const payload = JSON.parse(JSON.stringify({ canvas, commands: [{ type: 'run_workflow', node_ids: ['video'] }] }));
  expect(await servePlanWorkflow(payload)).toEqual({ ok: true, actions: [
    { command_index: 0, node_id: 'text', action: 'generate_text', execution_mode: 'workflow', label: '打开节点动作' },
    { command_index: 0, node_id: 'image', action: 'generate_image', execution_mode: 'workflow', label: '生成图片' },
    { command_index: 0, node_id: 'video', action: 'generate_video', execution_mode: 'workflow', label: '生成视频' },
  ], levels: [[0], [1], [2]], dependencies: { image: ['text'], video: ['image'] }, already_completed: false });
});
it.each([
  {},
  { canvas, commands: [{ type: 'create_node', node_type: 'imageGenNode' }] },
  { canvas, commands: [{ type: 'run_node_action', node_id: 'image' }] },
  { canvas: { nodes: [{}], edges: [] }, commands: [] },
  { canvas, commands: [{ type: 'run_workflow' }], env: { selectedNodeIds: [1] } },
])('rejects malformed or non-run payloads %#', async payload => {
  await expect(servePlanWorkflow(payload)).rejects.toBeInstanceOf(InvalidRequest);
});
