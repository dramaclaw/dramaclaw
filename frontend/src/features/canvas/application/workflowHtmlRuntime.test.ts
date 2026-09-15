import { beforeEach, expect, it, vi } from "vitest";
import { executeWorkflowHtmlNode } from "./workflowHtmlRuntime";
const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  submitText: vi.fn(),
  awaitTask: vi.fn(),
  fetchText: vi.fn(),
  create: vi.fn(),
  save: vi.fn(),
  lookup: vi.fn(),
  state: { nodes: [] as any[], edges: [] as any[], updateNodeData: vi.fn() },
}));
vi.mock("./workflowRecipeRuntime", () => ({
  generateWorkflowText: mocks.generate,
}));
vi.mock("@/api/ops", () => ({
  submitFreezoneTextGenerate: mocks.submitText,
  fetchFreezoneTextGenerateResult: mocks.fetchText,
}));
vi.mock("@/api/tasks", () => ({
  awaitTaskCompletion: mocks.awaitTask,
  isTaskPollTimeoutError: () => false,
}));
vi.mock("@/features/html-artifacts/api", () => ({
  createHtmlArtifact: mocks.create,
  findHtmlArtifactCreation: mocks.lookup,
  saveHtmlArtifact: mocks.save,
  recordHtmlNodeHistory: vi.fn(),
  announceHtmlArtifact: vi.fn(),
}));
vi.mock("@/features/freezone/canvasSyncRuntime", () => ({
  captureFreezoneCanvasScope: () => () => true,
}));
vi.mock("@/stores/canvasStore", () => ({
  useCanvasStore: { getState: () => mocks.state },
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.updateNodeData.mockReset();
  mocks.state.updateNodeData.mockImplementation((nodeId: string, patch: Record<string, unknown>) => {
    const node = mocks.state.nodes.find((item) => item.id === nodeId);
    if (node) node.data = {...node.data, ...patch};
  });
  mocks.lookup.mockResolvedValue({ artifact: null });
  mocks.submitText.mockResolvedValue({
    task_key: "user:p:freezone_text_generate:job",
    task_type: "freezone_text_generate",
    job_id: "job",
  });
  mocks.awaitTask.mockResolvedValue(undefined);
  mocks.fetchText.mockResolvedValue({
    generated_text: "<!doctype html><html><body>ok</body></html>",
    model: "writer",
  });
  mocks.state.nodes = [
    {
      id: "page",
      type: "htmlArtifactNode",
      data: { prompt: "Page", workflowCatalog: { recipeId: "text" } },
    },
    {
      id: "image",
      type: "imageGenNode",
      data: { imageUrl: "/api/v1/projects/p/media/image.png" },
    },
  ];
  mocks.state.edges = [
    { source: "image", target: "page", data: { link_type: "media_input_for" } },
  ];
  mocks.generate.mockResolvedValue(
    "<!doctype html><html><body>ok</body></html>",
  );
  mocks.create.mockResolvedValue({ id: "artifact", version: 1, title: "Page" });
});
it("uses actual media and saves source independently from node data", async () => {
  const result = await executeWorkflowHtmlNode("page", "p", "c");
  expect(mocks.generate.mock.calls[0][0].requiredOutputContext).toContain(
    "/api/v1/projects/p/media/image.png",
  );
  expect(result.artifact_id).toBe("artifact");
  expect(mocks.state.updateNodeData.mock.calls[0][1]).not.toHaveProperty(
    "html",
  );
});
it("refuses missing generated outputs even when a preview/reference exists", async () => {
  mocks.state.nodes[1].data = { referenceImageUrl: "reference.png" };
  await expect(executeWorkflowHtmlNode("page", "p", "c")).rejects.toThrow(
    /output/,
  );
  expect(mocks.generate).not.toHaveBeenCalled();
});
it("propagates version conflicts without overwriting node identity", async () => {
  mocks.state.nodes[0].data.artifactId = "existing";
  mocks.state.nodes[0].data.artifactVersion = 2;
  mocks.save.mockRejectedValue(new Error("version conflict"));
  await expect(executeWorkflowHtmlNode("page", "p", "c")).rejects.toThrow(
    "version conflict",
  );
  expect(mocks.state.updateNodeData.mock.calls.some(([, patch]) => "artifactId" in patch)).toBe(false);
  expect(mocks.create).not.toHaveBeenCalled();
});

it("recovers an already committed create without regenerating", async () => {
  mocks.lookup.mockResolvedValue({
    artifact: { id: "saved", version: 1, title: "Saved" },
  });
  const result = await executeWorkflowHtmlNode("page", "p", "c");
  expect(result.artifact_id).toBe("saved");
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
});
it("coalesces simultaneous execution of the same workflow step", async () => {
  await Promise.all([
    executeWorkflowHtmlNode("page", "p", "c"),
    executeWorkflowHtmlNode("page", "p", "c"),
  ]);
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  expect(mocks.create).toHaveBeenCalledTimes(1);
  expect(mocks.create.mock.calls[0][3]).toBe("workflow:c:page");
});
it("passes actual generated video outputs alongside images", async () => {
  mocks.state.nodes.push({
    id: "video",
    type: "videoNode",
    data: {
      videoUrl: "/api/v1/projects/p/media/clip.mp4",
      widthPx: 1920,
      heightPx: 1080,
      durationMs: 8000,
    },
  });
  mocks.state.edges.push({ source: "video", target: "page" });
  await executeWorkflowHtmlNode("page", "p", "c");
  expect(mocks.generate.mock.calls[0][0].requiredOutputContext).toContain(
    "/api/v1/projects/p/media/clip.mp4",
  );
  expect(mocks.generate.mock.calls[0][0].requiredOutputContext).toContain(
    '"aspect_ratio":"16:9"',
  );
  expect(mocks.generate.mock.calls[0][0].requiredOutputContext).toContain(
    '"duration_ms":8000',
  );
});

it("returns saved identity when local attachment fails", async () => {
  mocks.state.updateNodeData.mockImplementation(() => {
    throw new Error("local failure");
  });
  const result = await executeWorkflowHtmlNode("page", "p", "c");
  expect(result.artifact_id).toBe("artifact");
  expect(result.warnings?.join(" ")).toContain("could not be refreshed");
});
it("preserves uploaded video references", async () => {
  mocks.state.nodes[1] = {
    id: "image",
    type: "uploadNode",
    data: {
      videoUrl: "/api/v1/projects/p/media/upload.mp4",
      previewImageUrl: "poster.png",
    },
  };
  await executeWorkflowHtmlNode("page", "p", "c");
  expect(mocks.generate.mock.calls[0][0].requiredOutputContext).toContain(
    "upload.mp4",
  );
  expect(mocks.generate.mock.calls[0][0].requiredOutputContext).not.toContain(
    "poster.png",
  );
});
it("waits on dependency-only media without sending it to the HTML recipe", async () => {
  mocks.state.edges[0].data = {
    link_type: "dependency_for",
    edgeKind: "dependency",
  };
  await executeWorkflowHtmlNode("page", "p", "c");
  expect(mocks.generate.mock.calls[0][0].requiredOutputContext).not.toContain(
    "image.png",
  );
  expect(mocks.generate.mock.calls[0][0].upstreamContents).toEqual([]);
});

it("publishes generation lifecycle for both manual and workflow callers", async () => {
  await executeWorkflowHtmlNode("page", "p", "c");
  expect(mocks.state.updateNodeData).toHaveBeenCalledWith("page", expect.objectContaining({isGenerating: true, generationError: undefined}));
  expect(mocks.state.updateNodeData).toHaveBeenLastCalledWith("page", expect.objectContaining({isGenerating: false, generationStartedAt: null}));
});
it("keeps the previous artifact and exposes errors when regeneration fails", async () => {
  mocks.state.nodes[0].data.artifactId = "existing";
  mocks.state.nodes[0].data.artifactVersion = 2;
  mocks.generate.mockRejectedValueOnce(new Error("gateway unavailable"));
  await expect(executeWorkflowHtmlNode("page", "p", "c")).rejects.toThrow("gateway unavailable");
  expect(mocks.state.updateNodeData).toHaveBeenCalledWith("page", expect.objectContaining({generationError: "gateway unavailable"}));
  expect(mocks.state.nodes[0].data.artifactId).toBe("existing");
});

it("preserves connected copy and names media for HTML prompts", async () => {
  mocks.state.nodes[1].data.displayName = "Coffee hero";
  mocks.state.nodes[1].data.imageNaturalWidth = 1088;
  mocks.state.nodes[1].data.imageNaturalHeight = 608;
  mocks.state.nodes[1].data.aspectRatio = "34:19";
  mocks.state.nodes.push({id: "copy", type: "textAnnotationNode", data: {content: "Fresh coffee"}});
  mocks.state.edges.push({source: "copy", target: "page"});
  await executeWorkflowHtmlNode("page", "p", "c");
  expect(mocks.generate).toHaveBeenCalledWith(expect.objectContaining({upstreamInputMode: "connected", upstreamText: "Fresh coffee"}));
  expect(mocks.generate.mock.calls[0][0].requiredOutputContext).toContain('"name":"Coffee hero"');
  expect(mocks.generate.mock.calls[0][0].requiredOutputContext).toContain('"mention":"@图片1"');
  expect(mocks.generate.mock.calls[0][0].requiredOutputContext).toContain('"mention":"@文本1"');
  expect(mocks.generate.mock.calls[0][0].requiredOutputContext).toContain('"width":1088');
  expect(mocks.generate.mock.calls[0][0].requiredOutputContext).toContain('"height":608');
  expect(mocks.generate.mock.calls[0][0].requiredOutputContext).toContain('"aspect_ratio":"34:19"');
});

it("uses the ordinary text task for a manually created HTML node", async () => {
  mocks.state.nodes[0].data = {prompt: "Build a page"};
  await executeWorkflowHtmlNode("page", "p", "c");
  expect(mocks.submitText).toHaveBeenCalledWith("p", expect.objectContaining({
    prompt: expect.stringContaining("Build a page"),
    canvasId: "c",
    nodeId: "page",
  }));
  expect(mocks.awaitTask).toHaveBeenCalledWith(
    "user:p:freezone_text_generate:job",
    "p",
    {taskType: "freezone_text_generate"},
  );
  expect(mocks.fetchText).toHaveBeenCalledWith("p", "job");
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.create).toHaveBeenCalledWith(
    "p",
    "HTML",
    expect.stringContaining("<html>"),
    "html-generation:c:page:user:p:freezone_text_generate:job",
  );
  expect(mocks.state.updateNodeData).toHaveBeenCalledWith(
    "page",
    expect.objectContaining({
      generationTaskKey: "user:p:freezone_text_generate:job",
      generationTaskType: "freezone_text_generate",
      generationTaskJobId: "job",
      htmlGenerationPhase: "generating",
      htmlGenerationTitle: "HTML",
    }),
  );
});

it("reuses a persisted HTML text task instead of submitting the model again", async () => {
  mocks.state.nodes[0].data = {
    prompt: "Build a page",
    isGenerating: false,
    generationTaskKey: "user:p:freezone_text_generate:old-job",
    generationTaskType: "freezone_text_generate",
    generationTaskJobId: "old-job",
    htmlGenerationTitle: "Recovered page",
    htmlGenerationSelectionToken: "selection-1",
  };

  await executeWorkflowHtmlNode("page", "p", "c");

  expect(mocks.submitText).not.toHaveBeenCalled();
  expect(mocks.awaitTask).toHaveBeenCalledWith(
    "user:p:freezone_text_generate:old-job",
    "p",
    {taskType: "freezone_text_generate"},
  );
  expect(mocks.fetchText).toHaveBeenCalledWith("p", "old-job");
  expect(mocks.create).toHaveBeenCalledTimes(1);
});

it("saves a completed result without overriding a history version selected meanwhile", async () => {
  mocks.state.nodes[0].data = {
    prompt: "Build a page",
    artifactId: "existing",
    artifactVersion: 2,
    htmlSelectionToken: "current-v2",
  };
  let finishSave!: (value: unknown) => void;
  mocks.save.mockImplementation(() => new Promise((resolve) => { finishSave = resolve; }));

  const pending = executeWorkflowHtmlNode("page", "p", "c");
  await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
  mocks.state.updateNodeData("page", {
    artifactVersion: 1,
    htmlSelectionToken: "selected-v1",
  });
  finishSave({id: "existing", version: 3, title: "Saved result"});
  const output = await pending;

  expect(mocks.state.nodes[0].data.artifactVersion).toBe(1);
  expect(mocks.state.nodes[0].data.generationTaskKey).toBeNull();
  expect(mocks.submitText).toHaveBeenCalledTimes(1);
  expect(output.warnings?.join(' ')).toContain('saved to history');
});

it("retries Artifact saving with the same task and idempotency key", async () => {
  mocks.state.nodes[0].data = {
    prompt: "Build a page",
    artifactId: "existing",
    artifactVersion: 2,
  };
  mocks.save.mockRejectedValueOnce(new Error("storage unavailable"));

  await expect(executeWorkflowHtmlNode("page", "p", "c")).rejects.toThrow("storage unavailable");
  expect(mocks.state.nodes[0].data.htmlGenerationPhase).toBe("save_failed");
  expect(mocks.state.nodes[0].data.generationTaskJobId).toBe("job");

  mocks.save.mockResolvedValueOnce({id: "existing", version: 3, title: "HTML"});
  await executeWorkflowHtmlNode("page", "p", "c");

  expect(mocks.submitText).toHaveBeenCalledTimes(1);
  expect(mocks.fetchText).toHaveBeenCalledTimes(2);
  expect(mocks.save).toHaveBeenCalledTimes(2);
  expect(mocks.save.mock.calls[0][6]).toBe(
    "html-generation:c:page:user:p:freezone_text_generate:job",
  );
  expect(mocks.save.mock.calls[1][6]).toBe(mocks.save.mock.calls[0][6]);
  expect(mocks.state.nodes[0].data.artifactVersion).toBe(3);
  expect(mocks.state.nodes[0].data.generationTaskKey).toBeNull();
});

it("keeps explicit workflow HTML nodes on Recipe generation", async () => {
  await executeWorkflowHtmlNode("page", "p", "c");
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  expect(mocks.submitText).not.toHaveBeenCalled();
});

it("includes connected text and exact media metadata in ordinary HTML generation", async () => {
  mocks.state.nodes[0].data = {prompt: "Build a coffee page"};
  mocks.state.nodes[1].data = {
    displayName: "Coffee hero",
    imageUrl: "/api/v1/projects/p/media/coffee.png",
    imageNaturalWidth: 1088,
    imageNaturalHeight: 608,
    aspectRatio: "34:19",
  };
  mocks.state.nodes.push({
    id: "copy",
    type: "textAnnotationNode",
    data: {displayName: "Coffee copy", content: "Fresh coffee every morning"},
  });
  mocks.state.edges.push({source: "copy", target: "page"});

  await executeWorkflowHtmlNode("page", "p", "c");

  const prompt = mocks.submitText.mock.calls[0][1].prompt as string;
  expect(prompt).toContain("Build a coffee page");
  expect(prompt).toContain('"mention":"@图片1"');
  expect(prompt).toContain('"url":"/api/v1/projects/p/media/coffee.png"');
  expect(prompt).toContain('"width":1088');
  expect(prompt).toContain('"height":608');
  expect(prompt).toContain('"aspect_ratio":"34:19"');
  expect(prompt).toContain('"mention":"@文本1"');
  expect(prompt).toContain("Fresh coffee every morning");
});

it("rejects invalid ordinary text output before saving an Artifact", async () => {
  mocks.state.nodes[0].data = {prompt: "Build a page"};
  mocks.fetchText.mockResolvedValueOnce({
    generated_text: "Here is your page",
    model: "writer",
  });

  await expect(executeWorkflowHtmlNode("page", "p", "c")).rejects.toThrow(
    /complete HTML/,
  );
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});

it("preserves an existing Artifact when ordinary text generation fails", async () => {
  mocks.state.nodes[0].data = {
    prompt: "Rebuild the page",
    artifactId: "existing",
    artifactVersion: 2,
  };
  mocks.submitText.mockRejectedValueOnce(new Error("text gateway unavailable"));

  await expect(executeWorkflowHtmlNode("page", "p", "c")).rejects.toThrow(
    "text gateway unavailable",
  );
  expect(mocks.state.nodes[0].data).toMatchObject({
    artifactId: "existing",
    artifactVersion: 2,
  });
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});
