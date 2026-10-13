type NodeLike = {
  data?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function hasWorkflowCatalogMarker(node: NodeLike | null | undefined): boolean {
  const data = node?.data;
  if (!isRecord(data)) return false;
  if (isRecord(data.workflowCatalog)) return true;
  return typeof data.workflowCatalogRole === 'string' && data.workflowCatalogRole.trim().length > 0;
}
