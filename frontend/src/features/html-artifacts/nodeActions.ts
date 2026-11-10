import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { readHtmlArtifact } from "./api";
import { executeHtmlArtifactCommand } from "./commands";
import { useCanvasStore } from '@/stores/canvasStore';

export async function executeHtmlNodeWriteAction(options: {
  projectId: string;
  canvasId: string;
  node: CanvasNode;
  action: "update_source" | "restore" | "select_version";
  parameters?: Record<string, unknown>;
}) {
  const { projectId, canvasId, node, action, parameters = {} } = options;
  if (node.type !== CANVAS_NODE_TYPES.htmlArtifact) throw new Error("Node is not an HTML artifact node");
  const data = node.data as {artifactId?: unknown; artifactVersion?: unknown; displayName?: unknown};
  const artifactId = typeof data.artifactId === "string" ? data.artifactId.trim() : "";
  const title = typeof parameters.title === "string" && parameters.title.trim()
    ? parameters.title.trim()
    : typeof data.displayName === "string" && data.displayName.trim()
      ? data.displayName.trim()
      : "HTML";
  if (action === 'select_version') {
    if (!artifactId) throw new Error('HTML node has no saved artifact');
    const selectedVersion = parameters.version;
    if (typeof selectedVersion !== 'number' || !Number.isInteger(selectedVersion) || selectedVersion < 1) {
      throw new Error('A positive version is required for select_version');
    }
    const artifact = await readHtmlArtifact(projectId, artifactId, selectedVersion);
    if (artifact.id !== artifactId || artifact.version !== selectedVersion) {
      throw new Error('HTML version does not belong to this node artifact');
    }
    useCanvasStore.getState().updateNodeData(node.id, {
      artifactId,
      artifactVersion: selectedVersion,
      displayName: artifact.title,
      htmlSelectionToken: `${Date.now()}:${selectedVersion}`,
      generationError: null,
    });
    return {
      createdNodeId: undefined,
      nodeId: node.id,
      output: {
        project_id: projectId,
        node_id: node.id,
        artifact_id: artifactId,
        selected_version: selectedVersion,
        canvas_attached: true,
        warnings: undefined,
      },
    };
  }
  if (action === "update_source") {
    if (typeof parameters.html !== "string" || !parameters.html) throw new Error("HTML source is required");
    if (!artifactId) {
      return executeHtmlArtifactCommand({type: "html_artifact", action: "create", node_id: node.id,
        title, html: parameters.html}, projectId, canvasId);
    }
    if (typeof parameters.base_version !== "number" || !Number.isInteger(parameters.base_version) || parameters.base_version < 1) {
      throw new Error("A positive base_version is required; read_source before updating");
    }
    return executeHtmlArtifactCommand({type: "html_artifact", action: "update", node_id: node.id, artifact_id: artifactId,
      title, html: parameters.html, base_version: parameters.base_version}, projectId, canvasId);
  }
  if (!artifactId) throw new Error("HTML node has no saved artifact");
  if (typeof parameters.version !== "number" || !Number.isInteger(parameters.version) || parameters.version < 1
    || typeof parameters.base_version !== "number" || !Number.isInteger(parameters.base_version) || parameters.base_version < 1) {
    throw new Error("Positive version and base_version are required for restore");
  }
  return executeHtmlArtifactCommand({type: "html_artifact", action: "restore", node_id: node.id, artifact_id: artifactId,
    version: parameters.version, base_version: parameters.base_version}, projectId, canvasId);
}
