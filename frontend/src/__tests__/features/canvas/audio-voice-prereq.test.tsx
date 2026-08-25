// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import type { AudioNodeData } from "@/features/canvas/domain/canvasNodes";
import { AudioOperationsPanel } from "@/features/canvas/nodes/AudioOperationsPanel";
import { useCanvasStore } from "@/stores/canvasStore";

vi.mock("@/lib/queries/generation-credit-cost", () => ({
  useGenerationCreditCost: () => ({
    data: { ok: true, data: { display: "1", cost: 1 } },
    error: null,
  }),
}));

function renderPanel(data: Partial<AudioNodeData>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  useCanvasStore.getState().setCanvasData(
    [
      {
        id: "audio-1",
        type: CANVAS_NODE_TYPES.audio,
        position: { x: 0, y: 0 },
        data: { audioUrl: null, ...data },
      },
    ],
    [],
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <AudioOperationsPanel
        nodeId="audio-1"
        data={{ audioUrl: null, ...data }}
      />
    </QueryClientProvider>,
  );
}

describe("AudioOperationsPanel voice prerequisite", () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  it("disables speech generation after references confirm no usable voice", () => {
    renderPanel({
      audioKind: "speech",
      text: "旁白",
      voiceAvailable: false,
    });

    expect(
      (screen.getByTitle("请先配置或选择声线") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText("请先配置或选择声线")).toBeTruthy();
  });

  it("does not apply the speech voice prerequisite to music generation", () => {
    renderPanel({
      audioKind: "music",
      text: "紧张的弦乐",
      voiceAvailable: false,
    });

    expect(screen.getByTitle("生成")).toBeTruthy();
    expect(screen.queryByText("请先配置或选择声线")).toBeNull();
  });
});
