// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '../domain/canvasNodes';
import { extractUpstreamContent } from './graphContentResolver';

describe('extractUpstreamContent workflow metadata', () => {
  it('projects workflow step ids for deterministic input selection', () => {
    const node = {
      id: 'brief-node',
      type: CANVAS_NODE_TYPES.textAnnotation,
      position: { x: 0, y: 0 },
      data: {
        content: '广告脚本',
        workflowCatalog: { stepId: 'ad-brief' },
      },
    } as CanvasNode;

    expect(extractUpstreamContent(node)).toMatchObject({
      nodeId: 'brief-node',
      workflowStepId: 'ad-brief',
      text: '广告脚本',
    });
  });
});
