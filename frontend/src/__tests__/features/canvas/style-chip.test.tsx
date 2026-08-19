// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { FreezoneStyleTemplate } from "@/api/ops";
import {
  StyleThumbnail,
  StyleTriggerChip,
} from "@/features/canvas/nodes/StyleChip";

const TEMPLATE: FreezoneStyleTemplate = {
  id: "golden_age",
  label: "黄金时代",
  category: "年代",
  cover: "golden_age/cover.webp",
  samples: ["golden_age/female.webp"],
  style_prompt: "黄金时代的提示词",
};

describe("StyleTriggerChip", () => {
  it("opens the gallery", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();

    render(<StyleTriggerChip onOpen={onOpen} />);

    await user.click(screen.getByRole("button", { name: "风格" }));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  // 「查不到模板」不等于「没选风格」—— 那个 id 照样会跟着生成请求发出去，
  // chip 说成「风格」会让用户以为自己没选，出图带了风格反而像是撞了鬼。
  it.each([
    ["loading" as const, "风格 · 加载中"],
    ["failed" as const, "风格 · 加载失败"],
    ["missing" as const, "风格 · 已失效"],
  ])("tells the truth in the %s state", (state, label) => {
    render(<StyleTriggerChip state={state} onOpen={vi.fn()} />);

    expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
  });

  it("still opens the gallery from a degraded state", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();

    render(<StyleTriggerChip state="failed" onOpen={onOpen} />);

    await user.click(screen.getByRole("button", { name: "风格 · 加载失败" }));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe("StyleThumbnail", () => {
  it("renders the cover and the style name", () => {
    render(
      <StyleThumbnail
        template={TEMPLATE}
        assetBase=""
        onOpen={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    expect(screen.getByAltText("黄金时代")).toHaveAttribute(
      "src",
      "/style-gallery/golden_age/cover.webp",
    );
    // hover 才可见，但文案本身要在 DOM 里
    expect(screen.getByText("黄金时代")).toBeInTheDocument();
  });

  it("prefixes the cover with the configured asset base", () => {
    render(
      <StyleThumbnail
        template={TEMPLATE}
        assetBase="https://cdn.example.com/styles"
        onOpen={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    expect(screen.getByAltText("黄金时代")).toHaveAttribute(
      "src",
      "https://cdn.example.com/styles/golden_age/cover.webp",
    );
  });

  it("reopens the gallery when clicked", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();

    render(
      <StyleThumbnail
        template={TEMPLATE}
        assetBase=""
        onOpen={onOpen}
        onClear={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "风格 黄金时代" }));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("clears the style without reopening the gallery", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const onClear = vi.fn();

    render(
      <StyleThumbnail
        template={TEMPLATE}
        assetBase=""
        onOpen={onOpen}
        onClear={onClear}
      />,
    );

    await user.click(screen.getByRole("button", { name: "清除风格" }));

    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
