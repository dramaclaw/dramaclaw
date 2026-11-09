import { beforeEach, expect, it, vi } from 'vitest';
import { runManualVideoRecipe } from './manualVideoRecipe';
import { bindWorkflowProductOperation, clearWorkflowProductOperation } from './workflowExecutionActivity';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/features/freezone/canvasChatCommands', () => ({ applyCanvasChatCommandsAsync: execute }));

const input = {
  nodeId: 'video', projectId: 'project', canvasId: 'canvas',
  nodeData: { workflowCatalog: { recipeId: 'video-recipe' } },
  executionSource: 'manual' as const,
};

beforeEach(() => {
  execute.mockReset();
  execute.mockResolvedValue({ errors: [] });
  clearWorkflowProductOperation('video');
});

it('admits first manual generation through the durable single-node executor', async () => {
  await runManualVideoRecipe(input);
  expect(execute).toHaveBeenCalledExactlyOnceWith([{
    schema_version: 'canvas_chat_commands.v1', project_id: 'project', canvas_id: 'canvas',
    commands: [{ type: 'run_workflow', node_ids: ['video'], direction: 'node' }],
  }], { projectId: 'project', canvasId: 'canvas' });
});

it('does not recursively delegate workflow actions, including unmetered CE actions', () => {
  expect(runManualVideoRecipe({ ...input, executionSource: 'workflow' })).toBeNull();
  expect(execute).not.toHaveBeenCalled();
});

it('keeps an existing workflow admission without another execution or charge', () => {
  bindWorkflowProductOperation('video', { projectId: 'project', operationId: 'operation' });
  expect(runManualVideoRecipe(input)).toBeNull();
  expect(execute).not.toHaveBeenCalled();
});

it.each([
  { workflowRecipeCompiledPrompt: 'compiled' },
  { videoUrl: '/existing-video' },
  { resultVideoUrl: '/existing-result' },
])('keeps a completed manual node on the prompt reuse path: %j', (saved) => {
  expect(runManualVideoRecipe({ ...input, nodeData: { ...input.nodeData, ...saved } })).toBeNull();
  expect(execute).not.toHaveBeenCalled();
});

it('leaves ordinary video nodes on their existing model billing path', () => {
  expect(runManualVideoRecipe({ ...input, nodeData: { prompt: 'ordinary video' } })).toBeNull();
  expect(execute).not.toHaveBeenCalled();
});

it('deduplicates rapid clicks from the canvas and detail forms', async () => {
  let release!: (result: { errors: string[] }) => void;
  execute.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const first = runManualVideoRecipe(input);
  const second = runManualVideoRecipe(input);
  expect(first).toBe(second);
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
  bindWorkflowProductOperation('video', { projectId: 'project', operationId: 'admitted' });
  expect(runManualVideoRecipe(input)).toBe(first);
  release({ errors: [] });
  await first;
  clearWorkflowProductOperation('video');
  await runManualVideoRecipe(input);
  expect(execute).toHaveBeenCalledTimes(2);
});

it('surfaces admission errors and allows a fresh attempt after failure', async () => {
  execute.mockResolvedValueOnce({ errors: ['计费规则未配置'] });
  await expect(runManualVideoRecipe(input)).rejects.toThrow('计费规则未配置');
  await runManualVideoRecipe(input);
  expect(execute).toHaveBeenCalledTimes(2);
});
