// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
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

