import { describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES, type CanvasNodeType } from "@/features/canvas/domain/canvasNodes";
import {
  buildCanvasContextRequestResponse,
  extractCanvasContextRequestEnvelopes,
} from "@/features/freezone/chatNodeReferences";

vi.mock("@/features/canvas/hooks/useFreezoneVideoModels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/canvas/hooks/useFreezoneVideoModels")>()),
  getFreezoneVideoModelsSnapshot: () => ({
    models: [{
      id: "minimax-h3",
      label: "MiniMax H3",
      providerId: "newapi",
      apiModel: "minimax-h3",
      resolutionOptions: ["768p", "2k"],
      ratioOptions: ["16:9"],
      minDuration: 6,
      maxDuration: 10,
    }],
    isLoading: false,
    isFallback: false,
    error: null,
  }),
}));

vi.mock("@/features/canvas/hooks/useFreezoneImageModels", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/canvas/hooks/useFreezoneImageModels")>()),
  getFreezoneImageModelsSnapshot: () => ({
    models: [{
      id: "image-no-quality",
      label: "Image model without quality",
      providerId: "newapi",
      apiModel: "image-no-quality",
      resolutionOptions: ["1K", "2K"],
      ratioOptions: ["16:9"],
      qualityOptions: [],
    }],
    isLoading: false,
    isFallback: false,
    error: null,
  }),
}));

async function createSchema(modelId?: string, nodeType: CanvasNodeType = CANVAS_NODE_TYPES.video) {
  const envelopes = extractCanvasContextRequestEnvelopes([{
    schema_version: "canvas_context_request.v1",
    requests: [{
      type: "node_create_schema",
      node_type: nodeType,
      ...(modelId ? { model_id: modelId } : {}),
    }],
  }]);
  const response = await buildCanvasContextRequestResponse({
    project: "project-a",
    canvasId: "canvas-a",
    nodes: [],
    edges: [],
    ontologyContext: null,
    selectedNodeIds: [],
    envelopes,
  });
  const payload = JSON.parse(response?.split("\n")[2] ?? "{}") as {
    responses: Array<{ data: Record<string, unknown> }>;
  };
  return payload.responses[0].data;
}

describe("model-scoped node create schema", () => {
  it("returns the selected model's exact video options", async () => {
    const schema = await createSchema("minimax-h3");
    const fields = schema.create_schema as Record<string, { options?: string[]; description?: string }>;

    expect(schema.model_id).toBe("minimax-h3");
    expect(schema.model_found).toBe(true);
    expect(fields.quality.options).toEqual(["768p", "2k"]);
    expect(fields.aspectRatio.options).toEqual(["16:9"]);
    expect(fields.durationSec.description).toContain("6-10");
  });

  it("does not present generic options for an unknown selected model", async () => {
    const schema = await createSchema("unknown-model");

    expect(schema.model_found).toBe(false);
    expect(schema.create_schema).toBeUndefined();
    expect(schema.available_model_ids).toEqual(["minimax-h3"]);
  });

  it("omits quality choices for an image model without quality support", async () => {
    const schema = await createSchema("image-no-quality", CANVAS_NODE_TYPES.imageGen);
    const fields = schema.create_schema as Record<string, { options?: string[] }>;

    expect(fields.size.options).toEqual(["1K", "2K"]);
    expect(fields.aspectRatio.options).toEqual(["16:9"]);
    expect(fields.quality.options).toEqual([]);
  });
});
