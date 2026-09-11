import { beforeEach, describe, expect, it, vi } from "vitest";
import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { buildCanvasContextRequestResponses } from "@/features/freezone/chatNodeReferences";

const { readHtmlArtifact, listHtmlVersions } = vi.hoisted(() => ({
  readHtmlArtifact: vi.fn(),
  listHtmlVersions: vi.fn(),
}));
const updateNodeData = vi.hoisted(() => vi.fn());

vi.mock("./api", () => ({ readHtmlArtifact, listHtmlVersions }));
vi.mock("@/stores/canvasStore", () => ({
  useCanvasStore: { getState: () => ({ updateNodeData }) },
}));

import { executeHtmlNodeReadAction, executeHtmlNodeWriteAction } from "./nodeActions";

const webpage = (artifactId?: string): CanvasNode => ({
  id: "web-1",
  type: CANVAS_NODE_TYPES.htmlArtifact,
  position: { x: 0, y: 0 },
  data: artifactId ? { artifactId, artifactVersion: 3 } : {},
}) as CanvasNode;

describe("HTML node read actions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads complete source by the artifact identity stored on the node", async () => {
    readHtmlArtifact.mockResolvedValue({
      id: "artifact-1",
      title: "Landing page",
      version: 3,
      html: "<!doctype html><html><body>complete source</body></html>",
    });

    await expect(executeHtmlNodeReadAction({
      projectId: "project-1",
      node: webpage("artifact-1"),
      action: "read_source",
      parameters: { version: 2 },
    })).resolves.toEqual({
      artifact_id: "artifact-1",
      title: "Landing page",
      version: 3,
      html: "<!doctype html><html><body>complete source</body></html>",
    });
    expect(readHtmlArtifact).toHaveBeenCalledWith("project-1", "artifact-1", 2);
  });

  it("lists versions without source bodies", async () => {
    listHtmlVersions.mockResolvedValue({ versions: [{ version: 3, title: "Page", created_at: "now" }] });

    await expect(executeHtmlNodeReadAction({
      projectId: "project-1",
      node: webpage("artifact-1"),
      action: "history",
    })).resolves.toEqual({
      artifact_id: "artifact-1",
      current_version: 3,
      versions: [{ version: 3, title: "Page", created_at: "now" }],
    });
  });

  it("rejects empty nodes and write actions", async () => {
    await expect(executeHtmlNodeReadAction({projectId: "project-1", node: webpage(), action: "read_source"}))
      .rejects.toThrow("HTML node has no saved artifact");
    await expect(executeHtmlNodeReadAction({projectId: "project-1", node: webpage("artifact-1"), action: "update_source" as "read_source"}))
      .rejects.toThrow("Unsupported HTML read action");
  });

  it("returns source through the read-only canvas context bridge", async () => {
    readHtmlArtifact.mockResolvedValue({
      id: "artifact-1",
      title: "Landing page",
      version: 3,
      html: "<!doctype html><html><body>full source</body></html>",
    });

    const responses = await buildCanvasContextRequestResponses({
      project: "project-1",
      canvasId: "canvas-1",
      nodes: [webpage("artifact-1")],
      edges: [],
      ontologyContext: null,
      envelopes: [{
        schema_version: "canvas_context_request.v1",
        requests: [{
          type: "node_action_read",
          node_id: "web-1",
          action: "read_source",
          parameters: {},
        }],
      }],
    });

    expect(responses?.[0]).toMatchObject({
      type: "node_action_read",
      node_id: "web-1",
      action: "read_source",
      data: {artifact_id: "artifact-1", version: 3, html: expect.stringContaining("full source")},
    });
  });
});

describe("HTML node version selection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("verifies the requested Artifact revision and only changes this node reference", async () => {
    readHtmlArtifact.mockResolvedValue({
      id: "artifact-1",
      title: "Old landing page",
      version: 1,
      html: "<html>old</html>",
    });

    const result = await executeHtmlNodeWriteAction({
      projectId: "project-1",
      canvasId: "canvas-1",
      node: webpage("artifact-1"),
      action: "select_version",
      parameters: {version: 1},
    });

    expect(readHtmlArtifact).toHaveBeenCalledWith("project-1", "artifact-1", 1);
    expect(updateNodeData).toHaveBeenCalledWith("web-1", expect.objectContaining({
      artifactId: "artifact-1",
      artifactVersion: 1,
      displayName: "Old landing page",
    }));
    expect(result.output).toMatchObject({
      node_id: "web-1",
      artifact_id: "artifact-1",
      selected_version: 1,
    });
  });
});
