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

vi.mock("@/lib/url-params", async (original) => ({
  ...(await original<typeof import("@/lib/url-params")>()),
  readUrl: () => ({ project: "demo", canvas: "default" }),
}));
vi.mock("@/api/ops", async (original) => ({
  ...(await original<typeof import("@/api/ops")>()),
  fetchAudioCloneModels: async () => [
    { id: "seed-audio-1.0", label: "Seed Audio", model: "seed-audio-1.0", requiresVoiceId: false },
    { id: "index-tts-2", label: "Index", model: "index-tts-2", requiresVoiceId: false },
    { id: "cosyvoice", label: "CosyVoice", model: "cosyvoice", requiresVoiceId: true },
  ],
}));

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

    await screen.findByRole("button", { name: "Seed Audio" });
    fireEvent.click(screen.getByTitle("生成（未选择自定义声线时跳过）"));
    await waitFor(() => expect(
      useCanvasStore.getState().nodes.find((node) => node.id === "audio-1")?.data.generationError,
    ).toBe("未选择自定义声线，已跳过生成"));
  });

  it("prefers Seed and stores the chosen model on the audio node", async () => {
    renderPanel({ audioKind: "speech" });
    const trigger = await screen.findByRole("button", { name: "Seed Audio" });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Seed Audio", pressed: true })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Index" }));
    expect(useCanvasStore.getState().nodes[0].data.cloneModelId).toBe("index-tts-2");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps a removed model unselected and keeps the voice-ID warning outside the toolbar", async () => {
    const panel = renderPanel({ audioKind: "speech", cloneModelId: "removed" });
    const trigger = await screen.findByRole("button", { name: "请选择可用的配音模型" });
    fireEvent.click(trigger);
    expect(screen.queryByRole("button", { pressed: true })).toBeNull();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    panel.unmount();
    renderPanel({ audioKind: "speech", cloneModelId: "cosyvoice" });
    expect((await screen.findByRole("status")).textContent).toContain("音色 ID");
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

  it("does not grant legacy fallback to newly compiled workflow speech", () => {
    expect(requiresCustomVoiceSelection({
      audioUrl: null, audioKind: "speech",
      workflowCatalog: { recipeId: "drama-shot-voice" },
    })).toBe(true);
  });

  it("keeps a saved legacy voice reference without requiring a refreshed availability flag", () => {
    expect(requiresCustomVoiceSelection({
      audioUrl: null, audioKind: "speech", speechMode: "clone",
      voiceRef: { scope: "character_default", characterName: "主角" },
    })).toBe(false);
  });

  it("still rejects an invalid saved custom voice reference", () => {
    expect(requiresCustomVoiceSelection({
      audioUrl: null, voiceRef: { scope: "user_custom", voiceId: "" },
    })).toBe(true);
  });

  it("requires voice selection after converting another node into speech", () => {
    const id = useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.textAnnotation, { x: 0, y: 0 });
    useCanvasStore.getState().convertNodeType(id, CANVAS_NODE_TYPES.audio, { audioKind: "speech" });
    const data = useCanvasStore.getState().nodes.find(node => node.id === id)?.data as AudioNodeData;
    expect(requiresCustomVoiceSelection(data)).toBe(true);
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

  it("retains legacy system speech without a custom voice prerequisite", () => {
    renderPanel({
      audioKind: "speech",
      speechMode: "preset",
      presetVoice: "Serena",
      text: "旁白",
      voiceAvailable: false,
    });

    expect(screen.getByTitle("生成")).toBeTruthy();
    expect(screen.queryByText("尚未选中可用的自定义声线")).toBeNull();
  });
});
