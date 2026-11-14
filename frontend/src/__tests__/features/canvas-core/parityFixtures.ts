// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CanvasChatCommandEnvelope } from '@/features/canvas/core/commands/types';
import type { CanvasNode, CanvasEdge } from '@/features/canvas/domain/canvasNodes';

export function envelope(commands: CanvasChatCommandEnvelope['commands']): CanvasChatCommandEnvelope[] {
  return [{ schema_version: 'canvas_chat_commands.v1', commands }];
}
export function deterministicIds() {
  let id = 0;
  return { next: () => `parity-${++id}` };
}
export function initialCanvas(): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  return {
    nodes: [
      { id: 'source', type: 'textAnnotationNode', position: { x: 10, y: 20 }, data: { content: 'Seed' } },
      { id: 'generated', type: 'imageGenNode', position: { x: 700, y: 20 }, data: { prompt: 'Sea', imageUrl: '/output/sea.png', previewImageUrl: 'data:image/png;base64,AA' } },
      { id: 'spare', type: 'textAnnotationNode', position: { x: 1200, y: 500 }, data: { content: 'Spare' } },
    ],
    edges: [{ id: 'existing-edge', source: 'source', target: 'generated', data: { linkType: 'prompt_for' } }],
  };
}
export const parityBatches = [
  { name: 'create-chain', commands: envelope([
    { type: 'create_node', client_id: 'new', node_type: 'textAnnotationNode', position: { x: 20, y: 800 }, data: { content: 'New' } },
    { type: 'add_next_node', source_node_id: 'new', node_type: 'imageGenNode', connect: true, data: { prompt: 'Moon' } },
    { type: 'create_edge', source: 'spare', target: 'generated', link_type: 'prompt_for' },
  ]) },
  { name: 'update-move', commands: envelope([
    { type: 'update_node_data', node_id: 'source', data: { content: 'Updated input' } },
    { type: 'move_nodes', positions: { source: { x: 50, y: 60 } }, deltas: { spare: { x: 20, y: 30 } } },
  ]) },
  ...(['horizontal', 'vertical', 'grid'] as const).map(mode => ({ name: `layout-${mode}`, layout: true, commands: envelope([{ type: 'layout_nodes', mode }]) })),
  { name: 'group', commands: envelope([{ type: 'group_nodes', node_ids: ['generated', 'spare'], label: 'Outputs' }]) },
  { name: 'delete', commands: envelope([
    { type: 'delete_edges', edge_ids: ['existing-edge'] },
    { type: 'delete_nodes', node_ids: ['spare'] },
  ]) },
  { name: 'clear', commands: envelope([{ type: 'clear_canvas' }]) },
  { name: 'selection', commands: envelope([{ type: 'select_nodes', node_ids: ['source'], focus: true }]) },
];
