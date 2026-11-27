// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LocalMediaModelEditor } from "@/components/settings/settings-dialog";
import type { MediaModelEntry } from "@/stores/settingsStore";

afterEach(cleanup);
function editor(entry?: MediaModelEntry, comfyOnly = false) {
  const onSave = vi.fn();
  const speech: MediaModelEntry = {
    provider: "doubao_audio",
    mediaType: "audio",
    upstreamModel: "speech",
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <LocalMediaModelEditor
        entry={entry}
        originalModel={entry ? "local-design" : null}
        newApiBaseUrl=""
        database={undefined}
        configuredProviders={["doubao_audio"]}
        models={{ speaker: speech, disabled: { ...speech, enabled: false } }}
        comfyOnly={comfyOnly}
        onCancel={() => {}}
        onSave={onSave}
      />
    </QueryClientProvider>,
  );
  return onSave;
}

async function choose(name: string, choice: string) {
  await userEvent.click(screen.getByRole("combobox", { name }));
  await userEvent.click(await screen.findByRole("option", { name: choice }));
}

it("loads saved audio capabilities without rewriting them as video", async () => {
  const config = {
    request: { endpoint: "audio/speech", parameters: [] },
    voiceDesignMode: "prompted_speech",
  };
  const save = editor({
    mediaType: "audio",
    provider: "doubao_audio",
    upstreamModel: "seed-audio-1.0",
    config,
  });
  expect(screen.getByRole("combobox", { name: "音频用途" })).toHaveTextContent(
    "按描述生成音色",
  );
  await userEvent.click(screen.getByRole("button", { name: "应用到配置" }));
  expect(save).toHaveBeenCalledWith(
    "local-design",
    expect.objectContaining({ mediaType: "audio", config }),
  );
});

it("creates an audio model with prompted speech instead of video capabilities", async () => {
  const save = editor();
  await choose("媒体类型", "音频");
  await choose("音频用途", "按描述生成音色（提示词语音）");
  fireEvent.change(screen.getByLabelText("模型 ID"), {
    target: { value: "seed-audio-1.0" },
  });
  fireEvent.change(screen.getByLabelText("显示名称"), {
    target: { value: "Seed Audio" },
  });
  await userEvent.click(screen.getByRole("button", { name: "应用到配置" }));
  expect(save).toHaveBeenCalledWith(
    "seed-audio-1.0",
    expect.objectContaining({
      mediaType: "audio",
      provider: "doubao_audio",
      config: {
        request: { endpoint: "audio/speech", parameters: [] },
        voiceDesignMode: "prompted_speech",
      },
    }),
  );
});

it("edits an existing audio model and requires a compatible target for voice design", async () => {
  const save = editor({
    mediaType: "audio",
    provider: "doubao_audio",
    upstreamModel: "design",
  });
  await choose("音频用途", "音色设计（绑定合成模型）");
  await userEvent.click(screen.getByRole("button", { name: "应用到配置" }));
  expect(save).not.toHaveBeenCalled();
  await userEvent.click(
    screen.getByRole("combobox", { name: "目标语音合成模型" }),
  );
  expect(
    screen.queryByRole("option", { name: "disabled" }),
  ).not.toBeInTheDocument();
  await userEvent.click(await screen.findByRole("option", { name: "speaker" }));
  await userEvent.click(screen.getByRole("button", { name: "应用到配置" }));
  expect(save).toHaveBeenCalledWith(
    "local-design",
    expect.objectContaining({
      mediaType: "audio",
      config: {
        request: { endpoint: "audio/voice-designs", parameters: [] },
        targetModel: "speaker",
      },
    }),
  );
});
