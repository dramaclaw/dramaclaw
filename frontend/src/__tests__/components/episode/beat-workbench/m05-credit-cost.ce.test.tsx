// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen } from "@testing-library/react";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { SceneAssetCard } from "@/components/assets/scene-asset-card";
import type { SceneAsset } from "@/types/scene";

const runtimeState = vi.hoisted(() => ({ isCeRuntime: true }));

vi.mock("@/lib/runtime-config", () => ({
  isCeRuntime: () => runtimeState.isCeRuntime,
}));

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "zh",
    resources: {
      zh: {
        translation: {
          assets: {
            common: {
              edit: "编辑",
              delete: "删除",
              generated: "已生成",
              missing: "未生成",
            },
            scenes: {
              master: "源图",
              pano: "360 全景",
              uploadMaster: "上传/替换源图",
              generateMaster: "生成源图",
              regenerateMaster: "重生源图",
              deleteMaster: "删除源图",
              reverse: "reverse",
              generateReverse: "生成 reverse",
              regenerateReverse: "重生 reverse",
              uploadPano: "上传/替换 360",
              generatePanoFromText: "生成 360",
              generatePanoFromMaster: "生成 360",
              generatePanoFromMasterReverse: "生成 360",
              deletePano: "删除 360",
              openPanoViewer: "打开360查看器",
              noMaster: "未生成 master.png",
              noReverse: "未生成 reverse_master.png",
              noPano: "未生成 pano_360.png",
              stage: {
                title: "导演世界",
                customWorld: "自定义导演世界 ✅",
                masterWorld: "正面导演世界 ✅",
                reverseWorld: "背面导演世界 ✅",
                panoWorld: "360 导演世界 ✅",
                uploadCustom: "上传/替换 custom 包",
                deleteCustom: "删除 custom 包",
                masterToPly: "master→导演世界",
                reverseToPly: "reverse→导演世界",
                panoToPly: "360→导演世界",
                openWorld: "打开导演世界",
                worldNotReady: "导演世界（片场未就绪）",
              },
            },
          },
        },
      },
    },
    interpolation: { escapeValue: false },
  });
});

function source(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

function renderSceneAssetCard(scene: SceneAsset) {
  render(
    <I18nextProvider i18n={i18n}>
      <SceneAssetCard
        scene={scene}
        masterCost="12 credits"
        reverseCost="12 credits"
        panoCost="12 credits"
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onUploadMaster={vi.fn()}
        onGenerateMaster={vi.fn()}
        onDeleteMaster={vi.fn()}
        onGenerateReverse={vi.fn()}
        onUploadPano={vi.fn()}
        onGeneratePano={vi.fn()}
        onDeletePano={vi.fn()}
        onOpenPanoViewer={vi.fn()}
        onOpenStageViewer={vi.fn()}
        onOpenFreezone={vi.fn()}
        onUploadCustomPackage={vi.fn()}
        onDeleteCustomPackage={vi.fn()}
        onGenerateStagePly={vi.fn()}
      />
    </I18nextProvider>,
  );
}

describe("M05 CE generation credit cost gating", () => {
  beforeEach(() => {
    runtimeState.isCeRuntime = true;
  });

  it("hides scene master, reverse, and pano costs in CE runtime", () => {
    renderSceneAssetCard({
      name: "皇宫大殿",
      scene_type: "interior",
      environment_prompt: "金色宫灯、朱红立柱、纵深空间",
      description: "",
      aliases: [],
      notes: "",
      master_url: "/static/u/p/assets/scenes/hall/master.png",
      reverse_master_url: "/static/u/p/assets/scenes/hall/reverse_master.png",
      pano_url: "/static/u/p/director_worlds/hall/v1/pano_360.png",
    });

    expect(screen.queryByText("12 credits")).not.toBeInTheDocument();
  });

  it("routes every named M05 cost display through CreditCostInline", () => {
    expect(source("src/components/assets/scene-asset-card.tsx")).toEqual(
      expect.stringContaining("<CreditCostInline display={masterCost} />"),
    );
    expect(source("src/components/assets/scene-asset-card.tsx")).toEqual(
      expect.stringContaining("<CreditCostInline display={reverseCost} />"),
    );
    expect(source("src/components/assets/scene-asset-card.tsx")).toEqual(
      expect.stringContaining("<CreditCostInline display={panoCost} />"),
    );
    expect(source("src/components/assets/scenes-panel.tsx")).toEqual(
      expect.stringContaining("masterCost={masterCost.data?.data.display}"),
    );
    expect(source("src/components/assets/scenes-panel.tsx")).toEqual(
      expect.stringContaining("reverseCost={reverseCost.data?.data.display}"),
    );
    expect(source("src/components/assets/scenes-panel.tsx")).toEqual(
      expect.stringContaining("panoCost={panoCost.data?.data.display}"),
    );
    expect(source("src/components/assets/scenes-panel.tsx")).toEqual(
      expect.stringContaining('useGenerationCreditCost("feature", "build_scenes")'),
    );
    expect(source("src/components/assets/scenes-panel.tsx")).toEqual(
      expect.stringContaining("buildScenesCost.error instanceof BillingRuleNotConfiguredError"),
    );
    expect(source("src/components/assets/scenes-panel.tsx")).toEqual(
      expect.stringMatching(/<CreditCostInline\s+display=\{buildScenesCostDisplay\}/),
    );
    expect(source("src/components/episode/beat-workbench/sketch-section.tsx")).toEqual(
      expect.stringContaining("<CreditCostInline display={sketchRegenCost.data?.data.display} />"),
    );
    expect(source("src/components/episode/beat-workbench/render-section.tsx")).toEqual(
      expect.stringContaining("<CreditCostInline display={renderRegenCost.data?.data.display} />"),
    );
    expect(source("src/components/episode/beat-workbench/batch-panel.tsx")).toEqual(
      expect.stringContaining("<CreditCostInline display={sketchPlanCostDisplay} />"),
    );
    expect(source("src/components/episode/beat-workbench/render-plan-dialog.tsx")).toEqual(
      expect.stringContaining("<CreditCostInline display={renderPlanCostDisplay} />"),
    );
    expect(
      source("src/routes/_app/projects.$project/episodes.$episode/beats.lazy.tsx"),
    ).toEqual(
      expect.stringContaining("<CreditCostInline display={sketchPlanCostDisplay} />"),
    );
  });

  it("does not add CE runtime forks to M05 business paths or the cost query hook", () => {
    const businessPaths = [
      "src/components/assets/scene-asset-card.tsx",
      "src/components/assets/scenes-panel.tsx",
      "src/components/episode/beat-workbench/sketch-section.tsx",
      "src/components/episode/beat-workbench/render-section.tsx",
      "src/components/episode/beat-workbench/batch-panel.tsx",
      "src/components/episode/beat-workbench/render-plan-dialog.tsx",
      "src/routes/_app/projects.$project/episodes.$episode/beats.lazy.tsx",
      "src/lib/queries/generation-credit-cost.ts",
    ];

    for (const relativePath of businessPaths) {
      expect(source(relativePath), relativePath).not.toMatch(/\bisCeRuntime\b/);
    }
  });
});
