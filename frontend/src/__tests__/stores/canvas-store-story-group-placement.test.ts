import { beforeEach, describe, expect, it } from 'vitest';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { placeGroupsOutsideStory } from '@/features/canvas/application/storyGroupPlacement';
import { useCanvasStore } from '@/stores/canvasStore';
import {
  applyCanvasChatCommands,
  CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
  type CanvasChatCommandEnvelope,
} from '@/features/freezone/canvasChatCommands';

function group(id: string, x: number, y: number, width: number, height: number, story = false): CanvasNode {
  return {
    id, type: CANVAS_NODE_TYPES.group, position: { x, y },
    style: { width, height }, data: { label: id, storyGroup: story },
  };
}

function intersects(a: CanvasNode, b: CanvasNode): boolean {
  const width = (node: CanvasNode) => Number(node.width ?? node.style?.width);
  const height = (node: CanvasNode) => Number(node.height ?? node.style?.height);
  return a.position.x < b.position.x + width(b) && a.position.x + width(a) > b.position.x
    && a.position.y < b.position.y + height(b) && a.position.y + height(a) > b.position.y;
}

describe('generated groups beside interactive stories', () => {
  beforeEach(() => useCanvasStore.getState().setCanvasData([], []));

  it('leaves standalone generated images at their original positions', () => {
    const image: CanvasNode = {
      id: 'image', type: CANVAS_NODE_TYPES.imageGen, position: { x: 100, y: 100 },
      data: { workflowInstanceId: 'workflow-image', isGenerating: true },
    };
    const nodes = [group('story', 0, 0, 2000, 1000, true), image];
    expect(placeGroupsOutsideStory(nodes)).toBe(nodes);
    expect(placeGroupsOutsideStory(nodes, new Set([image.id]))).toBe(nodes);
  });

  it.each([false, true])('keeps a batch brief with its images during grouping, placement and movement (external MCP: %s)', (external) => {
    const story = group('story', 0, 0, 2000, 1200, true);
    useCanvasStore.getState().setCanvasData([story], []);
    const result = applyCanvasChatCommands([{
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      external_mcp_command: external,
      commands: [
        {
          type: 'create_node', client_id: 'brief', node_type: CANVAS_NODE_TYPES.textAnnotation,
          position: { x: 80, y: 80 },
          data: { content: '本批共用视觉描述', semanticOutputRole: 'input_text', workflowInstanceId: 'workflow' },
        },
        ...['first', 'second'].map((clientId, index) => ({
          type: 'create_node' as const, client_id: clientId, node_type: CANVAS_NODE_TYPES.imageGen,
          position: { x: 80 + index * 600, y: 480 },
          data: { prompt: clientId, workflowInstanceId: 'workflow' },
        })),
        { type: 'create_edge', source: 'brief', target: 'first', link_type: 'prompt_for' },
        { type: 'create_edge', source: 'brief', target: 'second', link_type: 'prompt_for' },
        { type: 'group_nodes', node_ids: ['brief', 'first', 'second'], label: '角色参考图' },
        { type: 'layout_nodes', node_ids: ['brief', 'first', 'second'], mode: 'grid' },
      ],
    }]);

    expect(result.errors).toEqual([]);
    const state = useCanvasStore.getState();
    const batch = state.nodes.find((node) => node.type === CANVAS_NODE_TYPES.group && node.id !== story.id)!;
    const children = state.nodes.filter((node) => node.parentId === batch.id);
    expect(children).toHaveLength(3);
    expect(children.some((node) => node.type === CANVAS_NODE_TYPES.textAnnotation)).toBe(true);
    expect(intersects(batch, story)).toBe(false);
    expect(state.edges).toHaveLength(2);
    const childPositions = children.map((node) => node.position);
    const oldBriefX = batch.position.x + childPositions[0].x;

    state.setNodePositions({ [batch.id]: { x: batch.position.x + 300, y: batch.position.y + 200 } });

    const moved = useCanvasStore.getState().nodes;
    expect(moved.filter((node) => node.parentId === batch.id).map((node) => node.position)).toEqual(childPositions);
    expect(moved.find((node) => node.id === batch.id)!.position.x + childPositions[0].x).toBe(oldBriefX + 300);
  });

  it.each([false, true])('places character, scene and frame workflows around the story (external MCP: %s)', (external) => {
    const story = group('story', -200, -100, 1800, 1400, true);
    useCanvasStore.getState().setCanvasData([story], []);
    const commands: CanvasChatCommandEnvelope['commands'] = [];
    for (const kind of ['characters', 'scenes', 'frames']) {
      for (const index of [0, 1]) {
        commands.push({
          type: 'create_node', node_type: CANVAS_NODE_TYPES.imageGen,
          client_id: `${kind}-${index}`, position: { x: index * 600, y: 100 },
          data: { prompt: kind, workflowInstanceId: `workflow-${kind}` },
        });
      }
      commands.push({ type: 'create_edge', source: `${kind}-0`, target: `${kind}-1`, link_type: 'media_input_for' });
      commands.push({ type: 'group_nodes', node_ids: [`${kind}-0`, `${kind}-1`], label: kind });
      commands.push({ type: 'layout_nodes', node_ids: [`${kind}-0`, `${kind}-1`], mode: 'grid' });
    }
    const result = applyCanvasChatCommands([{
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      external_mcp_command: external, commands,
    }]);

    expect(result.errors).toEqual([]);
    const state = useCanvasStore.getState();
    expect(state.nodes.find((node) => node.id === story.id)?.position).toEqual(story.position);
    const roots = state.nodes.filter((node) => !node.parentId);
    expect(roots).toHaveLength(4);
    for (let i = 0; i < roots.length; i += 1) {
      for (let j = i + 1; j < roots.length; j += 1) expect(intersects(roots[i], roots[j])).toBe(false);
    }
    expect(state.edges).toHaveLength(3);
    for (const root of roots.filter((node) => node.id !== story.id)) {
      const members = state.nodes.filter((node) => node.parentId === root.id);
      expect(members).toHaveLength(2);
      expect(members[0].position.x).toBeLessThan(members[1].position.x);
      expect(members[0].position.y).toBe(members[1].position.y);
    }
  });

  it('repairs saved projection overlaps using style bounds and keeps child coordinates and edges', () => {
    const story = group('story', 0, 0, 2400, 1000, true);
    const asset = group('asset', 100, 200, 800, 500);
    asset.data = { ...asset.data, preset_managed: true, projection_key: 'asset:scene:street' };
    const child: CanvasNode = {
      id: 'child', type: CANVAS_NODE_TYPES.imageGen, parentId: asset.id,
      position: { x: 20, y: 34 }, data: { imageUrl: 'scene.png' },
    };
    const source: CanvasNode = {
      id: 'source', type: CANVAS_NODE_TYPES.textAnnotation,
      position: { x: 5000, y: 0 }, data: { content: 'scene prompt' },
    };
    useCanvasStore.getState().setCanvasData([story, asset, child, source], [{ id: 'link', source: 'source', target: 'child' }]);
    const state = useCanvasStore.getState();
    const placed = state.nodes.find((node) => node.data.projection_key === 'asset:scene:street'
      && node.type === CANVAS_NODE_TYPES.group)!;
    expect(intersects(placed, story)).toBe(false);
    expect(state.nodes.find((node) => node.parentId === placed.id)?.position).toEqual(child.position);
    expect(state.edges[0].target).toBe(state.nodes.find((node) => node.parentId === placed.id)?.id);
    expect(placeGroupsOutsideStory(state.nodes)).toBe(state.nodes);
  });

  it('uses grown group dimensions even while measured still reports the old size', () => {
    const story = group('story', 1000, 0, 2000, 1000, true);
    const asset = group('asset', 0, 100, 1600, 600);
    asset.measured = { width: 800, height: 400 };
    const placed = placeGroupsOutsideStory([story, asset], new Set([asset.id]));
    expect(intersects(placed[1], story)).toBe(false);
    expect(placed[0]).toBe(story);
  });

  it('rechecks placement when measured children grow the generated group', () => {
    const story = group('story', 1000, 0, 2000, 1000, true);
    const asset = group('asset', 0, 100, 800, 600);
    const child: CanvasNode = {
      id: 'child', type: CANVAS_NODE_TYPES.imageGen, parentId: asset.id,
      position: { x: 900, y: 34 }, width: 580, height: 360,
      data: { prompt: 'character', workflowInstanceId: 'workflow' },
    };
    useCanvasStore.getState().setCanvasData([story, asset, child], []);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === asset.id)?.position).toEqual(asset.position);
    const historyLength = useCanvasStore.getState().history.past.length;

    useCanvasStore.getState().fitGroupToChildren(asset.id);

    const state = useCanvasStore.getState();
    expect(intersects(state.nodes.find((node) => node.id === asset.id)!, story)).toBe(false);
    expect(state.nodes.find((node) => node.id === child.id)?.position).toEqual(child.position);
    expect(state.history.past).toHaveLength(historyLength);
  });

  it('preserves valid placements and ordinary manual groups when restoring a canvas', () => {
    const story = group('story', 0, 0, 2000, 1000, true);
    const manual = group('manual', 100, 100, 600, 400);
    const generated = group('generated', -1000, 100, 600, 400);
    generated.data = { ...generated.data, workflowInstanceId: 'workflow' };
    const nodes = [story, manual, generated];
    expect(placeGroupsOutsideStory(nodes)).toBe(nodes);
  });
});
