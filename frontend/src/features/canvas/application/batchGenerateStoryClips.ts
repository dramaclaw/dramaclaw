import { useCanvasStore } from '@/stores/canvasStore';
import { readUrl } from '@/lib/url-params';
import { applyCanvasChatCommandsAsync } from '@/features/freezone/canvasChatCommands';
import { collectMissingStoryClips } from '@/features/canvas/story/batchClipPlan';

export interface BatchGenSummary {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  noProject?: boolean;
}

/** Reuse node generation and dependency scheduling without overriding production settings. */
export async function batchGenerateStoryClips(groupId: string): Promise<BatchGenSummary> {
  const { project: projectId, canvas: canvasId } = readUrl();
  const { generable, skipped } = collectMissingStoryClips(useCanvasStore.getState().nodes, groupId);
  const summary = { total: generable.length, succeeded: 0, failed: 0, skipped: skipped.length };
  if (!projectId) return { ...summary, noProject: true };
  if (generable.length === 0) return summary;

  const result = await applyCanvasChatCommandsAsync([{
    schema_version: 'canvas_chat_commands.v1',
    project_id: projectId,
    canvas_id: canvasId ?? 'default',
    commands: [{
      type: 'run_workflow',
      node_ids: generable.map(({ id }) => id),
      direction: 'node',
      regenerate: false,
    }],
  }]);
  const completed = new Set(result.commandResults
    .filter((step) => step.type === 'run_node_action' && step.action === 'generate_video' && step.status === 'success')
    .map((step) => step.nodeId));
  const succeeded = generable.filter(({ id }) => completed.has(id)).length;
  // Cancelled/blocked/validation-failed nodes must not be reported as generated.
  return { ...summary, succeeded, failed: generable.length - succeeded };
}
