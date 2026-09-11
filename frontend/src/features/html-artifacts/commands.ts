import i18n from "i18next";
import {captureFreezoneCanvasScope} from '@/features/freezone/canvasSyncRuntime';
import { createHtmlArtifact, saveHtmlArtifact, restoreHtmlVersion, announceHtmlArtifact, recordHtmlNodeHistory } from './api';
import { useCanvasStore } from '@/stores/canvasStore';
import { nodeHasSourceHandle } from '@/features/canvas/domain/nodeRegistry';

export type HtmlArtifactCommand = {
  type: 'html_artifact';
  action: 'create' | 'update' | 'restore' | 'prepare';
  workflow_data?: {prompt: string; displayName?: string; title?: string; workflowCatalog: Record<string,unknown>; workflowInstanceId: string; workflowPlanNodeId: string};
  client_id?: string;
  node_id?: string;
  artifact_id?: string;
  title?: string;
  html?: string;
  base_version?: number;
  version?: number;
  position?: {x:number;y:number};
  reference_node_ids?: string[];
};

export function htmlArtifactCommandError(command: HtmlArtifactCommand): string | null {
  if (command.action === 'prepare') {
    const data = command.workflow_data;
    if (typeof command.client_id !== 'string' || !command.client_id.trim() || !data || typeof data !== 'object' || Array.isArray(data)) return 'HTML prepare requires client_id and workflow_data';
    const allowed = ['prompt','displayName','title','workflowCatalog','workflowInstanceId','workflowPlanNodeId'];
    if (Object.entries(data).some(([key,value]) => !allowed.includes(key) || (key !== 'workflowCatalog' && typeof value !== 'string'))) return 'Invalid HTML workflow_data';
    if ([data.prompt,data.workflowInstanceId,data.workflowPlanNodeId].some(value => typeof value !== 'string' || !value.trim())) return 'HTML prepare requires prompt and workflow identity';
    if (!data.workflowCatalog || typeof data.workflowCatalog !== 'object' || Array.isArray(data.workflowCatalog) || typeof data.workflowCatalog.recipeId !== 'string' || !data.workflowCatalog.recipeId.trim()) return 'HTML prepare requires a workflow recipe';
    if (command.html !== undefined || command.artifact_id !== undefined || command.base_version !== undefined || command.version !== undefined || command.reference_node_ids !== undefined || command.title !== undefined) return 'HTML prepare cannot contain saved source or artifact identity';
    if (command.position && (!Number.isFinite(command.position.x) || !Number.isFinite(command.position.y))) return 'Invalid position';
    return null;
  }
  if (command.workflow_data !== undefined) return 'workflow_data is only supported on prepare';
  if (command.client_id !== undefined && (command.action !== 'create' || typeof command.client_id !== 'string' || !command.client_id.trim())) return 'client_id must be a nonempty string and is only supported on create';
  if (command.node_id !== undefined && (typeof command.node_id !== 'string' || !command.node_id.trim())) return 'node_id must be a nonempty string';
  if (!['create','update','restore'].includes(command.action)) return 'Invalid HTML artifact action';
  if (command.action !== 'create' && (!command.artifact_id || !Number.isInteger(command.base_version) || (command.base_version ?? 0) < 1)) return 'artifact_id and positive base_version are required; read the saved source first';
  if (command.action === 'restore' && (!Number.isInteger(command.version) || (command.version ?? 0) < 1)) return 'A positive restore version is required';
  if (command.action !== 'restore' && (typeof command.title !== 'string' || !command.title.trim() || command.title.length > 200 || typeof command.html !== 'string' || !command.html || new TextEncoder().encode(command.html).length > 2 * 1024 * 1024)) return 'HTML and title are required (title max 200, HTML max 2 MiB)';
  if (command.position && (!Number.isFinite(command.position.x) || !Number.isFinite(command.position.y))) return 'Invalid position';
  if (command.reference_node_ids !== undefined && (!Array.isArray(command.reference_node_ids) || command.reference_node_ids.some(id => typeof id !== 'string' || !id))) return 'reference_node_ids must be node IDs';
  return null;
}

export function parseHtmlArtifactCommand(value: Record<string, unknown>): HtmlArtifactCommand | null {
  const command = Object.fromEntries(Object.entries(value).filter(([key]) => ['type','action','client_id','node_id','artifact_id','title','html','base_version','version','position','reference_node_ids','workflow_data'].includes(key))) as HtmlArtifactCommand;
  return htmlArtifactCommandError(command) ? null : command;
}

export async function executeHtmlArtifactCommand(command: HtmlArtifactCommand, projectId: string, canvasId: string) {
  const error = htmlArtifactCommandError(command);
  if (error) throw new Error(error);
  const scopeIsCurrent = captureFreezoneCanvasScope(projectId,canvasId);
  if (!scopeIsCurrent()) throw new Error("HTML artifact canvas is no longer active");
  if (command.action === 'prepare') {
    const store = useCanvasStore.getState();
    const data = command.workflow_data!;
    const existing = store.nodes.find(node => node.type === 'htmlArtifactNode' && node.data.workflowInstanceId === data.workflowInstanceId && node.data.workflowPlanNodeId === data.workflowPlanNodeId);
    const nodeId = existing?.id ?? store.addNode('htmlArtifactNode',command.position ?? {x:100,y:100},data);
    return {createdNodeId:existing ? undefined : nodeId,nodeId,output:{project_id:projectId,prepared:true,canvas_attached:true,warnings:undefined}};
  }
  const references = [...new Set(command.reference_node_ids ?? [])];
  const targetNode = command.node_id
    ? useCanvasStore.getState().nodes.find(node => node.id === command.node_id)
    : undefined;
  if (command.node_id && (!targetNode || targetNode.type !== 'htmlArtifactNode')) {
    throw new Error(`HTML target node is unavailable: ${command.node_id}`);
  }
  if (command.action === 'create' && targetNode && typeof targetNode.data.artifactId === 'string' && targetNode.data.artifactId.trim()) {
    throw new Error('HTML target node already has a saved artifact; use update_source with base_version');
  }
  if (command.action !== 'create' && targetNode && targetNode.data.artifactId !== command.artifact_id) {
    throw new Error('HTML target node does not reference the requested artifact');
  }
  for (const id of references) {
    const node = useCanvasStore.getState().nodes.find(node => node.id === id);
    if (!node || !nodeHasSourceHandle(node.type)) throw new Error(`HTML reference node is unavailable: ${id}`);
  }
  const artifact = command.action === 'create'
    ? await createHtmlArtifact(projectId, command.title!, command.html!, command.node_id ? `html-node:${canvasId}:${command.node_id}` : undefined)
    : command.action === 'update'
      ? await saveHtmlArtifact(projectId, command.artifact_id!, command.title!, command.html!, command.base_version!)
      : await restoreHtmlVersion(projectId, command.artifact_id!, command.version!, command.base_version!);
  const output = {project_id:projectId,html_artifact:{id:artifact.id,title:artifact.title,version:artifact.version}};
  if (!scopeIsCurrent()) return {createdNodeId:undefined,nodeId:undefined,output:{...output,canvas_attached:false,warnings:['HTML was saved, but the canvas changed before its node could be attached or refreshed. Open the saved artifact; do not create a duplicate.']}};
  let createdNodeId: string | undefined;
  let nodeId: string | undefined;
  try {
    const store = useCanvasStore.getState();
    const existing = store.nodes.filter(node => node.type === 'htmlArtifactNode' && node.data.artifactId === artifact.id);
    const affected = targetNode ? [targetNode] : existing;
    const data = {artifactId:artifact.id,artifactVersion:artifact.version,displayName:artifact.title};
    if (command.action === 'create') {
      if (targetNode) {
        store.updateNodeData(targetNode.id,data);
        nodeId = targetNode.id;
      } else {
        createdNodeId = store.addNode('htmlArtifactNode',command.position ?? {x:100,y:100},data);
      }
    } else {
      for (const node of affected) store.updateNodeData(node.id,data);
    }
    nodeId = nodeId ?? createdNodeId ?? existing[0]?.id;
    const missingReferences: string[] = [];
    if (nodeId) for (const source of references) {
      if (!useCanvasStore.getState().addEdgeWithData(source,nodeId,{edgeKind:'data',link_type:'derived_from'})) missingReferences.push(source);
    }
    const historyWarnings = [...(artifact.warnings ?? [])];
    for (const targetId of nodeId && command.action === 'create' ? [nodeId] : affected.map(node => node.id)) {
      try {
        const recorded = await recordHtmlNodeHistory(projectId,artifact.id,artifact.version,{canvas_id:canvasId,node_id:targetId});
        historyWarnings.push(...(recorded.warnings ?? []));
      } catch {
        historyWarnings.push(i18n.t('htmlArtifact.historyRecordFailed'));
      }
    }
    announceHtmlArtifact(projectId,artifact,nodeId);
    // Persist identity and revision, never a duplicate source document in chat.
    return {createdNodeId,nodeId,output:{...output,canvas_attached:Boolean(nodeId),...((missingReferences.length || historyWarnings.length) ? {warnings:[...historyWarnings,...(missingReferences.length ? [`Saved HTML, but could not link reference nodes: ${missingReferences.join(', ')}`] : [])]} : {})}};
  } catch {
    // Persistence has already succeeded. Preserve its identity even when local
    // attachment/refresh fails, so callers can recover without another create.
    return {createdNodeId,nodeId,output:{...output,canvas_attached:Boolean(nodeId),warnings:[...(artifact.warnings ?? []),'HTML was saved, but its canvas attachment or refresh failed. Open the saved artifact; do not create a duplicate.']}};
  }

}
