// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProviderModelPicker } from "@/features/canvas/ui/ProviderModelPicker";
import { videoModelReferenceDisabledReason } from "@/features/canvas/nodes/shared/videoModelCapabilities";
import { zhT } from "../../helpers/i18n-fixtures";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/features/canvas/hooks/useFreezoneImageModels", () => ({
  useFreezoneImageModels: () => ({ models: [], isLoading: false, isFallback: false }),
}));
vi.mock("@/features/canvas/hooks/useFreezoneVideoModels", () => ({
  useFreezoneVideoModels: () => ({ models: [], isLoading: false, isFallback: false }),
}));

describe("video model input tooltip", () => {
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
    expect(screen.getByText("需要连接视频节点（1个）")).toBeInTheDocument();
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
