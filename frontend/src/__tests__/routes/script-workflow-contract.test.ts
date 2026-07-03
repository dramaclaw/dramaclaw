// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string) {
  return readFileSync(path, "utf8");
}

describe("script workflow canonical contract", () => {
  it("uses script_writer and /script/generate for beats empty-state generation", () => {
    const route = read(
      "src/routes/_app/projects.$project/episodes.$episode/beats.lazy.tsx",
    );

    expect(route).toContain("useGenerateScript");
    expect(route).toContain("useEpisodeDetail");
    expect(route).toContain("identityPlanReady");
    expect(route).toContain("episode.script.identityRequired");
    expect(route).toContain('useGenerationCreditCost("feature", "script_writer")');
    expect(route).toContain(
      "generateScriptCost.error instanceof BillingRuleNotConfiguredError",
    );
    expect(route).toContain("<CreditCostInline display={generateScriptCostDisplay} />");
    expect(route).toContain("backendErrorToastMessage(err, t)");
    expect(route).toContain('taskType: "script_writer"');
    expect(route).toContain('alsoReconcile: ["literal_script_writer"]');
    expect(route).not.toContain("useGenerateLiteralScript");
    expect(route).not.toContain('taskType: "literal_script_writer"');
  });

  it("exposes the v2-storage NiceGUI script workbench controls in the Script tab", () => {
    const route = read(
      "src/routes/_app/projects.$project/episodes.$episode/script.lazy.tsx",
    );

    expect(route).toContain("useEpisodeDetail");
    expect(route).toContain("useProject");
    expect(route).toContain("beat_source_text");
    expect(route).toContain("useGenerateScript");
    expect(route).toContain('useGenerationCreditCost("feature", "script_writer")');
    expect(route).toContain(
      "generateScriptCost.error instanceof BillingRuleNotConfiguredError",
    );
    expect(route).toContain("<CreditCostInline display={generateScriptCostDisplay} />");
    expect(route).toContain("useGenerateRewrite");
    expect(route).toContain('spine_template === "narrated"');
    expect(route).toContain("initializedSourceRef");
    expect(route).toContain("ensureBeatSourceText");
    expect(route).toContain("handleGenerateRewrite");
    expect(route).toContain("scriptTask.start");
    expect(route).toContain("scriptTask.stop");
    expect(route).toContain("identityTask = useTaskController");
    expect(route).toContain("TASK_TYPES.IDENTITY_PLANNER");
    expect(route).toContain("identityTask.start");
    expect(route).toContain("getScriptReviewFeedback");
    expect(route).toContain("showCompleteToast: false");
    expect(route).toContain("generateScript");
    expect(route).toContain("generateRewrite");
    expect(route).not.toContain("handleRefreshScript");
    expect(route).not.toContain("handleLoadScript");
    expect(route).not.toContain("getScriptReloadFeedback");
    expect(route).not.toContain("refreshScript");
    expect(route).not.toContain("loadScript");
    expect(route).not.toContain("FolderOpen");
    expect(route).toContain("modeLiteral");
    expect(route).not.toContain("useRawContent");
    expect(route).not.toContain("useAdaptedContent");
    expect(route).not.toContain("useGenerateStaging");
    expect(route).not.toContain("CONTENT_REWRITER");
    expect(route).not.toContain('value="json"');
  });

  it("keeps unsupported main-branch script endpoints out of the v2-storage query layer", () => {
    const queries = read("src/lib/queries/scripts.ts");
    const queryKeys = read("src/lib/query-keys.ts");

    expect(queries).not.toContain("useGenerateLiteralScript");
    expect(queries).not.toContain("usePolishPatches");
    expect(queries).not.toContain("useRawContent");
    expect(queries).not.toContain("useAdaptedContent");
    expect(queries).not.toContain("useSaveAdaptedContent");
    expect(queries).not.toContain("useDeleteAdaptedContent");
    expect(queries).not.toContain("useGenerateStaging");

    expect(queries).not.toContain("literal-script/generate");
    expect(queries).not.toContain("raw-content");
    expect(queries).not.toContain("adapted-content");
    expect(queries).toContain("useGenerateRewrite");
    expect(queries).toContain("rewrite/generate");
    expect(queries).not.toContain("staging/generate");
    expect(queries).not.toContain("polish-patches");

    expect(queryKeys).not.toContain("raw-content");
    expect(queryKeys).not.toContain("adapted-content");
  });

  it("uses script review feedback for Script tab completion", () => {
    const route = read(
      "src/routes/_app/projects.$project/episodes.$episode/script.lazy.tsx",
    );

    expect(route).toContain("getScriptReviewFeedback");
    expect(route).toContain("showCompleteToast: false");
  });

  it("passes narrated rewrite line count and character range controls to the API", () => {
    const route = read(
      "src/routes/_app/projects.$project/episodes.$episode/script.lazy.tsx",
    );
    const zh = read("public/locales/zh/translation.json");
    const en = read("public/locales/en/translation.json");

    expect(route).toContain("rewriteTargetBeats");
    expect(route).toContain("rewriteBeatCharsMin");
    expect(route).toContain("rewriteBeatCharsMax");
    expect(route).toContain("episode.script.rewriteTargetBeats");
    expect(route).toContain("episode.script.rewriteBeatCharsMin");
    expect(route).toContain("episode.script.rewriteBeatCharsMax");
    expect(route).toContain("target_beats: rewriteTargetBeats");
    expect(route).toContain("beat_chars_min: rewriteBeatCharsMin");
    expect(route).toContain("beat_chars_max: rewriteBeatCharsMax");
    expect(route).not.toContain("generateRewrite.mutateAsync({})");
    expect(zh).toContain('"rewriteTargetBeats"');
    expect(zh).toContain('"rewriteBeatCharsMin"');
    expect(zh).toContain('"rewriteBeatCharsMax"');
    expect(en).toContain('"rewriteTargetBeats"');
    expect(en).toContain('"rewriteBeatCharsMin"');
    expect(en).toContain('"rewriteBeatCharsMax"');
  });

  it("surfaces backend task admission errors for script planning actions", () => {
    const route = read(
      "src/routes/_app/projects.$project/episodes.$episode/script.lazy.tsx",
    );

    expect(route).toContain("backendErrorToastMessage");
    expect(route).toMatch(
      /const handlePlanIdentities[\s\S]*catch \(err\)[\s\S]*toast\.error\(backendErrorToastMessage\(err, t\)\)/,
    );
    expect(route).toMatch(
      /const handlePlanScenes[\s\S]*catch \(err\)[\s\S]*toast\.error\(backendErrorToastMessage\(err, t\)\)/,
    );
    expect(route).toMatch(
      /const handlePlanProps[\s\S]*catch \(err\)[\s\S]*toast\.error\(backendErrorToastMessage\(err, t\)\)/,
    );
  });
});
