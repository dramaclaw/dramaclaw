// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProviderModelPicker } from "@/features/canvas/ui/ProviderModelPicker";
import { videoModelReferenceDisabledReason } from "@/features/canvas/nodes/shared/videoModelCapabilities";
import { zhT } from "../../helpers/i18n-fixtures";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/features/canvas/hooks/useFreezoneImageModels", () => ({
  useFreezoneImageModels: () => ({ models: [], isLoading: false, isFallback: false }),
}));
vi.mock("@/features/canvas/hooks/useFreezoneVideoModels", () => ({
  useFreezoneVideoModels: () => ({ models: [], isLoading: false, isFallback: false }),
}));

describe("video model input tooltip", () => {
  it("previews a guide without selecting, supports touch details and resets on reopen", () => {
    const change = vi.fn();
    const one = { id: "one", apiModel: "one", providerId: "newapi" as const, label: "First" };
    const two = { ...one, id: "two", label: "Second", resolutionOptions: ["720p"],
      pickerGuide: { en: { summary: "Plan a transition", detail: "Use two keyframes", tags: ["Frames"] } } };
    render(<ProviderModelPicker selectedModelId="one" onChange={change} models={[one, two]} />);
    const trigger = screen.getByRole("button", { name: "First" });
    fireEvent.click(trigger, { detail: 1 });
    expect(screen.getByText("Plan a transition")).toBeVisible();
    expect(screen.getByText("Frames")).toBeVisible();
    const second = screen.getByRole("button", { name: "Second" });
    expect(screen.queryByText(/Use two keyframes/)).toBeNull();
    fireEvent.mouseEnter(second);
    expect(screen.getByText("Use two keyframes")).toBeVisible();
    expect(screen.queryByText(/720p/)).not.toBeInTheDocument();
    fireEvent.mouseLeave(second);
    fireEvent.focus(second);
    expect(screen.getByText(/Use two keyframes/)).toBeVisible();
    fireEvent.blur(second);
    fireEvent.click(screen.getByRole("button", { name: "modelPicker.details" }));
    expect(screen.getByText(/Use two keyframes/)).toBeVisible();
    expect(second).toHaveAttribute("aria-pressed", "false");
    expect(change).not.toHaveBeenCalled();
    fireEvent.keyDown(second, { key: "Escape" });
    fireEvent.click(trigger, { detail: 1 });
    expect(screen.queryByText(/Use two keyframes/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Second" }));
    expect(change).toHaveBeenCalledExactlyOnceWith("two");
  });

  it.each(["image", "video"] as const)("shows both %s tags beside the name and only the authored detail in the preview", (domain) => {
    const one = { id: "one", apiModel: "one", providerId: "newapi" as const, label: "Seedream",
      resolutionOptions: ["2K", "4K"] };
    const two = { ...one, id: "two", label: "G25", pickerGuide: { en: {
      summary: "New model for storyboards", detail: "Compare compositions before rendering.", tags: ["-50%", "New"],
    } } };
    render(<ProviderModelPicker domain={domain} selectedModelId={one.id} onChange={vi.fn()} models={[one, two]} />);
    fireEvent.click(screen.getByRole("button", { name: "Seedream" }), { detail: 1 });
    const unguided = screen.getByRole("button", { name: "Seedream", pressed: true });
    fireEvent.mouseEnter(unguided);
    expect(screen.queryByRole("button", { name: "modelPicker.details", expanded: true })).toBeNull();
    const option = screen.getByRole("button", { name: "G25" });
    expect(within(option).getAllByText(/^(?:-50%|New)$/).map(tag => tag.textContent)).toEqual(["-50%", "New"]);
    expect(screen.queryByText("Compare compositions before rendering.")).toBeNull();
    fireEvent.mouseEnter(option);
    const toggle = screen.getByRole("button", { name: "modelPicker.details", expanded: true });
    const preview = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(preview).toBeVisible();
    expect(preview.textContent).toBe(two.pickerGuide.en.detail);
  });

  it.each(["image", "video"] as const)("does not expand a %s summary with specs but no detail", (domain) => {
    const base = { apiModel: "one", providerId: "newapi" as const, resolutionOptions: ["1K", "4K"],
      ratioOptions: ["1:1", "16:9"], minDuration: 5, maxDuration: 30, supportsGenerateAudio: true };
    const models = [
      { ...base, id: "one", label: "First", pickerGuide: { en: { summary: "Just a summary", tags: ["New"] } } },
      { ...base, id: "two", label: "Second", pickerGuide: { en: { detail: "   " } } },
      { ...base, id: "three", label: "Third", pickerGuide: { en: { summary: "Same copy", detail: "Same copy" } } },
    ];
    const { container } = render(<ProviderModelPicker domain={domain} selectedModelId="one" onChange={vi.fn()} models={models} />);
    fireEvent.click(within(container).getByRole("button", { name: "First" }), { detail: 1 });
    const first = screen.getByRole("button", { name: "First", pressed: true });
    const row = (button: HTMLElement) => button.parentElement!.parentElement!;
    expect(first).toHaveAccessibleDescription("New Just a summary");
    const third = screen.getByRole("button", { name: "Third" });
    fireEvent.mouseEnter(third);
    expect(row(third).querySelector('[id$="-detail"]')).toHaveTextContent("Same copy");
    for (const button of [first, screen.getByRole("button", { name: "Second" })]) {
      fireEvent.mouseEnter(button);
      fireEvent.focus(button);
      expect(document.querySelector('[id$="-detail"]')).toBeNull();
      expect(within(row(button)).queryByRole("button", { name: "modelPicker.details" })).toBeNull();
    }
  });

  it("keeps a tags-only model compact even when it has specifications", () => {
    const model = { id: "one", apiModel: "one", providerId: "newapi" as const, label: "Model",
      resolutionOptions: ["2K"], pickerGuide: { en: { tags: ["-50%", "New"] } } };
    render(<ProviderModelPicker selectedModelId={model.id} onChange={vi.fn()} models={[model]} />);
    fireEvent.click(screen.getByRole("button", { name: "Model" }), { detail: 1 });
    const option = screen.getByRole("button", { name: "Model", pressed: true });
    fireEvent.focus(option);
    expect(option).toHaveAccessibleDescription("-50% New");
    expect(screen.queryByRole("button", { name: "modelPicker.details" })).toBeNull();
  });

  it("disables even the selected video-only model, shows the reason and unlocks on connection", () => {
    const depth = {
      id: "depth", providerId: "newapi" as const, label: "Depth Anything Video",
      apiModel: "Depth-Anything-Video", supportedModes: ["video_edit"],
    };
    const onChange = vi.fn();
    let videos = 0;
    const reason = () => {
      const key = videoModelReferenceDisabledReason(depth, { images: 0, videos, audios: 0 });
      return key ? zhT(key) : null;
    };
    const props = { selectedModelId: depth.id, models: [depth], onChange, domain: "video" as const,
      getOptionDisabledReason: reason };
    const { rerender } = render(<ProviderModelPicker {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /Depth Anything Video/ }));
    const option = screen.getAllByRole("button", { name: /Depth Anything Video/ })[1];
    expect(option).toHaveAttribute("aria-disabled", "true");
    fireEvent.mouseEnter(option);
    expect(option).toHaveAccessibleDescription("需要连接视频节点（1个）");
    expect(screen.queryByRole("button", { name: "modelPicker.details" })).toBeNull();
    fireEvent.click(option);
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.mouseLeave(option);
    videos = 1;
    rerender(<ProviderModelPicker {...props} />);
    const enabled = screen.getAllByRole("button", { name: /Depth Anything Video/ })[1];
    expect(enabled).not.toHaveAttribute("aria-disabled");
    fireEvent.click(enabled);
    expect(onChange).toHaveBeenCalledWith("depth");
  });
});
