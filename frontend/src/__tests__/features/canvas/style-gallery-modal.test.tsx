// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { FreezoneStyleTemplate } from "@/api/ops";
import { StyleGalleryModal } from "@/features/canvas/ui/StyleGalleryModal";

function makeTemplate(
  id: string,
  label: string,
  category: string,
): FreezoneStyleTemplate {
  return {
    id,
    label,
    category,
    cover: `${id}/cover.webp`,
    samples: [
      `${id}/female.webp`,
      `${id}/youth.webp`,
      `${id}/male.webp`,
      `${id}/elder.webp`,
    ],
    style_prompt: `${label}的提示词第一行\n${label}的提示词第二行`,
  };
}

const TEMPLATES: FreezoneStyleTemplate[] = [
  makeTemplate("golden_age", "黄金时代", "年代"),
  makeTemplate("wuxia", "武侠江湖", "古装"),
];

describe("StyleGalleryModal", () => {
  it("renders one card per template with the bundled cover url", () => {
    render(
      <StyleGalleryModal
        templates={TEMPLATES}
        assetBase=""
        selectedId={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("黄金时代")).toBeInTheDocument();
    expect(screen.getByText("武侠江湖")).toBeInTheDocument();
    expect(screen.getByAltText("黄金时代")).toHaveAttribute(
      "src",
      "/style-gallery/golden_age/cover.webp",
    );
  });

  it("prefixes covers with the configured asset base", () => {
    render(
      <StyleGalleryModal
        templates={TEMPLATES}
        assetBase="https://cdn.example.com/styles"
        selectedId={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByAltText("黄金时代")).toHaveAttribute(
      "src",
      "https://cdn.example.com/styles/golden_age/cover.webp",
    );
  });

  it("selects a style when its card is clicked", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(
      <StyleGalleryModal
        templates={TEMPLATES}
        assetBase=""
        selectedId={null}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    // 精确名匹配,避免命中同卡片上的「查看黄金时代详情」按钮
    await user.click(screen.getByRole("button", { name: "黄金时代" }));

    expect(onSelect).toHaveBeenCalledWith("golden_age");
  });

  it("clears the selection and only offers clearing while something is selected", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    const { rerender } = render(
      <StyleGalleryModal
        templates={TEMPLATES}
        assetBase=""
        selectedId={null}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "清除风格" })).toBeNull();

    rerender(
      <StyleGalleryModal
        templates={TEMPLATES}
        assetBase=""
        selectedId="golden_age"
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "清除风格" }));

    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("opens the detail view with all four samples and the full prompt", async () => {
    const user = userEvent.setup();

    render(
      <StyleGalleryModal
        templates={TEMPLATES}
        assetBase=""
        selectedId={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "查看黄金时代详情" }));

    expect(screen.getByAltText("黄金时代 示例 1")).toHaveAttribute(
      "src",
      "/style-gallery/golden_age/female.webp",
    );
    expect(screen.getByAltText("黄金时代 示例 4")).toHaveAttribute(
      "src",
      "/style-gallery/golden_age/elder.webp",
    );
    expect(
      screen.getByText(/黄金时代的提示词第一行/),
    ).toHaveTextContent("黄金时代的提示词第二行");
  });

  it("uses the style from the detail view", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(
      <StyleGalleryModal
        templates={TEMPLATES}
        assetBase=""
        selectedId={null}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "查看武侠江湖详情" }));
    await user.click(screen.getByRole("button", { name: "使用" }));

    expect(onSelect).toHaveBeenCalledWith("wuxia");
  });

  it("narrows the grid to one category and back", async () => {
    const user = userEvent.setup();

    render(
      <StyleGalleryModal
        templates={TEMPLATES}
        assetBase=""
        selectedId={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "古装" }));

    expect(screen.getByRole("button", { name: "武侠江湖" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "黄金时代" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "全部" }));

    expect(screen.getByRole("button", { name: "黄金时代" })).toBeInTheDocument();
  });

  it("shows a placeholder instead of an empty grid", () => {
    const { rerender } = render(
      <StyleGalleryModal
        templates={[]}
        assetBase=""
        selectedId={null}
        isLoading
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("加载中…")).toBeInTheDocument();

    rerender(
      <StyleGalleryModal
        templates={[]}
        assetBase=""
        selectedId={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("暂无风格模板")).toBeInTheDocument();
  });

  it("returns from the detail view to the gallery", async () => {
    const user = userEvent.setup();

    render(
      <StyleGalleryModal
        templates={TEMPLATES}
        assetBase=""
        selectedId={null}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "查看黄金时代详情" }));
    expect(screen.queryByRole("button", { name: "武侠江湖" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "返回" }));

    expect(screen.getByRole("button", { name: "武侠江湖" })).toBeInTheDocument();
  });
});
