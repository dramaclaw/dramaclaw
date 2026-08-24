// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { PropAssetCard } from "@/components/assets/prop-asset-card";
import type { PropAsset } from "@/types/prop";

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
            props: {
              reference: "参考图",
              noReference: "未生成参考图",
              noDescription: "暂无描述",
              generateReference: "生成参考图",
              generatingReference: "生成中...",
              regenerateReference: "重生参考图",
              owner: "所属角色",
              types: {
                weapon: "武器",
                accessory: "饰品",
                artifact: "神器/法器",
                document: "文书",
                furniture: "家具",
                object: "其他物件",
              },
            },
          },
        },
      },
    },
    interpolation: { escapeValue: false },
  });
});

function renderCard(prop: PropAsset, overrides = {}) {
  const handlers = {
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onGenerateReference: vi.fn(),
    onUploadReference: vi.fn(),
    onOpenFreezone: vi.fn(),
    ...overrides,
  };
  render(
    <I18nextProvider i18n={i18n}>
      <PropAssetCard prop={prop} {...handlers} />
    </I18nextProvider>,
  );
  return handlers;
}

describe("PropAssetCard", () => {
  it("renders reference image and generate action", () => {
    const handlers = renderCard({
      name: "七星剑",
      aliases: [],
      prop_type: "weapon",
      visual_prompt: "古铜剑柄，剑身刻七星纹",
      description: "",
      owner: "李青",
      notes: "",
      reference_url: "/static/u/p/assets/props/seven-star-sword/reference.png",
    });

    expect(screen.getByText("七星剑")).toBeInTheDocument();
    expect(screen.getByText("武器")).toBeInTheDocument();
    expect(screen.getByText("所属角色：李青")).toBeInTheDocument();
    expect(screen.getByText("参考图 已生成")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重生参考图" })).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: /上传/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /删除参考图/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重生参考图" }));
    expect(handlers.onGenerateReference).toHaveBeenCalledTimes(1);
  });

  it("renders empty reference state", () => {
    renderCard({
      name: "密信",
      aliases: [],
      prop_type: "document",
      visual_prompt: "",
      description: "折叠的牛皮纸密信",
      owner: "",
      notes: "",
    });

    expect(screen.getByText("未生成参考图")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成参考图" })).toBeInTheDocument();
  });

  it("falls back when a convention URL points at a missing file", () => {
    renderCard({
      name: "密信",
      aliases: [],
      prop_type: "document",
      visual_prompt: "",
      description: "折叠的牛皮纸密信",
      owner: "",
      notes: "",
      reference_url: "/static/projects/demo/assets/props/密信/reference_3view.png",
    });

    fireEvent.error(screen.getByAltText("密信 参考图"));

    expect(screen.getByText("未生成参考图")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成参考图" })).toBeInTheDocument();
  });

  it("renders NiceGUI prop type labels instead of raw prop type codes", () => {
    renderCard({
      name: "TOKEN",
      aliases: [],
      prop_type: "artifact",
      visual_prompt: "红色数字、二进制代码和方块粒子构成的发光团",
      description: "",
      owner: "",
      notes: "",
    });

    expect(screen.getByText("神器/法器")).toBeInTheDocument();
    expect(screen.queryByText("artifact")).not.toBeInTheDocument();
  });

  it("renders the NiceGUI visible action row", () => {
    renderCard({
      name: "TOKEN",
      aliases: [],
      prop_type: "artifact",
      visual_prompt: "红色数字、二进制代码和方块粒子构成的发光团",
      description: "",
      owner: "",
      notes: "",
    });

    expect(screen.getByRole("button", { name: "编辑" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "生成参考图" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除" })).toBeInTheDocument();
  });

  it("opens a reference image preview from the card image", () => {
    renderCard({
      name: "七星剑",
      aliases: [],
      prop_type: "weapon",
      visual_prompt: "古铜剑柄，剑身刻七星纹",
      description: "",
      owner: "",
      notes: "",
      reference_url: "/static/u/p/assets/props/seven-star-sword/reference.png",
    });

    fireEvent.click(screen.getByRole("button", { name: "七星剑 参考图" }));

    expect(
      screen.getByRole("link", { name: "Download image" }),
    ).toBeInTheDocument();
    expect(screen.getAllByAltText("七星剑 参考图")).toHaveLength(2);
  });

  it("shows the NiceGUI generating label for single prop reference generation", () => {
    renderCard(
      {
        name: "七星剑",
        aliases: [],
        prop_type: "weapon",
        visual_prompt: "古铜剑柄，剑身刻七星纹",
        description: "",
        owner: "",
        notes: "",
        reference_url: "/static/u/p/assets/props/seven-star-sword/reference.png",
      },
      { generating: true },
    );

    expect(screen.getByRole("button", { name: "生成中..." })).toBeDisabled();
  });

  it("renders the NiceGUI empty description fallback", () => {
    renderCard({
      name: "TOKEN",
      aliases: [],
      prop_type: "artifact",
      visual_prompt: "",
      description: "",
      owner: "",
      notes: "",
    });

    expect(screen.getByText("暂无描述")).toBeInTheDocument();
  });
});
