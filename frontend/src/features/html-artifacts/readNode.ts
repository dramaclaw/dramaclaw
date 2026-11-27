// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import type { readHtmlArtifact, listHtmlVersions } from "./api";

export type HtmlNodeReadPorts = {
  readHtmlArtifact: (...args: Parameters<typeof readHtmlArtifact>) => Promise<Pick<Awaited<ReturnType<typeof readHtmlArtifact>>, 'id' | 'title' | 'version' | 'html'>>;
  listHtmlVersions: (...args: Parameters<typeof listHtmlVersions>) => Promise<{ versions: unknown }>;
};

export type HtmlNodeReadAction = "read_source" | "history";

export type ExecuteHtmlNodeReadActionOptions = {
  projectId: string;
  node: CanvasNode;
  action: HtmlNodeReadAction;
  parameters?: Record<string, unknown>;
  ports: HtmlNodeReadPorts;
};

function artifactIdentity(node: CanvasNode): { artifactId: string; version: number | null } {
  if (node.type !== CANVAS_NODE_TYPES.htmlArtifact) {
    throw new Error("Node is not an HTML artifact node");
  }
  const data = node.data as { artifactId?: unknown; artifactVersion?: unknown };
  const artifactId = typeof data.artifactId === "string" ? data.artifactId.trim() : "";
  if (!artifactId) throw new Error("HTML node has no saved artifact");
  return {
    artifactId,
    version:
      typeof data.artifactVersion === "number" && Number.isInteger(data.artifactVersion)
        ? data.artifactVersion
        : null,
  };
}

export async function executeHtmlNodeReadAction({
  projectId,
  node,
  action,
  parameters = {},
  ports,
}: ExecuteHtmlNodeReadActionOptions): Promise<Record<string, unknown>> {
  const { artifactId, version: currentVersion } = artifactIdentity(node);
  if (action === "read_source") {
    const requestedVersion = parameters.version;
    if (
      requestedVersion !== undefined &&
      (typeof requestedVersion !== "number" || !Number.isInteger(requestedVersion) || requestedVersion < 1)
    ) {
      throw new Error("HTML source version must be a positive integer");
    }
    const artifact = await ports.readHtmlArtifact(projectId, artifactId, requestedVersion as number | undefined);
    return {
      artifact_id: artifact.id,
      title: artifact.title,
      version: artifact.version,
      html: artifact.html,
    };
  }
  if (action === "history") {
    const result = await ports.listHtmlVersions(projectId, artifactId);
    return {
      artifact_id: artifactId,
      current_version: currentVersion,
      versions: result.versions,
    };
  }
  throw new Error(`Unsupported HTML read action: ${String(action)}`);
}

