import { beforeEach, describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES, type CanvasNodeType } from "@/features/canvas/domain/canvasNodes";
import {
  buildCanvasContextRequestResponse,
  extractCanvasContextRequestEnvelopes,
} from "@/features/freezone/chatNodeReferences";

const catalogState = vi.hoisted(() => ({
  video: { isLoading: false, isFallback: false },
  image: { isLoading: false, isFallback: false },
}));

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
    ...catalogState.video,
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
    ...catalogState.image,
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
  beforeEach(() => {
    catalogState.video = { isLoading: false, isFallback: false };
    catalogState.image = { isLoading: false, isFallback: false };
  });

  it("returns the selected model's exact video options", async () => {
    const schema = await createSchema("minimax-h3");
    const fields = schema.create_schema as Record<string, { options?: string[]; description?: string }>;

    expect(schema.model_id).toBe("minimax-h3");
    expect(schema.model_found).toBe(true);
    expect(schema.catalog_ready).toBe(true);
    expect(fields.quality.options).toEqual(["768p", "2k"]);
    expect(fields.aspectRatio.options).toEqual(["16:9"]);
    expect(fields.durationSec.description).toContain("6-10");
  });

  it("does not present generic options for an unknown selected model", async () => {
    const schema = await createSchema("unknown-model");

    expect(schema.model_found).toBe(false);
    expect(schema.catalog_ready).toBe(true);
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

  it.each([
    [CANVAS_NODE_TYPES.video, "minimax-h3", "video"],
    [CANVAS_NODE_TYPES.imageGen, "image-no-quality", "image"],
  ] as const)(
    "does not confirm fallback %s model options while loading",
    async (nodeType, modelId, catalog) => {
      catalogState[catalog] = { isLoading: true, isFallback: true };
      const schema = await createSchema(modelId, nodeType);

      expect(schema.model_found).toBeNull();
      expect(schema.catalog_ready).toBe(false);
      expect(schema.loading).toBe(true);
      expect(schema.fallback).toBe(true);
      expect(schema.create_schema).toBeUndefined();
      expect(schema.available_model_ids).toBeUndefined();
      expect(schema.instruction).toContain("request node_create_schema again");
    },
  );

  it("does not confirm cached video options during a live catalog refresh", async () => {
    catalogState.video = { isLoading: true, isFallback: false };
    const schema = await createSchema("minimax-h3");

    expect(schema.model_found).toBeNull();
    expect(schema.catalog_ready).toBe(false);
    expect(schema.create_schema).toBeUndefined();
  });

  it("does not offer fallback ids while the selected model is not yet loaded", async () => {
    catalogState.video = { isLoading: true, isFallback: true };
    const pending = await createSchema("unknown-model");

    expect(pending.model_found).toBeNull();
    expect(pending.available_model_ids).toBeUndefined();

    catalogState.video = { isLoading: false, isFallback: false };
    const loaded = await createSchema("unknown-model");
    expect(loaded.model_found).toBe(false);
    expect(loaded.available_model_ids).toEqual(["minimax-h3"]);
  });

  it("returns exact model options after the live catalog finishes loading", async () => {
    catalogState.video = { isLoading: true, isFallback: true };
    expect((await createSchema("minimax-h3")).create_schema).toBeUndefined();

    catalogState.video = { isLoading: false, isFallback: false };
    const loaded = await createSchema("minimax-h3");
    expect(loaded.model_found).toBe(true);
    expect(loaded.catalog_ready).toBe(true);
    expect((loaded.create_schema as Record<string, { options?: string[] }>).quality.options)
      .toEqual(["768p", "2k"]);
  });

  it.each([
    [CANVAS_NODE_TYPES.video, "minimax-h3", "video"],
    [CANVAS_NODE_TYPES.imageGen, "image-no-quality", "image"],
  ] as const)(
    "does not confirm %s fallback options after catalog failure",
    async (nodeType, modelId, catalog) => {
      catalogState[catalog] = { isLoading: false, isFallback: true };
      const schema = await createSchema(modelId, nodeType);

      expect(schema.model_found).toBeNull();
      expect(schema.catalog_ready).toBe(false);
      expect(schema.loading).toBe(false);
      expect(schema.create_schema).toBeUndefined();
      expect(schema.instruction).toContain("refresh the model catalog");
    },
  );
});
