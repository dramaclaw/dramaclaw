// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import type { AudioNodeData } from "@/features/canvas/domain/canvasNodes";
import { AudioOperationsPanel } from "@/features/canvas/nodes/AudioOperationsPanel";
import { requiresCustomVoiceSelection } from "@/features/canvas/nodes/audioVoicePolicy";
import { createInFlightRequestCache } from "@/features/canvas/nodes/inFlightRequestCache";
import { useCanvasStore } from "@/stores/canvasStore";

vi.mock("@/lib/queries/generation-credit-cost", () => ({
  useGenerationCreditCost: () => ({
    data: { ok: true, data: { display: "1", cost: 1 } },
    error: null,
  }),
}));

vi.mock("@/lib/model-task-access", () => ({
  useModelTaskAccess: () => ({ blocked: false, denialReason: null, message: null }),
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

  it("reloads references after an empty request has settled", async () => {
    let available: string[] = [];
    const load = vi.fn(async () => ({ available: [...available] }));
    const getReferences = createInFlightRequestCache(load);

    expect(await getReferences("project-1")).toEqual({ available: [] });
    available = ["new-voice"];
    expect(await getReferences("project-1")).toEqual({ available: ["new-voice"] });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not auto-open voice selection when custom mode has no usable voice", () => {
    renderPanel({
      audioKind: "speech",
      text: "旁白",
      speechMode: "clone",
      voicePolicyConfirmed: true,
      voiceAvailable: false,
    });

    expect(screen.getByText("尚未选中可用的自定义声线")).toBeTruthy();
    expect(screen.getByRole("button", { name: "选择声线" })).toBeTruthy();
    expect(screen.queryByText("音色选择")).toBeNull();
  });

  it("skips generation when no custom voice is selected", async () => {
    renderPanel({
      audioKind: "speech",
      text: "旁白",
      speechMode: "clone",
      voiceAvailable: false,
    });

    fireEvent.click(screen.getByTitle("生成（未选择自定义声线时跳过）"));
    await waitFor(() => expect(
      useCanvasStore.getState().nodes.find((node) => node.id === "audio-1")?.data.generationError,
    ).toBe("未选择自定义声线，已跳过生成"));
  });

  it("requires a real voice id for a user custom selection", () => {
    expect(requiresCustomVoiceSelection({
      audioUrl: null,
      audioKind: "speech",
      speechMode: "clone",
      voicePolicyConfirmed: true,
      voiceAvailable: true,
      voiceRef: { scope: "user_custom", voiceId: "" },
    })).toBe(true);
  });

  it("reuses a previously selected valid custom voice", () => {
    expect(requiresCustomVoiceSelection({
      audioUrl: null,
      audioKind: "speech",
      speechMode: "clone",
      voicePolicyConfirmed: true,
      voiceAvailable: true,
      voiceRef: { scope: "user_custom", voiceId: "fv_voice_1" },
    })).toBe(false);
  });

  it("does not apply the speech voice prerequisite to music generation", () => {
    renderPanel({
      audioKind: "music",
      text: "紧张的弦乐",
      voiceAvailable: false,
    });

    expect(screen.getByTitle("生成")).toBeTruthy();
    expect(screen.queryByText("请先配置或选择声线")).toBeNull();
    expect(screen.queryByText("音色选择")).toBeNull();
  });

  it("treats legacy system speech as missing custom voice", () => {
    renderPanel({
      audioKind: "speech",
      speechMode: "preset",
      presetVoice: "Serena",
      text: "旁白",
      voiceAvailable: false,
    });

    expect(screen.getByTitle("生成（未选择自定义声线时跳过）")).toBeTruthy();
    expect(screen.getByText("尚未选中可用的自定义声线")).toBeTruthy();
  });
});
