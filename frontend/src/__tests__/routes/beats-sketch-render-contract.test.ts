// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string) {
  return readFileSync(path, "utf8");
}

describe("beats sketch/render v2 contract", () => {
  it("does not expose the legacy /sketches/batch auto-select action", () => {
    const batchBar = read("src/components/episode/beat-workbench/batch-bar.tsx");
    const sketches = read("src/lib/queries/sketches.ts");

    expect(batchBar).not.toContain("useBatchSketches");
    expect(batchBar).not.toContain("batchSketchTask");
    expect(batchBar).not.toContain("handleBatchSketches");
    expect(batchBar).not.toContain("episode.workbench.batch.autoSelect");
    expect(sketches).not.toContain("sketches/batch");
    expect(sketches).not.toContain("useBatchRender");
    expect(sketches).not.toContain("grids/batch-render");
  });

  it("keeps global render generation out of the top toolbar", () => {
    const taskTypes = read("src/lib/task-types.ts");
    const stageRegistry = read("src/lib/episode-stage-registry.ts");
    const batchBar = read("src/components/episode/beat-workbench/batch-bar.tsx");
    const batchPanel = read("src/components/episode/beat-workbench/batch-panel.tsx");
    const actionPanel = read("src/components/episode/beat-workbench/action-panel.tsx");
    const renderPlanQuery = read("src/lib/queries/render-plan.ts");

    expect(taskTypes).not.toContain('BATCH_RENDER: "batch_render"');
    expect(stageRegistry).not.toContain("TASK_TYPES.BATCH_RENDER");
    expect(taskTypes).not.toContain('RENDER_PLAN: "render_plan"');
    expect(stageRegistry).not.toContain("TASK_TYPES.RENDER_PLAN");
    expect(taskTypes).not.toContain('VIDEO_GENERATION: "video_generation"');
    expect(stageRegistry).not.toContain("TASK_TYPES.VIDEO_GENERATION");

    expect(batchBar).not.toContain("useBatchRender");
    expect(batchBar).not.toContain("batchRenderTask = useTaskController");
    expect(batchBar).not.toContain("TASK_TYPES.BATCH_RENDER");
    expect(batchBar).not.toContain("batchRenderTask.start()");
    expect(batchBar).not.toContain("renderPlanTask = useTaskController");
    expect(batchBar).not.toContain("setRenderPlanOpen(true)");
    expect(batchBar).not.toContain("<RenderPlanDialog");
    expect(batchBar).not.toContain("episode.workbench.batch.genRender");
    expect(actionPanel).not.toContain("<BatchPanel");
    expect(batchBar).not.toContain("useGenerateVideos");
    expect(batchBar).not.toContain("handleGenAllVideos");
    expect(batchBar).not.toContain("episode.workbench.batch.genVideoTitle");

    // Render regen fans out into N selected_regen grid tasks; track them by id
    // via the batch-invalidation hook rather than a single-scope controller.
    expect(batchPanel).toContain("useScopedTaskBatchInvalidation");
    expect(batchPanel).toContain("TASK_TYPES.SELECTED_REGEN");
    expect(batchPanel).toContain('matchBy: "task_id"');
    expect(batchPanel).toContain("<RenderPlanDialog");
    expect(batchPanel).not.toContain("handleBatchVideo");
    expect(renderPlanQuery).toContain("render/plan");
    expect(renderPlanQuery).toContain("render/execute");
  });

  it("does not expose whole-episode sketch generation from the batch toolbar", () => {
    const batchBar = read("src/components/episode/beat-workbench/batch-bar.tsx");

    expect(batchBar).not.toContain("useGenerateSketches");
    expect(batchBar).not.toContain("handleGenAllSketches");
    expect(batchBar).not.toContain("episode.workbench.batch.genSketchTitle");
    expect(batchBar).not.toContain("episode.workbench.batch.genSketch");
  });

  it("keeps AI prompt optimization in the sketch SuperPower workflow", () => {
    const batchBar = read("src/components/episode/beat-workbench/batch-bar.tsx");
    const videoQueries = read("src/lib/queries/video.ts");
    const renderedActions = batchBar.slice(batchBar.indexOf("return ("));

    const superpowerAction = renderedActions.indexOf("episode.workbench.batch.aiOptimizeTitle");

    expect(batchBar).toContain("useGlobalOptimize");
    expect(batchBar).toContain("useGlobalOptimizeBillingQuote");
    expect(batchBar).toContain("globalOptimizeCostDisplay");
    expect(videoQueries).toContain("optimize/video-global");
    expect(videoQueries).toContain("optimize/video-global/billing-quote");
    expect(videoQueries).toMatch(
      /optimize\/video-global[\s\S]*?throwHttpErrors: false/,
    );
    expect(superpowerAction).toBeGreaterThan(-1);
    expect(renderedActions).not.toContain("openRenderPlan(false)");
    expect(renderedActions).not.toContain("episode.workbench.batch.genVideoTitle");
  });

  it("keeps grid sketch generation available outside BatchBar", () => {
    const batchBar = read("src/components/episode/beat-workbench/batch-bar.tsx");
    const sketchesQuery = read("src/lib/queries/sketches.ts");

    expect(batchBar).not.toContain("grid_index: -1");
    expect(sketchesQuery).toContain("useGenerateSketches");
    expect(sketchesQuery).toContain("sketches/generate");
  });

  it("keeps selected-beat render regeneration backed by render_plan", () => {
    const taskTypes = read("src/lib/task-types.ts");
    const stageRegistry = read("src/lib/episode-stage-registry.ts");
    const batchPanel = read("src/components/episode/beat-workbench/batch-panel.tsx");
    const renderSection = read("src/components/episode/beat-workbench/render-section.tsx");

    expect(taskTypes).not.toContain('RENDER_PLAN: "render_plan"');
    expect(stageRegistry).not.toContain("TASK_TYPES.RENDER_PLAN");

    expect(batchPanel).toContain("useScopedTaskBatchInvalidation");
    expect(batchPanel).toContain("TASK_TYPES.SELECTED_REGEN");
    expect(batchPanel).toContain('matchBy: "task_id"');
    expect(renderSection).toContain("useRegenerateRenderBeats");
    expect(renderSection).toContain('taskType: "selected_regen"');
  });

  it("moves selected redraw actions to the ViewToggles row instead of the top toolbar or right panel", () => {
    const batchBar = read("src/components/episode/beat-workbench/batch-bar.tsx");
    const actionPanel = read("src/components/episode/beat-workbench/action-panel.tsx");
    const viewToggles = read("src/components/episode/beat-workbench/view-toggles.tsx");
    const route = read("src/routes/_app/projects.$project/episodes.$episode/beats.lazy.tsx");

    expect(viewToggles).toContain("onBatchRegenSketch");
    expect(viewToggles).toContain("onBatchRegenRender");
    expect(viewToggles).toContain("episode.workbench.view.batchRegenSketch");
    expect(viewToggles).toContain("episode.workbench.view.batchRegenRender");
    expect(route).toContain("onBatchRegenSketch={openSketchPlan}");
    expect(route).toContain("onBatchRegenRender={openRenderPlan}");
    expect(route).toContain("<RenderPlanDialog");
    expect(route).toContain("aspectMode={aspectSpecValue.renderAspect}");
    expect(route).toContain("createSketchRegenPlanItems");
    expect(route).not.toContain("useRegenerateRenderBeats");
    expect(route).not.toContain("bestFitMode(SKETCH_REGEN_MODES");

    expect(batchBar).not.toContain("checkedBeats");
    expect(batchBar).not.toContain("dispatchSelectedSketchItems");
    expect(actionPanel).not.toContain("<BatchPanel");
  });

  it("dispatches selected-beat sketch plans directly without persistent queue cards", () => {
    const batchPanel = read("src/components/episode/beat-workbench/batch-panel.tsx");

    expect(batchPanel).toContain("dispatchSketchPlanItems");
    expect(batchPanel).not.toContain("sketchDispatchQueue");
    expect(batchPanel).not.toContain("sketchDispatchRun");
    expect(batchPanel).not.toContain("handleDispatchSketchItem");
    expect(batchPanel).toContain("onClearSelection()");
  });

  it("labels the selected sketch grid action as batch redraw instead of auto combine", () => {
    const batchPanel = read("src/components/episode/beat-workbench/batch-panel.tsx");
    const sketchSection = batchPanel.slice(
      batchPanel.indexOf("{/* Sketch modes */}"),
      batchPanel.indexOf("{/* Render modes */}"),
    );

    expect(sketchSection).toContain("episode.workbench.batch.autoCombine");
    expect(sketchSection).toContain('defaultValue: "批量重抽"');
    expect(sketchSection).not.toContain('defaultValue: "自动组合"');
  });

  it("wires NiceGUI Render model/settings into React controls and task payloads", () => {
    const batchBar = read("src/components/episode/beat-workbench/batch-bar.tsx");
    const renderSettingsControls = read(
      "src/components/episode/beat-workbench/render-settings-controls.tsx",
    );
    const renderSettingsQuery = read("src/lib/queries/render-settings.ts");
    const queryKeys = read("src/lib/query-keys.ts");
    const sketchesQuery = read("src/lib/queries/sketches.ts");
    const projectTypes = read("src/types/project.ts");

    expect(batchBar).toContain("RenderModelSelect");
    expect(batchBar).toContain("<RenderModelSelect project={project} />");
    expect(batchBar).not.toContain("RenderCheckboxes");
    expect(renderSettingsControls).toContain("useRenderSettings");
    expect(renderSettingsControls).toContain("useUpdateRenderSettings");
    expect(renderSettingsQuery).toContain("render-settings");
    expect(queryKeys).toContain("renderSettings");

    expect(sketchesQuery).toContain("image_generation_selection");
    expect(sketchesQuery).toContain("sketch_aspect_padding");
    expect(projectTypes).toContain("render_image_selection?: string");
    expect(projectTypes).toContain("sketch_aspect_padding?: boolean");
    expect(renderSettingsControls).not.toContain("sketchAspectPadding");
    expect(renderSettingsControls).not.toContain("render-sketch-aspect-padding");
    expect(renderSettingsControls).not.toContain("forceHalfK");
    expect(renderSettingsControls).not.toContain("force_half_k");
    expect(sketchesQuery).not.toContain("forceHalfK");
    expect(sketchesQuery).not.toContain("force_half_k");
    expect(projectTypes).not.toContain("force_half_k?: boolean");
  });

  it("exposes sketch and render upload actions instead of disabled placeholders", () => {
    const sketchSection = read("src/components/episode/beat-workbench/sketch-section.tsx");
    const renderSection = read("src/components/episode/beat-workbench/render-section.tsx");
    const sketches = read("src/lib/queries/sketches.ts");

    expect(sketches).toContain("useUploadBeatImage");
    expect(sketches).toContain("beats/${beatNum}/${imageType}/upload");

    expect(sketchSection).not.toContain('title={t("common.comingSoon")}');
    expect(renderSection).not.toContain('title={t("common.comingSoon")}');
    expect(sketchSection).toContain('type="file"');
    expect(renderSection).toContain('type="file"');
  });
});
