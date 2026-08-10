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
