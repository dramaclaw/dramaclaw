import { describe, expect, it } from "vitest";

import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { buildCanvasNodeReferenceAttachment } from "@/features/freezone/chatNodeReferences";

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const JPEG_DATA_URL = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
const REFERENCE_URL = "/static/projects/p/freezone/_uploads/ref.png?v=2";

function uploadNode(id: string, data: Record<string, unknown>): CanvasNode {
  return { id, type: CANVAS_NODE_TYPES.upload, position: { x: 0, y: 0 }, data } as CanvasNode;
}

function referencedAddresses(nodes: CanvasNode[]) {
  const attachment = buildCanvasNodeReferenceAttachment("p", "c", nodes);
  const payload = JSON.parse(attachment?.content ?? "{}") as {
    nodes: Array<{ node_id: string; source_url: string | null; preview_url: string | null }>;
  };
  return {
    content: attachment?.content ?? "",
    nodes: payload.nodes.map(({ node_id, source_url, preview_url }) => ({
      node_id,
      source_url,
      preview_url,
    })),
  };
}

describe("canvas node reference addresses", () => {
  it("skips inline data URLs and keeps the node's file address", () => {
    const { content, nodes } = referencedAddresses([
      uploadNode("n1", {
        imageUrl: PNG_DATA_URL,
        previewImageUrl: JPEG_DATA_URL,
        referenceImageUrl: REFERENCE_URL,
      }),
    ]);

    expect(nodes).toEqual([{ node_id: "n1", source_url: REFERENCE_URL, preview_url: REFERENCE_URL }]);
    expect(content).not.toContain(";base64,");
  });

  it("references a node whose only media is inline data by id alone", () => {
    const { content, nodes } = referencedAddresses([
      uploadNode("n2", { imageUrl: PNG_DATA_URL, previewImageUrl: ` ${JPEG_DATA_URL}` }),
    ]);

    expect(nodes).toEqual([{ node_id: "n2", source_url: null, preview_url: null }]);
    expect(content).not.toContain(";base64,");
  });
});
