// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { SceneAssetCard } from "@/components/assets/scene-asset-card";
import type { SceneAsset } from "@/types/scene";

import { zhTranslation } from "../../helpers/i18n-fixtures";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "zh",
    resources: { zh: { translation: zhTranslation } },
    interpolation: { escapeValue: false },
  });
});

function renderCard(scene: SceneAsset, overrides = {}) {
  const handlers = {
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onUploadMaster: vi.fn(),
    onGenerateMaster: vi.fn(),
    onDeleteMaster: vi.fn(),
    onGenerateReverse: vi.fn(),
    onUploadPano: vi.fn(),
    onGeneratePano: vi.fn(),
    onDeletePano: vi.fn(),
    onOpenPanoViewer: vi.fn(),
    onOpenStageViewer: vi.fn(),
    onOpenFreezone: vi.fn(),
    onUploadCustomPackage: vi.fn(),
    onDeleteCustomPackage: vi.fn(),
    onGenerateStagePly: vi.fn(),
    singleFaceStageCost: "6",
    panoStageCost: "8",
    ...overrides,
  };
  render(
    <I18nextProvider i18n={i18n}>
      <SceneAssetCard scene={scene} {...handlers} />
    </I18nextProvider>,
  );
  return handlers;
}

describe("SceneAssetCard", () => {
  it("renders master, 360, and active Director World controls", () => {
    const handlers = renderCard({
      name: "皇宫大殿",
      scene_type: "interior",
      environment_prompt: "金色宫灯、朱红立柱、纵深空间",
      description: "",
      aliases: [],
      notes: "",
      master_url: "/static/u/p/assets/scenes/hall/master.png",
      reverse_master_url: "/static/u/p/assets/scenes/hall/reverse_master.png",
      pano_url: "/static/u/p/director_worlds/hall/v1/pano_360.png",
      stage_3gs: {
        stage_dir: "/tmp/director_worlds/hall/v1",
        manifest_ready: true,
        source: "custom_scene",
        active_source: "custom",
        active: {
          ready: true,
          path: "/tmp/director_worlds/hall/v1/custom.sog",
          url: "/static/u/p/director_worlds/hall/v1/custom.sog",
          size_bytes: 1048576,
          size_mb: 1,
        },
        custom: {
          ready: true,
          path: "/tmp/director_worlds/hall/v1/custom.sog",
          url: "/static/u/p/director_worlds/hall/v1/custom.sog",
          size_bytes: 1048576,
          size_mb: 1,
        },
        master: {
          ready: true,
          path: "/tmp/director_worlds/hall/v1/master_sharp.ply",
          url: "/static/u/p/director_worlds/hall/v1/master_sharp.ply",
          size_bytes: 2048,
          size_mb: 0,
        },
        reverse: {
          ready: false,
          path: "",
          url: "",
          size_bytes: 0,
          size_mb: 0,
        },
        pano: {
          ready: true,
          path: "/tmp/director_worlds/hall/v1/pano_depth.ply",
          url: "/static/u/p/director_worlds/hall/v1/pano_depth.ply",
          size_bytes: 4096,
          size_mb: 0,
        },
      },
    });

    expect(screen.getByText("皇宫大殿")).toBeInTheDocument();
    expect(screen.getByText("源图")).toBeInTheDocument();
    expect(screen.getByText("背面")).toBeInTheDocument();
    expect(screen.getByText("360 全景")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上传源图" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重生源图" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重生 背面" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上传/替换 360" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成 360" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除 360" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开360查看器" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开导演世界" })).toBeInTheDocument();
    expect(screen.getByText("导演世界")).toBeInTheDocument();
    expect(screen.queryByText(/当前导演世界/)).not.toBeInTheDocument();
    expect(screen.getByText("自定义导演世界 ✅")).toBeInTheDocument();
    expect(screen.getByText("正面导演世界 ✅")).toBeInTheDocument();
    expect(screen.getByText("360 导演世界 ✅")).toBeInTheDocument();
    expect(screen.queryByText("/tmp/director_worlds/hall/v1")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上传/替换 自定义 包" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除 自定义 包" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "正面→导演世界" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "背面→导演世界" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "360→导演世界" })).toBeInTheDocument();
    expect(screen.queryByText(/voxel/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/DirectorStage/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重生 背面" }));
    expect(handlers.onGenerateReverse).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "生成 360" }));
    expect(handlers.onGeneratePano).toHaveBeenCalledWith("master");

    fireEvent.click(screen.getByRole("button", { name: "删除 360" }));
    expect(handlers.onDeletePano).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "打开360查看器" }));
    expect(handlers.onOpenPanoViewer).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "打开导演世界" }));
    expect(handlers.onOpenStageViewer).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "正面→导演世界" }));
    expect(handlers.onGenerateStagePly).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "场景单面转 SOG，确认后将立即启动任务。",
    );
    expect(screen.getByRole("alertdialog")).toHaveTextContent("6");
    fireEvent.click(screen.getByRole("button", { name: "确认并启动" }));
    expect(handlers.onGenerateStagePly).toHaveBeenCalledWith("master");

    fireEvent.click(screen.getByRole("button", { name: "360→导演世界" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "场景全景转 SOG，确认后将立即启动任务。",
    );
    expect(screen.getByRole("alertdialog")).toHaveTextContent("8");
    fireEvent.click(screen.getByRole("button", { name: "确认并启动" }));
    expect(handlers.onGenerateStagePly).toHaveBeenCalledWith("pano");
  });

  it("disables Director World conversion when the organization price is unavailable", () => {
    renderCard(
      {
        name: "皇宫大殿",
        scene_type: "interior",
        environment_prompt: "",
        description: "",
        aliases: [],
        notes: "",
        master_url: "/static/master.png",
        reverse_master_url: "/static/reverse.png",
        pano_url: "/static/pano.png",
      },
      {
        singleFaceStageCost: "需配置",
        singleFaceStageDisabledReason: "计费规则未配置，请联系管理员设置积分规则",
        panoStageCost: "需配置",
        panoStageDisabledReason: "计费规则未配置，请联系管理员设置积分规则",
      },
    );

    expect(screen.getByRole("button", { name: "正面→导演世界" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "背面→导演世界" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "360→导演世界" })).toBeDisabled();
  });

  it("falls back to text-to-360 when master is missing", () => {
    const handlers = renderCard({
      name: "雨夜巷口",
      scene_type: "exterior",
      environment_prompt: "",
      description: "潮湿的巷口和霓虹灯",
      aliases: [],
      notes: "",
    });

    expect(screen.getByText("未生成 正面图")).toBeInTheDocument();
    expect(screen.getByText("未生成 背面图")).toBeInTheDocument();
    expect(screen.getByText("未生成 360 全景图")).toBeInTheDocument();
    const generate = screen.getByRole("button", { name: "生成 360" });
    fireEvent.click(generate);
    expect(handlers.onGeneratePano).toHaveBeenCalledWith("text");
  });

  it("allows opening Director World even when no scene source exists yet", () => {
    const handlers = renderCard({
      name: "公寓楼家门口",
      scene_type: "exterior",
      environment_prompt: "",
      description: "",
      aliases: [],
      notes: "",
    });

    expect(screen.queryByText(/当前导演世界/)).not.toBeInTheDocument();
    expect(screen.queryByText("导演世界（片场未就绪）")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开导演世界" }));
    expect(handlers.onOpenStageViewer).toHaveBeenCalledOnce();
  });

  it("renders scene type badges in Chinese", () => {
    renderCard({
      name: "雨夜巷口",
      scene_type: "exterior",
      environment_prompt: "",
      description: "",
      aliases: [],
      notes: "",
    });

    expect(screen.getByText("室外")).toBeInTheDocument();
    expect(screen.queryByText("exterior")).not.toBeInTheDocument();
  });
});
