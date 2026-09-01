import { describe, expect, it } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from './canvasNodes';
import { workflowGroupState } from './workflowGroupState';

function node(
  id: string,
  type: CanvasNode['type'],
  data: Record<string, unknown> = {},
): CanvasNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: {
      workflowCatalog: { recipeId: id },
      ...data,
    },
  } as CanvasNode;
}

describe('workflowGroupState', () => {
  it('treats workflow nodes without results as not started', () => {
    const state = workflowGroupState([
      node('image', CANVAS_NODE_TYPES.imageGen),
      node('video', CANVAS_NODE_TYPES.video),
    ]);

    expect(state.status).toBe('not_started');
    expect(state.primaryLabel).toBe('运行');
    expect(state.completedCount).toBe(0);
    expect(state.totalCount).toBe(2);
    expect(state.canContinue).toBe(true);
    expect(state.canRegenerate).toBe(false);
  });

  it('offers continue and regenerate when only part of the workflow has results', () => {
    const state = workflowGroupState([
      node('image', CANVAS_NODE_TYPES.imageGen, { imageUrl: 'https://example.test/image.png' }),
      node('video', CANVAS_NODE_TYPES.video),
    ]);

    expect(state.status).toBe('partial');
    expect(state.primaryLabel).toBe('继续运行');
    expect(state.completedCount).toBe(1);
    expect(state.totalCount).toBe(2);
    expect(state.canContinue).toBe(true);
    expect(state.canRegenerate).toBe(true);
  });

  it('marks completed workflows as completed while still allowing full rerun', () => {
    const state = workflowGroupState([
      node('image', CANVAS_NODE_TYPES.imageGen, { imageUrl: 'https://example.test/image.png' }),
      node('video', CANVAS_NODE_TYPES.video, { videoUrl: 'https://example.test/video.mp4' }),
    ]);

    expect(state.status).toBe('completed');
    expect(state.primaryLabel).toBe('已完成');
    expect(state.completedCount).toBe(2);
    expect(state.totalCount).toBe(2);
    expect(state.canContinue).toBe(false);
    expect(state.canRegenerate).toBe(true);
  });

  it('shows running state and stop affordance while a workflow node is active', () => {
    const state = workflowGroupState([
      node('image', CANVAS_NODE_TYPES.imageGen, { workflowActionRunning: true }),
      node('video', CANVAS_NODE_TYPES.video),
    ]);

    expect(state.status).toBe('running');
    expect(state.primaryLabel).toBe('运行中');
    expect(state.canStop).toBe(true);
    expect(state.canContinue).toBe(false);
    expect(state.canRegenerate).toBe(false);
  });

  it('does not keep a node running after a generated result is available', () => {
    const state = workflowGroupState([
      node('image', CANVAS_NODE_TYPES.imageGen, {
        imageUrl: 'https://example.test/image.png',
        workflowActionRunning: true,
      }),
      node('video', CANVAS_NODE_TYPES.video),
    ]);

    expect(state.status).toBe('partial');
    expect(state.runningCount).toBe(0);
    expect(state.completedCount).toBe(1);
    expect(state.canContinue).toBe(true);
  });

  it('keeps stale generated nodes running when they are being regenerated', () => {
    const state = workflowGroupState([
      node('image', CANVAS_NODE_TYPES.imageGen, {
        imageUrl: 'https://example.test/image.png',
        workflowActionRunning: true,
        workflowResultStale: true,
      }),
      node('video', CANVAS_NODE_TYPES.video),
    ]);

    expect(state.status).toBe('running');
    expect(state.runningCount).toBe(1);
    expect(state.completedCount).toBe(0);
    expect(state.canStop).toBe(true);
  });

  it('does not count workflow input markers as executable nodes', () => {
    const state = workflowGroupState([
      node('input', CANVAS_NODE_TYPES.textAnnotation, {
        workflowCatalog: undefined,
        workflowCatalogRole: 'user_input',
        content: '用户输入',
      }),
    ]);

    expect(state.status).toBe('none');
    expect(state.totalCount).toBe(0);
  });
});
