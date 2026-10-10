import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MediaModelParameterChip } from "@/features/canvas/ui/MediaModelParameterChip";

describe("MediaModelParameterChip", () => {
  it("renders the parameter panel as an opaque, scrollable canvas surface", () => {
    const onOpenChange = vi.fn();
    render(
      <MediaModelParameterChip
        mode="text_to_image"
        parameters={[
          {
            key: "stylize",
            label: "风格化（Stylize）",
            control: "number",
            requestPath: "midjourney.stylize",
            min: 0,
            max: 1000,
            modes: ["text_to_image"],
          },
        ]}
        onChange={vi.fn()}
        onOpenChange={onOpenChange}
      />,
    );

    const trigger = screen.getByRole("button", { name: "模型参数" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);

    const panel = screen.getByRole("dialog", { name: "模型参数" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(panel).toHaveClass("bg-surface-dark");
    expect(panel).toHaveClass("overflow-y-auto");
    expect(panel).toHaveClass("max-h-[min(70vh,32rem)]");
    expect(panel).not.toHaveClass("bg-bg-panel");
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    fireEvent.mouseDown(document.body);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("uses the themed listbox for select parameters and preserves typed option values", () => {
    const onChange = vi.fn();
    render(
      <MediaModelParameterChip
        mode="text_to_image"
        parameters={[
          {
            key: "quality",
            label: "质量",
            control: "select",
            requestPath: "midjourney.quality",
            options: [0.5, 1, 2, 4],
            modes: ["text_to_image"],
          },
        ]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "模型参数" }));
    fireEvent.click(screen.getByRole("button", { name: "质量" }));

    const listbox = screen.getByRole("listbox", { name: "质量" });
    expect(listbox).toHaveClass("bg-[var(--ui-surface-panel)]");

    fireEvent.click(screen.getByRole("option", { name: "2" }));
    expect(onChange).toHaveBeenCalledWith({ quality: 2 });
  });

  it("renders multiselect parameters as themed toggle options", () => {
    const onChange = vi.fn();
    render(
      <MediaModelParameterChip
        mode="text_to_image"
        parameters={[
          {
            key: "styles",
            label: "风格",
            control: "multiselect",
            requestPath: "midjourney.styles",
            options: ["cinematic", "raw"],
            modes: ["text_to_image"],
          },
        ]}
        values={{ styles: ["cinematic"] }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "模型参数" }));
    const cinematic = screen.getByRole("checkbox", { name: "cinematic" });
    const raw = screen.getByRole("checkbox", { name: "raw" });
    expect(cinematic).toHaveAttribute("aria-checked", "true");
    expect(raw).toHaveAttribute("aria-checked", "false");

    fireEvent.click(raw);
    expect(onChange).toHaveBeenCalledWith({ styles: ["cinematic", "raw"] });
  });

  it("shows localized Midjourney reference-mode labels", () => {
    render(
      <MediaModelParameterChip
        mode="image_to_image"
        parameters={[
          {
            key: "reference_mode",
            label: "参考方式",
            control: "select",
            requestPath: "midjourney.reference_mode",
            options: ["image_prompt", "style_reference", "edit"],
            default: "image_prompt",
            modes: ["image_to_image"],
          },
        ]}
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "模型参数" }));
    expect(screen.getByRole("button", { name: "参考方式" })).toHaveTextContent("内容参考");
    fireEvent.click(screen.getByRole("button", { name: "参考方式" }));
    expect(screen.getByRole("option", { name: "风格参考" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "图片编辑" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "图片融合" })).not.toBeInTheDocument();
  });
});
