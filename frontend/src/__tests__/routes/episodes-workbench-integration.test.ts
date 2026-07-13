// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const routeSource = readFileSync(
  "src/routes/_app/projects.$project/episodes.tsx",
  "utf-8",
);

describe("episodes workbench integration", () => {
  it("wires NiceGUI-style stats and manual refresh into the episode list", () => {
    expect(routeSource).toContain("deriveEpisodeStats");
    expect(routeSource).toContain("EpisodeStatsStrip");
    expect(routeSource).toContain("handleRefresh");
    expect(routeSource).toContain("episode.list.stats.totalEpisodes");
    expect(routeSource).toContain("episode.list.refresh");
  });

  it("wires list-card identity, scene, and prop planning shortcuts", () => {
    expect(routeSource).toContain("usePlanIdentities");
    expect(routeSource).toContain("usePlanEpisodeScenes");
    expect(routeSource).toContain("usePlanEpisodeProps");
    expect(routeSource).toContain('taskType: "identity_planner"');
    expect(routeSource).toContain("onPlanScenes");
    expect(routeSource).toContain("onPlanProps");
    expect(routeSource).toContain("episode.list.planIdentities");
    expect(routeSource).toContain("episode.list.planScenes");
    expect(routeSource).toContain("episode.list.planProps");
  });

  it("shows feature credit cost on list-card identity planning actions", () => {
    expect(routeSource).toContain('useGenerationCreditCost("feature", "identity_planner")');
    expect(routeSource).toContain(
      "planIdentitiesCost.error instanceof BillingRuleNotConfiguredError",
    );
    expect(routeSource).toContain("identityCostDisplay={planIdentitiesCostDisplay}");
    expect(routeSource).toContain("<CreditCostInline display={costDisplay} />");
  });

  it("shows feature credit cost on list-card scene and prop planning actions", () => {
    expect(routeSource).toContain(
      'useGenerationCreditCost("feature", "episode_scene_planner")',
    );
    expect(routeSource).toContain(
      'useGenerationCreditCost("feature", "episode_prop_planner")',
    );
    expect(routeSource).toContain(
      "planScenesCost.error instanceof BillingRuleNotConfiguredError",
    );
    expect(routeSource).toContain(
      "planPropsCost.error instanceof BillingRuleNotConfiguredError",
    );
    expect(routeSource).toContain("sceneCostDisplay={planScenesCostDisplay}");
    expect(routeSource).toContain("propCostDisplay={planPropsCostDisplay}");
    expect(routeSource).toContain("costDisplay={sceneCostDisplay}");
    expect(routeSource).toContain("costDisplay={propCostDisplay}");
    expect(routeSource).toMatch(
      /const handlePlanScenes[\s\S]*toast\.error\(backendErrorToastMessage\(res\.error, t\)\)[\s\S]*catch \(err\)[\s\S]*toast\.error\(backendErrorToastMessage\(err, t\)\)/,
    );
    expect(routeSource).toMatch(
      /const handlePlanProps[\s\S]*toast\.error\(backendErrorToastMessage\(res\.error, t\)\)[\s\S]*catch \(err\)[\s\S]*toast\.error\(backendErrorToastMessage\(err, t\)\)/,
    );
  });

  it("scopes list-card planning spinners to the clicked episode", () => {
    expect(routeSource).toContain("planIdentities.isPending || identityTask.started");
    expect(routeSource).toContain('taskType: "identity_planner"');
    expect(routeSource).toContain("planScenes.variables === ep.number");
    expect(routeSource).toContain("planProps.variables === ep.number");
    expect(routeSource).toContain("sceneDisabled={planScenes.isPending}");
    expect(routeSource).toContain("propDisabled={planProps.isPending}");
  });

  it("shows only one episode planning action for the list state", () => {
    expect(routeSource).toContain("showPlan={!selectedEpisode && displayEpisodes.length === 0}");
    expect(routeSource).toContain("showReplan={!selectedEpisode && displayEpisodes.length > 0}");
  });

  it("shows feature credit cost on episode planning actions", () => {
    expect(routeSource).toContain('useGenerationCreditCost("feature", "build_episodes")');
    expect(routeSource).toContain("planEpisodesCost.error instanceof BillingRuleNotConfiguredError");
    expect(routeSource).toContain("planCostDisplay={planEpisodesCostDisplay}");
    expect(routeSource).toMatch(/<CreditCostInline\s+display=\{planCostDisplay\}/);
    expect(routeSource).toMatch(/<CreditCostInline\s+display=\{planEpisodesCostDisplay\}/);
  });

  it("uses localized copy for the episode detail back action", () => {
    expect(routeSource).toContain('t("episode.list.backToEpisodes")');
    expect(routeSource).not.toContain("返回剧集列表");
  });
});
