// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';
import { createCanvasStore, createNodeCanvasEnvironment } from '@/features/canvas/serverEntry';
import { CANVAS_NODE_TYPES, type CanvasNode, type CanvasEdge } from '@/features/canvas/domain/canvasNodes';
import { defaultNodeDataDefaults } from '@/features/canvas/domain/nodeRegistry';
import { planCanvasNodeActions } from '@/features/freezone/workflowActionPlan';

const options = { selectedNodeIds: [], nodeDataDefaults: defaultNodeDataDefaults };
function store(nodes: CanvasNode[], edges: CanvasEdge[] = []) {
  const result = createCanvasStore(createNodeCanvasEnvironment({ translate: key => key }));
  result.getState().setCanvasData(nodes, edges);
  return result;
}
const text: CanvasNode = { id: 'text', type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 0, y: 0 },
  data: { content: '', workflowCatalog: { recipeId: 'general-text' } } };
const image: CanvasNode = { id: 'image', type: CANVAS_NODE_TYPES.imageGen, position: { x: 300, y: 0 }, data: { prompt: 'A scene' } };
const video: CanvasNode = { id: 'video', type: CANVAS_NODE_TYPES.video, position: { x: 600, y: 0 }, data: { prompt: 'A shot' } };
const edges = [{ id: 'text-image', source: 'text', target: 'image' }, { id: 'image-video', source: 'image', target: 'video' }];
const textAction = { commandIndex: 0, nodeId: 'text', action: 'generate_text', executionMode: 'workflow', label: '打开节点动作' };
const imageAction = { commandIndex: 0, nodeId: 'image', action: 'generate_image', executionMode: 'workflow', label: '生成图片' };
const videoAction = { commandIndex: 0, nodeId: 'video', action: 'generate_video', executionMode: 'workflow', label: '生成视频' };

describe('pure workflow action planning', () => {
  it('plans a chain from its video endpoint', () => {
    expect(planCanvasNodeActions(store([video, image, text], edges), [{ type: 'run_workflow', node_ids: ['video'] }], options)).toEqual({
      ok: true, actions: [textAction, imageAction, videoAction], levels: [[0], [1], [2]],
      dependencies: { image: ['text'], video: ['image'] }, alreadyCompleted: false,
    });
  });
  it('puts independent images in the same stable layer', () => {
    const second = { ...image, id: 'second' };
    expect(planCanvasNodeActions(store([image, second, video], [edges[1], { id: 'second-video', source: 'second', target: 'video' }]),
      [{ type: 'run_workflow', node_ids: ['video'] }], options)).toEqual({
      ok: true, actions: [imageAction, { ...imageAction, nodeId: 'second' }, videoAction], levels: [[0, 1], [2]],
      dependencies: { video: ['image', 'second'] }, alreadyCompleted: false,
    });
  });
  it('skips completed results and marks an entirely completed workflow', () => {
    const canvas = store([{ ...image, data: { ...image.data, imageUrl: '/static/image.png' } }, video], [edges[1]]);
    expect(planCanvasNodeActions(canvas, [{ type: 'run_workflow', node_ids: ['video'] }], options)).toEqual({
      ok: true, actions: [videoAction], levels: [[0]], dependencies: {}, alreadyCompleted: false,
    });
    expect(planCanvasNodeActions(canvas, [{ type: 'run_workflow', node_ids: ['image'], direction: 'node' }], options)).toEqual({
      ok: true, actions: [], levels: [], dependencies: {}, alreadyCompleted: true,
    });
    expect(planCanvasNodeActions(canvas, [{ type: 'run_workflow', node_ids: ['image'], direction: 'node', regenerate: true }], options)).toEqual({
      ok: true, actions: [{ ...imageAction, invalidationReason: 'explicit_regeneration' }], levels: [[0]], dependencies: {}, alreadyCompleted: false,
    });
  });
  it('rejects a dependency cycle', () => {
    expect(planCanvasNodeActions(store([image, video], [edges[1], { id: 'back', source: 'video', target: 'image' }]),
      [{ type: 'run_workflow', scope: 'canvas' }], options)).toEqual({
      ok: false, code: 'workflow_cycle', message: '画布连接线存在环形依赖，已取消本批节点动作。',
    });
  });
  it('plans missing upstream results before a single requested action', () => {
    const canvas = store([{ ...text, data: { ...text.data, content: 'Done', workflowTextGenerated: true } }, image, video], edges);
    expect(planCanvasNodeActions(canvas, [{ type: 'run_node_action', node_id: 'video', action: 'generate_video', parameters: { seed: 7 } }], options)).toEqual({
      ok: true, actions: [imageAction, { ...videoAction, executionMode: 'single', parameters: { seed: 7 } }],
      levels: [[0], [1]], dependencies: { video: ['image'] }, alreadyCompleted: false,
    });
  });
  it('ignores story playback dependencies until continuity is enabled', () => {
    const first = { ...video, id: 'first' };
    const canvas = store([first, video], [{ id: 'choice', source: 'first', target: 'video', type: 'storyChoiceEdge' }]);
    expect(planCanvasNodeActions(canvas, [{ type: 'run_workflow', scope: 'canvas' }], options)).toEqual({
      ok: true, actions: [{ ...videoAction, nodeId: 'first' }, videoAction], levels: [[0, 1]], dependencies: {}, alreadyCompleted: false,
    });
    canvas.getState().updateNodeData('video', { continuityMode: 'auto' });
    expect(planCanvasNodeActions(canvas, [{ type: 'run_workflow', scope: 'canvas' }], options)).toEqual({
      ok: true, actions: [{ ...videoAction, nodeId: 'first' }, videoAction], levels: [[0], [1]], dependencies: { video: ['first'] }, alreadyCompleted: false,
    });
  });
  it('keeps the first action and its parameters across a batch', () => {
    expect(planCanvasNodeActions(store([image]), [
      { type: 'run_node_action', node_id: 'image', action: 'generate_image', parameters: { seed: 1 } },
      { type: 'run_workflow', scope: 'canvas', regenerate: true },
      { type: 'run_node_action', node_id: 'image', action: 'generate_image', parameters: { seed: 2 } },
    ], options)).toEqual({ ok: true, actions: [{ ...imageAction, executionMode: 'single', parameters: { seed: 1 } }],
      levels: [[0]], dependencies: {}, alreadyCompleted: false });
  });
  it('reports empty workflows and unavailable actions', () => {
    expect(planCanvasNodeActions(store([]), [{ type: 'run_workflow', scope: 'canvas' }], options)).toEqual({
      ok: false, code: 'workflow_empty', message: '工作流中没有可执行的生成节点。',
    });
    expect(planCanvasNodeActions(store([image]), [{ type: 'run_node_action', node_id: 'image', action: 'generate_video' }], options)).toEqual({
      ok: false, code: 'action_unavailable', message: 'action not available on node: generate_video',
    });
  });
  it('uses explicit selection and orders through unscheduled intermediaries', () => {
    const middle: CanvasNode = { id: 'middle', type: CANVAS_NODE_TYPES.textAnnotation, position: { x: 0, y: 0 }, data: { content: 'Reference' } };
    expect(planCanvasNodeActions(store([video, middle, image], [
      { id: 'a', source: 'image', target: 'middle' }, { id: 'b', source: 'middle', target: 'video' },
    ]), [{ type: 'run_workflow' }], { ...options, selectedNodeIds: ['video'] })).toEqual({
      ok: true, actions: [imageAction, videoAction], levels: [[0], [1]], dependencies: { video: ['image'] }, alreadyCompleted: false,
    });
  });
});
