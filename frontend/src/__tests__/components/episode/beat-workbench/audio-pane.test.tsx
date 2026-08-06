// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { AudioPane } from "@/components/episode/beat-workbench/audio-pane";
import type { Beat } from "@/types/episode";

const i18n = i18next.createInstance();
const mutateRegenerate = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const navigateMock = vi.hoisted(() => vi.fn());
const audioPrereqErrors = vi.hoisted(() => ({ current: [] as string[] }));

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "zh",
    interpolation: { escapeValue: false },
    resources: {
      zh: {
        translation: {
          common: {
            cancel: "取消",
            confirm: "确认",
            error: "错误",
            regenerate: "重新生成",
          },
          episode: {
            workbench: {
              audio: {
                narrationEmpty: "旁白为空，此 beat 无法生成音频。请先到「文案」填写。",
                generating: "生成中...",
                genFailed: "生成失败",
                notGenerated: "尚未生成",
                regenTitle: "重新生成音频？",
                regenDesc: "将为 Beat #{{n}} 重新生成 TTS 配音。",
                regenerated: "Beat #{{n}} 已重新生成",
                regenFailed: "重生失败",
                configureVoiceAction: "去配置",
                prereqHintCharacters: "。请到「角色」中上传解说主角声线。",
                prereqHintVoices: "。请到「资产 > 声线」上传或裁剪默认解说声线。",
              },
              video: {
                seedance2Ready: "已配置",
                narratorVoice: "解说声线",
                narratorVoiceMissing: "声线缺失",
                narratorVoiceLoading: "正在读取解说声线",
                narratorVoiceLoadFailed: "解说声线读取失败",
                narratorVoiceMissingDetail: "第三人称项目解说声线未配置",
                narratorVoiceUpload: "上传",
                narratorVoiceRecord: "录音",
                narratorVoiceProjectAudio: "项目音频",
                narratorVoiceDelete: "删除",
              },
            },
          },
        },
      },
    },
  });
});

vi.mock("@/lib/queries/audio", () => ({
  useAudioBillingQuote: () => ({
    data: {
      ok: true,
      data: { display: "", prereq_errors: audioPrereqErrors.current },
    },
  }),
  useRegenerateBeatAudio: () => ({
    mutateAsync: mutateRegenerate,
    isPending: false,
  }),
}));

vi.mock("@/hooks/use-task-controller", () => ({
  useTaskController: () => ({
    started: false,
    start: vi.fn(),
  }),
}));

vi.mock("@/lib/queries/video", () => ({
  useNarratorVoiceStatus: () => ({
    data: {
      ok: true,
      data: {
        narration_style: "third_person",
        source: "project_narrator",
        reference_path: "",
        reference_url: "",
        heading: "第三人称项目解说声线",
        detail: "",
        explanation: "第三人称解说使用项目级声线。",
        is_first_person: false,
      },
    },
    isLoading: false,
    isError: false,
  }),
  useNarratorVoiceSources: () => ({
    data: { ok: true, data: { options: [] } },
    isLoading: false,
    isError: false,
  }),
  useUploadNarratorVoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRecordNarratorVoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCopyProjectNarratorVoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteNarratorVoice: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("sonner", () => ({
  toast: { error: toastError, success: vi.fn() },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
    </QueryClientProvider>
  );
}

function makeBeat(overrides: Partial<Beat> = {}): Beat {
  return {
    beat_number: 1,
    narration_segment: "画外音响起。",
    visual_description: "空旷走廊",
    audio_type: "narration",
    audio_url: "",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  audioPrereqErrors.current = [];
  mutateRegenerate.mockResolvedValue({
    ok: true,
    scope: "ep001:beat_01:__narrator__",
  });
});

describe("AudioPane", () => {
  it("uses quote prerequisite errors to avoid submitting an invalid audio task", async () => {
    audioPrereqErrors.current = [
      "Beat 01 解说声线缺失：项目解说人声线已配置，但声线文件无法读取，请重新上传或检查项目存储",
    ];
    const user = userEvent.setup();

    render(
      <Wrapper>
        <AudioPane
          beat={makeBeat()}
          project="demo"
          episode={1}
          state="missing"
          spineTemplate="narrated"
        />
      </Wrapper>,
    );

    await user.click(screen.getByRole("button", { name: "去配置" }));

    expect(mutateRegenerate).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "确认" })).not.toBeInTheDocument();
    expect(toastError).toHaveBeenCalledWith(
      "Beat 01 解说声线缺失：项目解说人声线已配置，但声线文件无法读取，请重新上传或检查项目存储。请到「资产 > 声线」上传或裁剪默认解说声线。",
      expect.objectContaining({
        action: expect.objectContaining({ label: "去配置" }),
      }),
    );
  });

  it("keeps beat voice upload and project narrator voice controls out of drama narration", () => {
    render(
      <Wrapper>
        <AudioPane
          beat={makeBeat()}
          project="demo"
          episode={1}
          state="missing"
          spineTemplate="drama"
        />
      </Wrapper>,
    );

    expect(screen.queryByText("本条解说音频")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "上传本条音频" })).not.toBeInTheDocument();
    expect(screen.queryByText("解说声线")).not.toBeInTheDocument();
  });

  it("hides beat upload and project narrator voice controls for narrated project narration", () => {
    render(
      <Wrapper>
        <AudioPane
          beat={makeBeat()}
          project="demo"
          episode={1}
          state="missing"
          spineTemplate="narrated"
        />
      </Wrapper>,
    );

    expect(screen.queryByText("本条解说音频")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "上传本条音频" })).not.toBeInTheDocument();
    expect(screen.queryByText("解说声线")).not.toBeInTheDocument();
  });

  it("keeps voice controls out of the audio pane when narration text is empty", () => {
    render(
      <Wrapper>
        <AudioPane
          beat={makeBeat({ narration_segment: "" })}
          project="demo"
          episode={1}
          state="missing"
          spineTemplate="narrated"
        />
      </Wrapper>,
    );

    expect(screen.getByText("旁白为空，此 beat 无法生成音频。请先到「文案」填写。")).toBeInTheDocument();
    expect(screen.queryByText("本条解说音频")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "上传本条音频" })).not.toBeInTheDocument();
    expect(screen.queryByText("解说声线")).not.toBeInTheDocument();
  });

  it("does not expose beat voice upload when audio_type is blank narration", () => {
    render(
      <Wrapper>
        <AudioPane
          beat={makeBeat({ audio_type: "" })}
          project="demo"
          episode={1}
          state="missing"
          spineTemplate="drama"
        />
      </Wrapper>,
    );

    expect(screen.queryByText("本条解说音频")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "上传本条音频" })).not.toBeInTheDocument();
    expect(screen.queryByText("解说声线")).not.toBeInTheDocument();
  });

  it("offers a jump to project voice assets when beat audio generation lacks default narrator voice", async () => {
    mutateRegenerate.mockResolvedValueOnce({
      ok: false,
      code: "voice_prereq_required",
      error: "Beat 01 解说声线缺失：项目解说人声线未配置，请上传或录制解说人音频",
    });
    const user = userEvent.setup();

    render(
      <Wrapper>
        <AudioPane
          beat={makeBeat()}
          project="demo"
          episode={1}
          state="missing"
          spineTemplate="narrated"
        />
      </Wrapper>,
    );

    await user.click(screen.getByRole("button", { name: "重新生成" }));
    await user.click(screen.getByRole("button", { name: "确认" }));

    expect(toastError).toHaveBeenCalledWith(
      "Beat 01 解说声线缺失：项目解说人声线未配置，请上传或录制解说人音频。请到「资产 > 声线」上传或裁剪默认解说声线。",
      expect.objectContaining({
        action: expect.objectContaining({ label: "去配置" }),
      }),
    );

    const action = toastError.mock.calls[0][1].action as { onClick: () => void };
    action.onClick();

    expect(window.localStorage.getItem("supertale-asset-tab:demo")).toBe("voices");
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/projects/$project/characters",
      params: { project: "demo" },
    });
  });

  it("offers a jump to characters when first-person narrator protagonist voice is missing", async () => {
    mutateRegenerate.mockResolvedValueOnce({
      ok: false,
      code: "voice_prereq_required",
      error: "Beat 01 解说声线缺失：解说主角声线缺失，请到角色工作台上传角色声线",
    });
    const user = userEvent.setup();

    render(
      <Wrapper>
        <AudioPane
          beat={makeBeat()}
          project="demo project"
          episode={1}
          state="missing"
          spineTemplate="narrated"
        />
      </Wrapper>,
    );

    await user.click(screen.getByRole("button", { name: "重新生成" }));
    await user.click(screen.getByRole("button", { name: "确认" }));

    expect(toastError).toHaveBeenCalledWith(
      "Beat 01 解说声线缺失：解说主角声线缺失，请到角色工作台上传角色声线。请到「角色」中上传解说主角声线。",
      expect.objectContaining({
        action: expect.objectContaining({ label: "去配置" }),
      }),
    );

    const action = toastError.mock.calls[0][1].action as { onClick: () => void };
    action.onClick();

    expect(window.localStorage.getItem("supertale-asset-tab:demo%20project")).toBe("characters");
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/projects/$project/characters",
      params: { project: "demo project" },
    });
  });

  it("keeps regular regeneration errors as plain toasts", async () => {
    mutateRegenerate.mockResolvedValueOnce({
      ok: false,
      error: "TTS 服务暂不可用",
    });
    const user = userEvent.setup();

    render(
      <Wrapper>
        <AudioPane
          beat={makeBeat()}
          project="demo"
          episode={1}
          state="missing"
          spineTemplate="narrated"
        />
      </Wrapper>,
    );

    await user.click(screen.getByRole("button", { name: "重新生成" }));
    await user.click(screen.getByRole("button", { name: "确认" }));

    expect(toastError).toHaveBeenCalledWith(
      "TTS 服务暂不可用",
    );
  });
});
