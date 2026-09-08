import {captureFreezoneCanvasScope} from '@/features/freezone/canvasSyncRuntime';
import { createHtmlArtifact, saveHtmlArtifact, restoreHtmlVersion, announceHtmlArtifact, recordHtmlNodeHistory } from './api';
import { useCanvasStore } from '@/stores/canvasStore';
import { nodeHasSourceHandle } from '@/features/canvas/domain/nodeRegistry';

export type HtmlArtifactCommand = {
  type: 'html_artifact';
  action: 'create' | 'update' | 'restore';
  artifact_id?: string;
  title?: string;
  html?: string;
  base_version?: number;
  version?: number;
  position?: {x:number;y:number};
  reference_node_ids?: string[];
};

export function htmlArtifactCommandError(command: HtmlArtifactCommand): string | null {
  if (!['create','update','restore'].includes(command.action)) return 'Invalid HTML artifact action';
  if (command.action !== 'create' && (!command.artifact_id || !Number.isInteger(command.base_version) || (command.base_version ?? 0) < 1)) return 'artifact_id and positive base_version are required; read the saved source first';
  if (command.action === 'restore' && (!Number.isInteger(command.version) || (command.version ?? 0) < 1)) return 'A positive restore version is required';
  if (command.action !== 'restore' && (typeof command.title !== 'string' || !command.title.trim() || command.title.length > 200 || typeof command.html !== 'string' || !command.html || new TextEncoder().encode(command.html).length > 2 * 1024 * 1024)) return 'HTML and title are required (title max 200, HTML max 2 MiB)';
  if (command.position && (!Number.isFinite(command.position.x) || !Number.isFinite(command.position.y))) return 'Invalid position';
  if (command.reference_node_ids !== undefined && (!Array.isArray(command.reference_node_ids) || command.reference_node_ids.some(id => typeof id !== 'string' || !id))) return 'reference_node_ids must be node IDs';
  return null;
}

export function parseHtmlArtifactCommand(value: Record<string, unknown>): HtmlArtifactCommand | null {
  const command = Object.fromEntries(Object.entries(value).filter(([key]) => ['type','action','artifact_id','title','html','base_version','version','position','reference_node_ids'].includes(key))) as HtmlArtifactCommand;
  return htmlArtifactCommandError(command) ? null : command;
}

export async function executeHtmlArtifactCommand(command: HtmlArtifactCommand, projectId: string, canvasId: string) {
  const error = htmlArtifactCommandError(command);
  if (error) throw new Error(error);
  const scopeIsCurrent = captureFreezoneCanvasScope(projectId,canvasId);
  if (!scopeIsCurrent()) throw new Error("HTML artifact canvas is no longer active");
  const references = [...new Set(command.reference_node_ids ?? [])];
  for (const id of references) {
    const node = useCanvasStore.getState().nodes.find(node => node.id === id);
    if (!node || !nodeHasSourceHandle(node.type)) throw new Error(`HTML reference node is unavailable: ${id}`);
  }
  const artifact = command.action === 'create'
    ? await createHtmlArtifact(projectId, command.title!, command.html!)
    : command.action === 'update'
      ? await saveHtmlArtifact(projectId, command.artifact_id!, command.title!, command.html!, command.base_version!)
      : await restoreHtmlVersion(projectId, command.artifact_id!, command.version!, command.base_version!);
  const output = {project_id:projectId,html_artifact:{id:artifact.id,title:artifact.title,version:artifact.version}};
  if (!scopeIsCurrent()) return {createdNodeId:undefined,nodeId:undefined,output:{...output,canvas_attached:false,warnings:['HTML was saved, but the canvas changed before its node could be attached or refreshed. Open the saved artifact; do not create a duplicate.']}};
  const store = useCanvasStore.getState();
  const existing = store.nodes.filter(node => node.type === 'htmlArtifactNode' && node.data.artifactId === artifact.id);
  const data = {artifactId:artifact.id,artifactVersion:artifact.version,displayName:artifact.title};
  let createdNodeId: string | undefined;
  if (command.action === 'create') {
    createdNodeId = store.addNode('htmlArtifactNode',command.position ?? {x:100,y:100},data);
  } else {
    for (const node of existing) store.updateNodeData(node.id,data);
  }
  const nodeId = createdNodeId ?? existing[0]?.id;
  const missingReferences: string[] = [];
  if (nodeId) for (const source of references) {
    if (!useCanvasStore.getState().addEdgeWithData(source,nodeId,{edgeKind:'data',link_type:'derived_from'})) missingReferences.push(source);
  }
  const historyWarnings = [...(artifact.warnings ?? [])];
  for (const targetId of createdNodeId ? [createdNodeId] : existing.map(node => node.id)) {
    try {
      const recorded = await recordHtmlNodeHistory(projectId,artifact.id,artifact.version,{canvas_id:canvasId,node_id:targetId});
      historyWarnings.push(...(recorded.warnings ?? []));
    } catch {
      historyWarnings.push('网页已保存，但节点历史记录失败，请稍后重试。');
    }
  }
  announceHtmlArtifact(projectId,artifact,nodeId);
  // Persist identity and revision, never a duplicate source document in chat.
  return {createdNodeId,nodeId,output:{...output,canvas_attached:Boolean(nodeId),...((missingReferences.length || historyWarnings.length) ? {warnings:[...historyWarnings,...(missingReferences.length ? [`Saved HTML, but could not link reference nodes: ${missingReferences.join(', ')}`] : [])]} : {})}};
}
