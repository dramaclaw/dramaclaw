import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { batchGenerateStoryClips } from '@/features/canvas/application/batchGenerateStoryClips';
const mocks = vi.hoisted(() => ({ nodes: [] as CanvasNode[], run: vi.fn(), url: vi.fn() }));
vi.mock('@/stores/canvasStore', () => ({ useCanvasStore: { getState: () => ({ nodes: mocks.nodes }) } }));
vi.mock('@/lib/url-params', () => ({ readUrl: mocks.url }));
vi.mock('@/features/freezone/canvasChatCommands', () => ({ applyCanvasChatCommandsAsync: mocks.run }));
const node = (id: string, data: Record<string, unknown>, parentId = 'story'): CanvasNode =>
  ({ id, type: CANVAS_NODE_TYPES.video, parentId, position: { x: 0, y: 0 }, data } as CanvasNode);
beforeEach(() => { vi.clearAllMocks(); mocks.url.mockReturnValue({ project: 'p', canvas: 'c' }); mocks.nodes = []; });
describe('story batch generation', () => {
  it('runs only missing prepared clips without overriding node settings or expanding scope', async () => {
    mocks.nodes = [
      node('a', { prompt: 'A', model: 'custom', durationSec: 8, genMode: 'allReference', generateAudio: true }),
      node('b', { prompt: 'B', durationSec: 4, genMode: 'firstFrame' }),
      node('ready', { prompt: 'ready', videoUrl: '/ready.mp4' }),
      node('busy', { prompt: 'busy', isGenerating: true }),
      node('missingPrompt', { narration: 'not a prompt' }),
      node('other', { prompt: 'other' }, 'otherStory'),
    ];
    const before = structuredClone(mocks.nodes);
    mocks.run.mockResolvedValue({ commandResults: [
      { type: 'run_node_action', action: 'generate_video', nodeId: 'a', status: 'success' },
      { type: 'run_node_action', action: 'generate_video', nodeId: 'b', status: 'error' },
    ] });
    expect(await batchGenerateStoryClips('story')).toEqual({ total: 2, succeeded: 1, failed: 1, skipped: 1 });
    expect(mocks.run).toHaveBeenCalledWith([{
      schema_version: 'canvas_chat_commands.v1', project_id: 'p', canvas_id: 'c',
      commands: [{ type: 'run_workflow', node_ids: ['a', 'b'], direction: 'node', regenerate: false }],
    }]);
    expect(mocks.nodes).toEqual(before);
  });
  it('does not treat command acceptance or cancellation as generated media', async () => {
    mocks.nodes = [node('a', { prompt: 'A' })];
    mocks.run.mockResolvedValue({ commandResults: [{ type: 'run_workflow', status: 'success' }] });
    expect(await batchGenerateStoryClips('story')).toMatchObject({ succeeded: 0, failed: 1 });
  });
  it('does not run without a project or eligible clips', async () => {
    mocks.url.mockReturnValue({});
    expect(await batchGenerateStoryClips('story')).toMatchObject({ noProject: true });
    mocks.url.mockReturnValue({ project: 'p' });
    expect(await batchGenerateStoryClips('story')).toEqual({ total: 0, succeeded: 0, failed: 0, skipped: 0 });
    expect(mocks.run).not.toHaveBeenCalled();
  });
});
