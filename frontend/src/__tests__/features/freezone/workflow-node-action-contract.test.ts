import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const readNodeSource = (name: string) =>
  readFileSync(
    resolve(process.cwd(), `src/features/canvas/nodes/${name}.tsx`),
    "utf8",
  );

const readSource = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");

describe("dynamic workflow node action contract", () => {
  it.each([
    ["TextAnnotationNode", "generate_text"],
    ["ImageGenNode", "generate_image"],
    ["VideoNode", "generate_video"],
    ["AudioNode", "generate_audio"],
    ["VideoComposeNode", "auto_compose_video"],
  ])("keeps %s subscribed to %s", (nodeName, action) => {
    const source = readNodeSource(nodeName);

    expect(source).toContain("subscribeNodeAction");
    expect(source).toContain(action);
    expect(source).toContain("publishNodeActionAccepted");
    expect(source).toContain("publishNodeActionSuccess");
    expect(source).toContain("publishNodeActionError");
  });

  it("keeps offscreen workflow nodes mounted while a run is active", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/features/canvas/Canvas.tsx"),
      "utf8",
    );

    expect(source).toContain("WORKFLOW_RUN_UPDATED_EVENT");
    expect(source).toContain("onlyRenderVisibleElements={!workflowExecutionActive && !lowDetailActive}");
  });

  it("allows long-running media tasks to finish before timing out", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/features/freezone/canvasChatCommands.ts"),
      "utf8",
    );

    expect(source).toContain("DEFAULT_NODE_ACTION_TIMEOUT_MS = 30 * 60 * 1000");
  });

  it("compiles catalog-backed image workflow prompts before generation", () => {
    const source = readSource("src/features/canvas/nodes/shared/useImageGenerationForm.ts");

    expect(source).toContain("compileWorkflowNodePrompt");
    expect(source).toContain("workflowRecipeCompileMode: mode");
    expect(source).toContain("workflowRecipeCompiledPrompt: compiledPrompt");
  });

  it.each([
    ["image generation", "src/features/canvas/nodes/shared/useImageGenerationForm.ts", "prompt"],
    ["image edit", "src/features/canvas/nodes/ImageEditNode.tsx", "prompt"],
    ["video generation", "src/features/canvas/nodes/shared/useVideoGenerationForm.ts", "prompt"],
    ["audio generation", "src/features/canvas/nodes/useAudioGeneration.ts", "text"],
  ])("persists compiled workflow prompts back to %s node prompts", (_label, path, field) => {
    const source = readSource(path);

    expect(source).toContain("workflowRecipeCompiledPrompt: compiledPrompt");
    expect(source).toMatch(
      new RegExp(`workflowRecipeCompiledPrompt:\\s*compiledPrompt,\\s*\\n\\s*${field}:\\s*compiledPrompt`),
    );
  });
});
