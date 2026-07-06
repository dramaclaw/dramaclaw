// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("script route source editor integration", () => {
  it("mounts the episode source editor and saves beat_source_text", () => {
    const route = readFileSync(
      "src/routes/_app/projects.$project/episodes.$episode/script.lazy.tsx",
      "utf8",
    );

    expect(route).toContain("EpisodeSourceEditor");
    expect(route).toContain("beat_source_text");
    expect(route).toContain("saveScopes.episodeSource");
  });

  it("mounts the beat-level script preview from episode beats", () => {
    const route = readFileSync(
      "src/routes/_app/projects.$project/episodes.$episode/script.lazy.tsx",
      "utf8",
    );

    expect(route).toContain("useEpisodeBeats");
    expect(route).toContain("ScriptBeatPreview");
    expect(route).toContain("episode.script.previewTitle");
  });

  it("keeps the episode story context panel hidden on the script page", () => {
    const route = readFileSync(
      "src/routes/_app/projects.$project/episodes.$episode/script.lazy.tsx",
      "utf8",
    );

    expect(route).not.toContain("EpisodeStoryContext");
    expect(route).not.toContain("content_summary");
    expect(route).not.toContain("key_events");
    expect(route).not.toContain("cliffhanger");
  });

  it("mounts episode scene and prop planning from detail menus", () => {
    const route = readFileSync(
      "src/routes/_app/projects.$project/episodes.$episode/script.lazy.tsx",
      "utf8",
    );

    expect(route).toContain("EpisodeAssetPlanning");
    expect(route).toContain("usePlanEpisodeScenes");
    expect(route).toContain("usePlanEpisodeProps");
    expect(route).toContain("scene_menu");
    expect(route).toContain("prop_menu");
    expect(route).toContain("project={project}");
  });

  it("shows feature credit cost on detail scene and prop planning", () => {
    const route = readFileSync(
      "src/routes/_app/projects.$project/episodes.$episode/script.lazy.tsx",
      "utf8",
    );
    const planning = readFileSync(
      "src/components/episode/episode-asset-planning.tsx",
      "utf8",
    );

    expect(route).toContain(
      'useGenerationCreditCost("feature", "episode_scene_planner")',
    );
    expect(route).toContain(
      'useGenerationCreditCost("feature", "episode_prop_planner")',
    );
    expect(route).toContain(
      "planScenesCost.error instanceof BillingRuleNotConfiguredError",
    );
    expect(route).toContain(
      "planPropsCost.error instanceof BillingRuleNotConfiguredError",
    );
    expect(route).toContain("sceneCostDisplay={planScenesCostDisplay}");
    expect(route).toContain("propCostDisplay={planPropsCostDisplay}");
    expect(route).toMatch(
      /const handlePlanScenes[\s\S]*toast\.error\(backendErrorToastMessage\(res\.error, t\)\)[\s\S]*catch \(err\)[\s\S]*toast\.error\(backendErrorToastMessage\(err, t\)\)/,
    );
    expect(route).toMatch(
      /const handlePlanProps[\s\S]*toast\.error\(backendErrorToastMessage\(res\.error, t\)\)[\s\S]*catch \(err\)[\s\S]*toast\.error\(backendErrorToastMessage\(err, t\)\)/,
    );
    expect(planning).toContain("<CreditCostInline display={costDisplay} />");
  });

  it("shows feature credit cost on detail identity planning", () => {
    const route = readFileSync(
      "src/routes/_app/projects.$project/episodes.$episode/script.lazy.tsx",
      "utf8",
    );
    const picker = readFileSync(
      "src/components/identity-picker-dialog.tsx",
      "utf8",
    );

    expect(route).toContain('useGenerationCreditCost("feature", "identity_planner")');
    expect(route).toContain(
      "planIdentitiesCost.error instanceof BillingRuleNotConfiguredError",
    );
    expect(route).toContain("planCostDisplay={planIdentitiesCostDisplay}");
    expect(picker).toContain("<CreditCostInline display={planCostDisplay} />");
  });

  it("wires episode prop promotion labels into the planning area", () => {
    const route = readFileSync(
      "src/routes/_app/projects.$project/episodes.$episode/script.lazy.tsx",
      "utf8",
    );

    expect(route).toContain("episode.script.propInGlobal");
    expect(route).toContain("episode.script.promotePropTitle");
    expect(route).toContain("assets.props.types");
  });
});
