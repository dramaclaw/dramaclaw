// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasEdge, type CanvasNode } from '../domain/canvasNodes';
import { collectUpstreamReferenceUrls, DefaultGraphContentResolver, extractUpstreamContent } from './graphContentResolver';

describe('extractUpstreamContent workflow metadata', () => {
  it('reads an uploaded image from its source URL', () => {
    const source = {
      id: 'source', type: CANVAS_NODE_TYPES.upload,
      position: { x: 0, y: 0 }, data: { source_url: '/static/project/upload.png' },
    } as CanvasNode;
    expect(extractUpstreamContent(source).imageUrl).toBe('/static/project/upload.png');
  });
  it('passes only the connected existing image to a Recipe target', () => {
    const source = (id: string, imageUrl: string) => ({
      id, type: CANVAS_NODE_TYPES.upload, position: {x: 0, y: 0}, data: {imageUrl},
    }) as CanvasNode;
    const target = {
      id: 'blue-cup', type: CANVAS_NODE_TYPES.imageGen,
      position: {x: 0, y: 0}, data: {},
    } as CanvasNode;
    const nodes = [source('red-cup-source', '/static/red.png'),
      source('distractor-source', '/static/distractor.png'), target];
    const edges = [{id: 'reference', source: 'red-cup-source', target: 'blue-cup',
      data: {link_type: 'media_input_for'}}] as CanvasEdge[];
    const inputs = new DefaultGraphContentResolver().collectInputContents('blue-cup', nodes, edges);
    expect(collectUpstreamReferenceUrls(inputs)).toEqual(['/static/red.png']);
  });
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
