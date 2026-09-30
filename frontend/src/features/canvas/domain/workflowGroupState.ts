import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
} from './canvasNodes';
import { hasWorkflowCatalogMarker } from './workflowNodeMarkers';

export type WorkflowGroupRunStatus =
  | 'none'
  | 'not_started'
  | 'running'
  | 'partial'
  | 'completed';

export interface WorkflowGroupState {
  status: WorkflowGroupRunStatus;
  totalCount: number;
  completedCount: number;
  runningCount: number;
  pendingCount: number;
  canContinue: boolean;
  canRegenerate: boolean;
  canStop: boolean;
  primaryLabel: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function hasGeneratedWorkflowResult(node: CanvasNode): boolean {
  const data = isRecord(node.data) ? node.data : {};
  if (data.workflowResultStale === true) return false;
  switch (node.type) {
    case CANVAS_NODE_TYPES.textAnnotation:
      return data.workflowTextGenerated === true && Boolean(nonEmptyString(data.content));
    case CANVAS_NODE_TYPES.script: {
      const scriptResult = isRecord(data.scriptResult) ? data.scriptResult : null;
      return Array.isArray(scriptResult?.rows) && scriptResult.rows.length > 0;
    }
    case CANVAS_NODE_TYPES.imageGen:
      return Boolean(nonEmptyString(data.imageUrl) ?? nonEmptyString(data.image_url));
    case CANVAS_NODE_TYPES.video:
      return Boolean(nonEmptyString(data.videoUrl) ?? nonEmptyString(data.video_url));
    case CANVAS_NODE_TYPES.audio:
      return Boolean(nonEmptyString(data.audioUrl) ?? nonEmptyString(data.audio_url));
    case CANVAS_NODE_TYPES.videoCompose:
      return Boolean(nonEmptyString(data.resultVideoUrl));
    case CANVAS_NODE_TYPES.threeDWorld:
      return Boolean(
        nonEmptyString(data.plyUrl) ??
        (Array.isArray(data.sources) && data.sources.length > 0 ? 'sources' : null),
      );
    default:
      return false;
  }
}

function isWorkflowExecutableNode(node: CanvasNode): boolean {
  if (!hasWorkflowCatalogMarker(node)) return false;
  const data = isRecord(node.data) ? node.data : {};
  if (!isRecord(data.workflowCatalog)) return false;
  return (
    node.type === CANVAS_NODE_TYPES.textAnnotation ||
    node.type === CANVAS_NODE_TYPES.script ||
    node.type === CANVAS_NODE_TYPES.imageGen ||
    node.type === CANVAS_NODE_TYPES.video ||
    node.type === CANVAS_NODE_TYPES.audio ||
    node.type === CANVAS_NODE_TYPES.videoCompose ||
    node.type === CANVAS_NODE_TYPES.threeDWorld
  );
}

function isWorkflowNodeRunning(node: CanvasNode): boolean {
  if (hasGeneratedWorkflowResult(node)) return false;
  const data = isRecord(node.data) ? node.data : {};
  return data.workflowActionRunning === true || data.isGenerating === true;
}

export function workflowGroupState(nodes: CanvasNode[]): WorkflowGroupState {
  const executableNodes = nodes.filter(isWorkflowExecutableNode);
  const totalCount = executableNodes.length;
  if (totalCount === 0) {
    return {
      status: 'none',
      totalCount: 0,
      completedCount: 0,
      runningCount: 0,
      pendingCount: 0,
      canContinue: false,
      canRegenerate: false,
      canStop: false,
      primaryLabel: '',
    };
  }

  const runningCount = executableNodes.filter(isWorkflowNodeRunning).length;
  const completedCount = executableNodes.filter(hasGeneratedWorkflowResult).length;
  const pendingCount = Math.max(totalCount - completedCount, 0);

  if (runningCount > 0) {
    return {
      status: 'running',
      totalCount,
      completedCount,
      runningCount,
      pendingCount,
      canContinue: false,
      canRegenerate: false,
      canStop: true,
      primaryLabel: '运行中',
    };
  }

  if (completedCount === 0) {
    return {
      status: 'not_started',
      totalCount,
      completedCount,
      runningCount,
      pendingCount,
      canContinue: true,
      canRegenerate: false,
      canStop: false,
      primaryLabel: '运行',
    };
  }

  if (completedCount >= totalCount) {
    return {
      status: 'completed',
      totalCount,
      completedCount: totalCount,
      runningCount,
      pendingCount: 0,
      canContinue: false,
      canRegenerate: true,
      canStop: false,
      primaryLabel: '已完成',
    };
  }

  return {
    status: 'partial',
    totalCount,
    completedCount,
    runningCount,
    pendingCount,
    canContinue: true,
    canRegenerate: true,
    canStop: false,
    primaryLabel: '继续运行',
  };
}
