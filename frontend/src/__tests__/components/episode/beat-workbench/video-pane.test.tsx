// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { toast } from "sonner";

import {
  shouldDisableDialogueOnlyBackendForBeat,
  VideoPane,
} from "@/components/episode/beat-workbench/video-pane";
import { useAspectRatioStore } from "@/stores/aspect-ratio-store";
import type { Beat } from "@/types/episode";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "zh",
    interpolation: { escapeValue: false },
    resources: {
      zh: {
        translation: {
          common: {
            confirm: "确认",
            cancel: "取消",
            download: "下载",
            regenerate: "重新生成",
            save: "保存",
          },
          episode: {
            workbench: {
              video: {
                started: "Beat #{{n}} 视频已启动",
                regenFailed: "重生失败",
                model: "模型",
                generating: "生成中...",
                genFailed: "生成失败",
                notGenerated: "尚未生成",
                genTitle: "生成视频？",
                genDesc: "已仔细检查参考图与提示词，将为 Beat #{{n}} 生成视频片段。",
                regenTitle: "重新生成视频？",
                regenDesc: "将为 Beat #{{n}} 重新生成视频片段。",
                noteDefault: "默认",
                noteDialogue: "对白镜头",
                switched: "Beat #{{n}} 已切换版本",
                switchFailed: "切换失败",
                seedance2Prompt: "Seedance2.0主体提示词",
                seedance2Ready: "已配置",
                seedance2Missing: "缺失",
                seedance2Saved: "Seedance2 配置已保存",
                seedance2Inspector: "Seedance2 Inspector",
                seedance2PreviewMode: "Seedance2 预览模式",
                mediaStatus: "媒体状态",
                promptStatus: "Prompt 状态",
                videoVersions: "视频版本（{{count}}）",
                renderReady: "Render",
                audioReady: "音频",
                videoReady: "视频",
                seedance2References: "参考素材",
                seedance2Voice: "声线",
                seedance2ReferenceStats: "{{selected}} 已发送 / {{missing}} 缺失",
                seedance2TextOverlay: "画面文字",
                seedance2AtReferences: "@ 引用",
                seedance2MentionCandidates: "引用候选",
                seedance2ReferenceDetails: "参考素材详情",
                seedance2ReferenceSent: "已发送",
                seedance2ReferenceMissing: "缺失",
                seedance2ReferenceFallback: "缺参考图",
                seedance2ReferenceImage: "参考图",
                seedance2ReferenceEmpty: "暂无参考素材",
                seedance2AssetUpload: "上传素材",
                seedance2AssetUploaded: "Seedance2 参考素材已上传",
                seedance2AssetDelete: "删除",
                seedance2AssetDeleted: "Seedance2 参考素材已删除",
                seedance2AssetCrop: "裁剪",
                seedance2AssetCropped: "Seedance2 参考图已裁剪",
                seedance2AssetCropTitle: "裁剪 Seedance2 参考图",
                seedance2AssetAudioTrim: "裁剪音频",
                seedance2AssetAudioTrimTitle: "裁剪 Seedance2 参考音频",
                seedance2AssetAudioTrimHint: "保留 3-5 秒清晰单人声。",
                seedance2AssetAudioTrimStart: "起点",
                seedance2AssetAudioTrimDuration: "时长",
                seedance2AssetAudioTrimApply: "裁剪到 3-5 秒",
                seedance2AssetAudioTrimInvalid: "裁剪参数无效",
                seedance2AssetAudioTrimmed: "Seedance2 参考音频已裁剪",
                seedance2CropWidth: "宽",
                seedance2CropHeight: "高",
                seedance2ModeLabels: {
                  first_frame: "首帧模式",
                  first_last_frame: "首尾帧模式",
                  multimodal_reference: "多参模式",
                },
                mode: "生成模式",
                duration: "时长",
                resolution: "分辨率",
                ratio: "画幅",
                generateAudio: "生成声音",
                returnLastFrame: "返回尾帧",
                returnLastFramePending: "等待生成尾帧",
                humanReview: "真人审核",
                generateVideo: "生成视频",
                preview: {
                  render: "Render",
                  sketch: "草图",
                  audio: "音频",
                  video: "视频",
                },
                previewMissing: {
                  render: "暂无 Render 首帧",
                  sketch: "暂无草图",
                  audio: "暂无音频",
                  video: "暂无视频",
                },
                seedance2PromptGuidance: "自定义提示词",
                seedance2GuidanceSubject: "主体",
                seedance2GuidanceScene: "场景",
                seedance2GuidanceLighting: "光影",
                seedance2GuidanceCamera: "镜头",
                seedance2GuidanceStyle: "风格",
                seedance2SceneOptimizeLabels: {
                  anime: "动漫",
                  realistic: "写实",
                },
                seedance2GeneratePrompt: "AI 优化",
                seedance2PromptGenerated: "Seedance2 Prompt 已优化",
                seedance2PromptGenerateFailed: "Seedance2 Prompt 生成失败",
                videoPrompt: "视频提示词",
                keyframePrompt: "单个 Beat 视频提示词",
                generateBeatVideoPrompt: "生成本 Beat 提示词",
                beatVideoPromptGenerated: "本 Beat 视频提示词已生成",
                beatVideoPromptGenerateStarted: "本 Beat 视频提示词生成已启动",
                beatVideoPromptGenerateFailed: "本 Beat 视频提示词生成失败",
                beatVideoPromptRequired:
                  "Beat #{{n}} 缺少视频提示词，请先点击“生成本 Beat 提示词”。",
                seedance2PromptRequired:
                  "Beat #{{n}} 缺少 Seedance2.0主体提示词，请先填写或点击“AI 优化”。",
                seedance2OverlayEnabled: "启用",
                seedance2OverlayKind: "类型",
                seedance2OverlayKindAdCopy: "广告语",
                seedance2OverlayKindSubtitle: "字幕",
                seedance2OverlayKindSpeechBubble: "气泡台词",
                seedance2OverlayPlacement: "位置",
                seedance2OverlayTiming: "出现时机",
                seedance2OverlayStyle: "文字样式",
                seedance2OverlayContent: "文字内容",
                seedance2OverlaySpeaker: "气泡说话者",
                seedance2OverlaySpeakerNone: "不指定",
                narratorVoice: "解说声线",
                narratorVoiceReady: "解说声线",
                narratorVoiceMissing: "声线缺失",
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

const updateBeatMock: Mock = vi.fn();
const regenerateMock: Mock = vi.fn();
const poolSelectMock: Mock = vi.fn();
const taskStartMock: Mock = vi.fn();
const deleteNarratorVoiceMock: Mock = vi.fn();
const generateSeedance2PromptMock: Mock = vi.fn();
const generateBeatVideoPromptMock: Mock = vi.fn();
const cropSeedance2AssetMock: Mock = vi.fn();
const trimSeedance2AssetMock: Mock = vi.fn();
const videoQueryMockState = vi.hoisted(() => ({
  hideReturnedLastFrame: false,
  includeAudioAsset: false,
  seedance2AssetsOverride: null as Array<Record<string, unknown>> | null,
}));

vi.mock("@/lib/queries/video", () => ({
  useRegenerateBeatVideo: () => ({
    mutateAsync: regenerateMock,
    isPending: false,
  }),
  useUploadSeedance2Asset: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useDeleteSeedance2Asset: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useCropSeedance2Asset: () => ({
    mutateAsync: cropSeedance2AssetMock,
    isPending: false,
  }),
  useTrimSeedance2Asset: () => ({
    mutateAsync: trimSeedance2AssetMock,
    isPending: false,
  }),
  useVideoBackends: () => ({
    data: {
      ok: true,
      data: [
        {
          value: "newapi_seedance-1.0-pro-fast",
          label: "Seedance 1.0 Pro Fast",
          is_default: true,
          is_seedance2: false,
          dialogue_only: false,
          min_duration: 4,
          max_duration: 12,
        },
        {
          value: "newapi_seedance-1.5-pro",
          label: "Seedance 1.5 Pro",
          is_default: false,
          is_seedance2: false,
          dialogue_only: true,
          min_duration: 4,
          max_duration: 12,
        },
        {
          value: "huimeng_seedance-2.0-fast",
          label: "HuiMeng Seedance 2.0 Fast",
          is_default: false,
          is_seedance2: true,
          dialogue_only: false,
          min_duration: 4,
          max_duration: 15,
        },
        {
          value: "newapi_seedance-2.0-fast",
          label: "Seedance2.0 Fast",
          is_default: false,
          is_seedance2: true,
          dialogue_only: false,
          min_duration: 4,
          max_duration: 15,
        },
        {
          value: "newapi_seedance-2.0",
          label: "Seedance2.0",
          is_default: false,
          is_seedance2: true,
          dialogue_only: false,
          min_duration: 4,
          max_duration: 15,
        },
        {
          value: "newapi_seedance-2.0-value",
          label: "Seedance2.0 Value",
          is_default: false,
          is_seedance2: true,
          dialogue_only: false,
          min_duration: 4,
          max_duration: 15,
        },
        {
          value: "newapi_seedance-2.0-fast-value",
          label: "Seedance2.0 Fast Value",
          is_default: false,
          is_seedance2: true,
          dialogue_only: false,
          min_duration: 4,
          max_duration: 15,
        },
      ],
    },
  }),
  useVideoPool: () => ({
    data: {
      ok: true,
      data: {
        episode: 1,
        beat_assignments: { "1": "vid-2" },
        videos: [
          {
            id: "vid-1",
            beat_num: 1,
            video_path: "old.mp4",
            video_url: "/static/old.mp4",
            generated_at: "2026-05-16T09:00:00Z",
            duration: 5,
            video_mode: "first_frame",
            backend: "newapi_seedance-2.0-fast",
            prompt: "old",
          },
          {
            id: "vid-2",
            beat_num: 1,
            video_path: "new.mp4",
            video_url: "/static/new.mp4",
            generated_at: "2026-05-16T10:00:00Z",
            duration: 5,
            video_mode: "first_frame",
            backend: "newapi_seedance-2.0-fast",
            prompt: "new",
          },
        ],
      },
    },
  }),
  useVideoPoolSelect: () => ({
    mutateAsync: poolSelectMock,
    isPending: false,
  }),
  useNarratorVoiceStatus: () => ({
    data: {
      ok: true,
      data: {
        narration_style: "third_person",
        source: "project_narrator",
        reference_path: "assets/narrator/voice.wav",
        reference_url: "/static/demo/assets/narrator/voice.wav",
        reference_sha256: "sha-voice",
        heading: "第三人称项目解说声线",
        detail: "assets/narrator/voice.wav",
        explanation: "第三人称解说使用项目级声线；所有非对白 Beat 使用同一声线。",
        is_first_person: false,
      },
    },
    isLoading: false,
    isError: false,
  }),
  useNarratorVoiceSources: () => ({
    data: {
      ok: true,
      data: {
        options: [
          {
            label: "已生成音频 · beat_01.mp3",
            path: "/project/audio/ep001/beat_01.mp3",
            rel_path: "audio/ep001/beat_01.mp3",
          },
        ],
      },
    },
    isLoading: false,
    isError: false,
  }),
  useUploadNarratorVoice: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useRecordNarratorVoice: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useCopyProjectNarratorVoice: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useDeleteNarratorVoice: () => ({
    mutateAsync: deleteNarratorVoiceMock,
    isPending: false,
  }),
  useGenerateSeedance2Prompt: () => ({
    mutateAsync: generateSeedance2PromptMock,
    isPending: false,
  }),
  useGenerateBeatVideoPrompt: () => ({
    mutateAsync: generateBeatVideoPromptMock,
    isPending: false,
  }),
  useSeedance2BeatStatus: () => ({
    data: {
      ok: true,
      data: {
        beat_number: 1,
        audio_type: "dialogue",
        seedance2_config_json: "",
        media: {
          render_ready: true,
          audio_ready: true,
          video_ready: true,
        },
        voice: {
          required: true,
          ready: true,
          label: "声线就绪",
          detail: "陆辰_青年时期",
          speaker: "陆辰_青年时期",
        },
        prompt: {
          ready: true,
          source: "generated",
          status: "AI 生成",
          has_guidance: true,
          text_overlay_enabled: true,
          text_overlay: {
            enabled: true,
            kind: "caption",
            content: "鹿镇北口",
            placement: "center",
            timing: "auto",
            style: "white text",
          },
          inputs_stale: false,
        },
        assets: {
          total: 5,
          selected: 4,
          missing: 1,
          images: 3,
          audios: 1,
          fallbacks: 1,
          items: (
            videoQueryMockState.seedance2AssetsOverride ?? [
            {
              key: "first_frame",
              label: "当前 render · Beat 1",
              media_type: "image",
              selected: true,
              exists: true,
              reference_label: "图片1",
              note: "多参考模式下作为参考图发送",
              path: "frames/ep001/beat_01.png",
              url: "/static/demo/frames/ep001/beat_01.png",
              crop_source_path: "frames/ep001/beat_01.png",
              can_crop: true,
              can_delete: false,
            },
            {
              key: "manual:image:2",
              label: "手动素材 2",
              media_type: "image",
              selected: true,
              exists: true,
              reference_label: "图片2",
              note: "手动参考图",
              path: "seedance2/manual_02.png",
              url: "/static/demo/seedance2/manual_02.png",
              can_crop: true,
              can_delete: true,
            },
            {
              key: "manual:image:3",
              label: "手动素材 3",
              media_type: "image",
              selected: true,
              exists: true,
              reference_label: "图片3",
              note: "手动参考图",
              path: "seedance2/manual_03.png",
              url: "/static/demo/seedance2/manual_03.png",
              can_crop: true,
              can_delete: true,
            },
            {
              key: "manual:image:4",
              label: "手动素材 4",
              media_type: "image",
              selected: true,
              exists: true,
              reference_label: "图片4",
              note: "手动参考图",
              path: "seedance2/manual_04.png",
              url: "/static/demo/seedance2/manual_04.png",
              can_crop: true,
              can_delete: true,
            },
            {
              key: "manual:image:5",
              label: "手动素材 5",
              media_type: "image",
              selected: true,
              exists: true,
              reference_label: "图片5",
              note: "手动参考图",
              path: "seedance2/manual_05.png",
              url: "/static/demo/seedance2/manual_05.png",
              can_crop: true,
              can_delete: true,
            },
            {
              key: "manual:image:6",
              label: "手动素材 6",
              media_type: "image",
              selected: true,
              exists: true,
              reference_label: "图片6",
              note: "手动参考图",
              path: "seedance2/manual_06.png",
              url: "/static/demo/seedance2/manual_06.png",
              can_crop: true,
              can_delete: true,
            },
            {
              key: "manual:image:7",
              label: "手动素材 7",
              media_type: "image",
              selected: true,
              exists: true,
              reference_label: "图片7",
              note: "手动参考图",
              path: "seedance2/manual_07.png",
              url: "/static/demo/seedance2/manual_07.png",
              can_crop: true,
              can_delete: true,
            },
            {
              key: "returned_last_frame",
              label: "返回尾帧 · Beat 1",
              media_type: "image",
              selected: false,
              exists: true,
              reference_label: "尾帧",
              note: "Seedance2 返回尾帧",
              path: "seedance2/beat_01_last_frame.png",
              url: "/static/demo/seedance2/beat_01_last_frame.png",
              can_crop: false,
              can_delete: false,
            },
            ...(videoQueryMockState.includeAudioAsset
              ? [
                  {
                    key: "voice:narrator",
                    label: "项目解说声线",
                    media_type: "audio",
                    selected: true,
                    exists: true,
                    reference_label: "音频1",
                    note: "Seedance2 解说参考声线",
                    path: "assets/narrator/voice.mp3",
                    url: "/static/demo/assets/narrator/voice.mp3",
                    abs_path: "/project/assets/narrator/voice.mp3",
                    can_crop: false,
                    can_trim: true,
                    can_delete: false,
                  },
                ]
              : []),
            {
              key: "identity:陆辰_青年时期",
              label: "陆辰 · 青年时期",
              media_type: "image",
              selected: false,
              exists: false,
              reference_label: "未发送",
              note: "有图时作为角色身份图保持一致",
            },
          ]).filter(
            (asset) =>
              !videoQueryMockState.hideReturnedLastFrame ||
              asset.key !== "returned_last_frame",
          ),
        },
      },
    },
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("@/lib/queries/scripts", () => ({
  useUpdateBeat: () => ({
    mutateAsync: updateBeatMock,
    isPending: false,
  }),
}));

vi.mock("@/lib/queries/generation-credit-cost", () => ({
  useGenerationCreditCost: (kind: string, value?: string) => ({
    data:
      kind === "feature" && value === "beat_video_prompt"
        ? { ok: true, data: { cost: 5, display: "5" } }
        : kind === "feature" && value === "seedance2_prompt"
          ? { ok: true, data: { cost: 6, display: "6" } }
        : { ok: true, data: { cost: 0, display: null } },
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("@/hooks/use-task-controller", () => ({
  useTaskController: () => ({
    start: taskStartMock,
    started: false,
  }),
}));

vi.mock("@/hooks/use-now", () => ({
  useNow: () => new Date("2026-05-16T10:30:00Z"),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function makeBeat(overrides: Partial<Beat> = {}): Beat {
  return {
    beat_number: 1,
    narration_segment: "旁白",
    visual_description: "画面",
    audio_type: "narration",
    video_mode: "first_frame",
    detected_identities: ["陆辰_青年时期"],
    video_prompt: "base video prompt",
    keyframe_prompt: "",
    frame_url: "/static/frame.png",
    audio_url: "/static/audio.mp3",
    video_url: "/static/new.mp4",
    seedance2_config_json: JSON.stringify({
      mode: "multimodal_reference",
      duration: 5,
      resolution: "720p",
      ratio: "9:16",
      generate_audio: false,
      return_last_frame: false,
      human_review: false,
      prompt_source: "generated",
      final_prompt: "existing seedance2 prompt",
      text_overlay: {
        enabled: false,
        kind: "caption",
        content: "",
        placement: "center",
        timing: "auto",
        style: "",
      },
    }),
    ...overrides,
  };
}

function renderPane(
  beat: Beat = makeBeat(),
  options: { showAudioMediaStatus?: boolean; defaultBackend?: string } = {},
) {
  return render(
    <I18nextProvider i18n={i18n}>
      <VideoPane
        beat={beat}
        project="demo"
        episode={1}
        state="ready"
        defaultBackend={options.defaultBackend ?? "huimeng_seedance-2.0-fast"}
        showAudioMediaStatus={options.showAudioMediaStatus}
      />
    </I18nextProvider>,
  );
}

beforeEach(() => {
  videoQueryMockState.hideReturnedLastFrame = false;
  videoQueryMockState.includeAudioAsset = false;
  videoQueryMockState.seedance2AssetsOverride = null;
  useAspectRatioStore.getState().reset();
  updateBeatMock.mockReset();
  updateBeatMock.mockResolvedValue({ ok: true, data: makeBeat() });
  regenerateMock.mockReset();
  regenerateMock.mockResolvedValue({ ok: true, task_id: "task-1" });
  poolSelectMock.mockReset();
  taskStartMock.mockReset();
  deleteNarratorVoiceMock.mockReset();
  deleteNarratorVoiceMock.mockResolvedValue({ ok: true, data: {} });
  cropSeedance2AssetMock.mockReset();
  cropSeedance2AssetMock.mockResolvedValue({ ok: true, data: {} });
  trimSeedance2AssetMock.mockReset();
  trimSeedance2AssetMock.mockResolvedValue({ ok: true, data: {} });
  generateSeedance2PromptMock.mockReset();
  generateSeedance2PromptMock.mockResolvedValue({
    ok: true,
    data: {
      final_prompt: "optimized seedance2 prompt",
      seedance2_config_json: JSON.stringify({
        mode: "first_frame",
        duration: 5,
        resolution: "720p",
        ratio: "9:16",
        generate_audio: false,
        return_last_frame: false,
        human_review: false,
        prompt_guidance: "more camera motion",
        prompt_source: "generated",
        final_prompt: "optimized seedance2 prompt",
      }),
      beat: makeBeat({
        seedance2_config_json: JSON.stringify({
          prompt_guidance: "more camera motion",
          prompt_source: "generated",
          final_prompt: "optimized seedance2 prompt",
        }),
      }),
    },
  });
  generateBeatVideoPromptMock.mockReset();
  generateBeatVideoPromptMock.mockResolvedValue({
    ok: true,
    data: {
      field: "video_prompt",
      prompt: "generated 1.x motion prompt",
      beat: makeBeat({ video_prompt: "generated 1.x motion prompt" }),
    },
  });
});

async function waitForSeedance2Autosave(times = 1) {
  await waitFor(() => expect(updateBeatMock).toHaveBeenCalledTimes(times), {
    timeout: 2000,
  });
}

function expandSeedance2References() {
  const trigger = screen.getByRole("button", { name: /参考素材详情/ });
  if (trigger.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(trigger);
  }
}

describe("VideoPane Seedance2 inspector", () => {
  it("renders and saves the 1.x video prompt while showing image-only reference details", () => {
    videoQueryMockState.includeAudioAsset = true;
    renderPane(
      makeBeat({
        video_mode: "first_frame",
        video_prompt: "base video prompt",
      }),
      { defaultBackend: "newapi_seedance-1.0-pro-fast" },
    );

    expect(screen.queryByText("Seedance2 Inspector")).not.toBeInTheDocument();
    expect(screen.getByLabelText("视频提示词")).toHaveValue("base video prompt");
    expect(screen.getByRole("button", { name: /参考素材详情/ })).toBeInTheDocument();
    expect(screen.getByText("当前 render · Beat 1")).toBeInTheDocument();
    expect(screen.queryByText("手动素材 2")).not.toBeInTheDocument();
    expect(screen.queryByText("项目解说声线")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "上传素材" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("生成模式")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("视频提示词"), {
      target: { value: "updated motion prompt" },
    });
    fireEvent.blur(screen.getByLabelText("视频提示词"));

    expect(updateBeatMock).toHaveBeenCalledWith({
      beatNum: 1,
      data: { video_prompt: "updated motion prompt" },
    });
  });

  it("uses a 9:16 video-input crop for 1.x when the project aspect is 2:3", async () => {
    const user = userEvent.setup();
    renderPane(
      makeBeat({
        video_mode: "first_frame",
        video_prompt: "base video prompt",
      }),
      { defaultBackend: "newapi_seedance-1.0-pro-fast" },
    );
    expandSeedance2References();

    await user.click(screen.getAllByRole("button", { name: "裁剪" })[0]);

    expect(await screen.findByText("裁剪 9:16")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "2:3" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "16:9" })).not.toBeInTheDocument();
  });

  it("generates a single 1.x beat video prompt from the video pane", async () => {
    const user = userEvent.setup();
    renderPane(
      makeBeat({ video_mode: "first_frame", video_prompt: "" }),
      { defaultBackend: "newapi_seedance-1.0-pro-fast" },
    );

    const promptButton = screen.getByRole("button", {
      name: "生成本 Beat 提示词",
    });
    expect(promptButton).toHaveTextContent("5");
    await user.click(promptButton);

    expect(generateBeatVideoPromptMock).toHaveBeenCalledWith({ beatNum: 1 });
    expect(screen.getByLabelText("视频提示词")).toHaveValue(
      "generated 1.x motion prompt",
    );
  });

  it("treats async 1.x beat video prompt task startup as success", async () => {
    const user = userEvent.setup();
    generateBeatVideoPromptMock.mockResolvedValueOnce({
      ok: true,
      task_type: "beat_video_prompt",
      task_id: "task-prompt-1",
      task_key: "task:beat_video_prompt:project:proj_123:1:beat:1",
      message: "第 1 集 Beat 1 提示词生成已入队",
    });
    renderPane(
      makeBeat({ video_mode: "first_frame", video_prompt: "" }),
      { defaultBackend: "newapi_seedance-1.0-pro-fast" },
    );

    await user.click(screen.getByRole("button", { name: "生成本 Beat 提示词" }));

    expect(generateBeatVideoPromptMock).toHaveBeenCalledWith({ beatNum: 1 });
    expect(screen.getByLabelText("视频提示词")).toHaveValue("");
    expect(toast.success).toHaveBeenCalledWith(
      "本 Beat 视频提示词生成已启动",
    );
    expect(toast.error).not.toHaveBeenCalledWith(
      "本 Beat 视频提示词生成失败",
    );
  });

  it("renders keyframe prompt editing for 1.x keyframe beats", () => {
    renderPane(
      makeBeat({
        video_mode: "keyframe",
        video_prompt: "first frame prompt",
        keyframe_prompt: "transition prompt",
      }),
      { defaultBackend: "newapi_seedance-1.0-pro-fast" },
    );

    expect(screen.getByLabelText("单个 Beat 视频提示词")).toHaveValue(
      "transition prompt",
    );

    fireEvent.change(screen.getByLabelText("单个 Beat 视频提示词"), {
      target: { value: "updated transition prompt" },
    });
    fireEvent.blur(screen.getByLabelText("单个 Beat 视频提示词"));

    expect(updateBeatMock).toHaveBeenCalledWith({
      beatNum: 1,
      data: { keyframe_prompt: "updated transition prompt" },
    });
  });

  it("does not show legacy 1.x prompt controls for Seedance2 backends", () => {
    renderPane(makeBeat());

    expect(screen.getByText("Seedance2 Inspector")).toBeInTheDocument();
    expect(screen.queryByLabelText("视频提示词")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("单个 Beat 视频提示词")).not.toBeInTheDocument();
  });

  it("blocks 1.x video generation when the beat video prompt is empty", async () => {
    const user = userEvent.setup();
    renderPane(
      makeBeat({ video_url: null, video_mode: "first_frame", video_prompt: "" }),
      { defaultBackend: "newapi_seedance-1.0-pro-fast" },
    );

    await user.click(screen.getByRole("button", { name: "重新生成" }));

    expect(toast.error).toHaveBeenCalledWith(
      "Beat #1 缺少视频提示词，请先点击“生成本 Beat 提示词”。",
    );
    expect(screen.queryByText("生成视频？")).not.toBeInTheDocument();
    expect(regenerateMock).not.toHaveBeenCalled();
  });

  it("blocks Seedance2 video generation when final prompt is empty", async () => {
    const user = userEvent.setup();
    renderPane(
      makeBeat({
        video_url: null,
        seedance2_config_json: JSON.stringify({
          mode: "multimodal_reference",
          duration: 5,
          resolution: "720p",
          ratio: "9:16",
          final_prompt: "",
        }),
      }),
    );

    await user.click(screen.getAllByRole("button", { name: "重新生成" })[0]);

    expect(toast.error).toHaveBeenCalledWith(
      "Beat #1 缺少 Seedance2.0主体提示词，请先填写或点击“AI 优化”。",
    );
    expect(screen.queryByText("生成视频？")).not.toBeInTheDocument();
    expect(regenerateMock).not.toHaveBeenCalled();
  });

  it("surfaces backend validation errors for single beat video generation", async () => {
    const user = userEvent.setup();
    regenerateMock.mockResolvedValueOnce({
      ok: false,
      error: "Beat 1 不是 dialogue，Seedance 1.5 有声只允许用于 dialogue beat",
    });
    renderPane();

    await user.click(screen.getAllByRole("button", { name: "重新生成" })[0]);
    await user.click(screen.getByRole("button", { name: "确认" }));

    expect(toast.error).toHaveBeenCalledWith(
      "Beat 1 不是 dialogue，Seedance 1.5 有声只允许用于 dialogue beat",
    );
    expect(taskStartMock).not.toHaveBeenCalled();
  });

  it("saves the current Seedance2 draft before regenerating video", async () => {
    const user = userEvent.setup();
    renderPane();

    fireEvent.change(screen.getByLabelText("Seedance2.0主体提示词"), {
      target: { value: "draft prompt used for generation" },
    });
    fireEvent.change(screen.getByLabelText("时长"), {
      target: { value: "8" },
    });
    await user.click(screen.getAllByRole("button", { name: "重新生成" })[0]);
    await user.click(screen.getByRole("button", { name: "确认" }));

    await waitFor(() => expect(updateBeatMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(regenerateMock).toHaveBeenCalledTimes(1));
    expect(updateBeatMock.mock.invocationCallOrder[0]).toBeLessThan(
      regenerateMock.mock.invocationCallOrder[0],
    );
    const payload = updateBeatMock.mock.calls[0][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config).toMatchObject({
      final_prompt: "draft prompt used for generation",
      duration: 8,
    });
  });

  it("clamps Seedance2 duration to the selected backend bounds before saving", async () => {
    const user = userEvent.setup();
    renderPane();

    const durationInput = screen.getByLabelText("时长");
    expect(durationInput).toHaveAttribute("min", "4");
    expect(durationInput).toHaveAttribute("max", "15");

    fireEvent.change(durationInput, {
      target: { value: "3" },
    });
    await user.click(screen.getAllByRole("button", { name: "重新生成" })[0]);
    await user.click(screen.getByRole("button", { name: "确认" }));

    await waitFor(() => expect(updateBeatMock).toHaveBeenCalledTimes(1));
    const payload = updateBeatMock.mock.calls[0][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config.duration).toBe(4);
  });

  it("disables dialogue-only backends by the current beat audio type", () => {
    const dialogueOnlyBackend = {
      value: "seedance_pro",
      label: "Seedance 1.5 有声",
      is_default: false,
      is_seedance2: false,
      dialogue_only: true,
    };

    expect(
      shouldDisableDialogueOnlyBackendForBeat(
        dialogueOnlyBackend,
        makeBeat({ audio_type: "dialogue" }),
      ),
    ).toBe(false);
    expect(
      shouldDisableDialogueOnlyBackendForBeat(
        dialogueOnlyBackend,
        makeBeat({ audio_type: "narration" }),
      ),
    ).toBe(true);
  });

  it("renders Seedance2 media, config, and version status", () => {
    renderPane();

    expect(screen.getByText("Seedance2 Inspector")).toBeInTheDocument();
    expect(screen.queryByText("媒体状态")).not.toBeInTheDocument();
    expect(screen.queryByText("Prompt 状态")).not.toBeInTheDocument();
    expect(screen.queryByText("配置状态")).not.toBeInTheDocument();
    expect(screen.getByText("视频版本（2）")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /参考素材详情/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("图片1")).toBeInTheDocument();
    expect(screen.getByText("手动素材 7")).toBeInTheDocument();
    expect(screen.getByText("当前 render · Beat 1")).toBeInTheDocument();
    expect(screen.getByText("陆辰 · 青年时期")).toBeInTheDocument();
    expect(screen.getByText("有图时作为角色身份图保持一致")).toBeInTheDocument();
    expect(screen.getByText("参考图")).toBeInTheDocument();
    expect(screen.getByText("缺参考图")).toBeInTheDocument();
    expect(screen.queryByText("未发送")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上传素材" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "插入引用" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "裁剪" }).length).toBeGreaterThan(0);
    expect(screen.getByText("声线就绪")).toBeInTheDocument();
    expect(screen.getAllByText("4 已发送 / 1 缺失").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "画面文字" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Seedance2 预览模式" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "音频" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Render").length).toBeGreaterThan(0);
    expect(screen.getAllByText("已配置").length).toBeGreaterThan(0);
  });

  it("renders a single Seedance2 video generation action", () => {
    renderPane(makeBeat({ beat_number: 2, video_url: null }));

    expect(screen.getAllByRole("button", { name: "生成视频" })).toHaveLength(1);
  });

  it("shows image thumbnails in the Seedance2 reference details", () => {
    renderPane();
    expandSeedance2References();

    expect(screen.getByAltText("当前 render · Beat 1")).toHaveAttribute(
      "src",
      "/static/demo/frames/ep001/beat_01.png",
    );
    expect(screen.getByAltText("手动素材 2")).toHaveAttribute(
      "src",
      "/static/demo/seedance2/manual_02.png",
    );
    expect(
      screen.getByAltText("手动素材 2").closest("[data-seedance2-reference-tile]"),
    ).toHaveClass("aspect-square", "w-[6.75rem]");
    expect(
      screen.getByAltText("手动素材 2").closest("[data-seedance2-reference-tile]")?.parentElement,
    ).toHaveClass("grid-cols-[repeat(auto-fill,minmax(6.75rem,6.75rem))]");
    expect(screen.getByAltText("手动素材 2")).toHaveClass("object-cover");
  });

  it("hides the audio media status when disabled for drama projects", () => {
    renderPane(makeBeat(), { showAudioMediaStatus: false });

    expect(screen.getAllByText("Render").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "音频" })).not.toBeInTheDocument();
  });

  it("shows readable backend labels on video version thumbnails", () => {
    renderPane();

    expect(screen.getAllByText("Seedance2.0 Fast").length).toBeGreaterThan(0);
    expect(screen.queryByText("newapi_seedance-2.0-fast")).not.toBeInTheDocument();
  });

  it("shows scene optimize styles only for Seedance2 value models", async () => {
    const user = userEvent.setup();
    renderPane(makeBeat({ seedance2_config_json: "" }), {
      defaultBackend: "newapi_seedance-2.0-value",
    });

    expect(screen.getByRole("radiogroup", { name: "风格" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "动漫" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(screen.getByRole("radio", { name: "写实" }));
    await waitForSeedance2Autosave();

    const payload =
      updateBeatMock.mock.calls[updateBeatMock.mock.calls.length - 1][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config.scene_optimize).toBe("realistic");
  });

  it("uses model-specific Seedance2 resolution options", async () => {
    const user = userEvent.setup();
    renderPane(makeBeat({ seedance2_config_json: "" }), {
      defaultBackend: "newapi_seedance-2.0",
    });

    await user.click(screen.getByRole("combobox", { name: "分辨率" }));
    expect(await screen.findByRole("option", { name: "480p" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "720p" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "1080p" })).toBeInTheDocument();
  });

  it("hides unsupported Seedance2 value resolution options", async () => {
    const user = userEvent.setup();
    renderPane(makeBeat({ seedance2_config_json: "" }), {
      defaultBackend: "newapi_seedance-2.0-value",
    });

    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "动漫" })).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
    await user.click(screen.getByLabelText("分辨率"));
    expect(await screen.findByRole("option", { name: "720p" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "480p" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "1080p" })).toBeInTheDocument();
  });

  it("normalizes unsupported saved Seedance2 value resolution", async () => {
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          resolution: "480p",
          final_prompt: "existing seedance2 prompt",
        }),
      }),
      { defaultBackend: "newapi_seedance-2.0-value" },
    );

    await waitForSeedance2Autosave();

    const payload =
      updateBeatMock.mock.calls[updateBeatMock.mock.calls.length - 1][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config.resolution).toBe("720p");
  });

  it("normalizes Seedance2 resolution before generation after backend switches", async () => {
    const user = userEvent.setup();
    const beat = makeBeat({
      seedance2_config_json: JSON.stringify({
        mode: "multimodal_reference",
        duration: 5,
        resolution: "1080p",
        ratio: "9:16",
        final_prompt: "existing seedance2 prompt",
      }),
    });
    const view = renderPane(beat, {
      defaultBackend: "newapi_seedance-2.0",
    });

    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VideoPane
          beat={beat}
          project="demo"
          episode={1}
          state="ready"
          defaultBackend="newapi_seedance-2.0-fast"
        />
      </I18nextProvider>,
    );
    await user.click(screen.getAllByRole("button", { name: "重新生成" })[0]);
    await user.click(screen.getByRole("button", { name: "确认" }));

    await waitFor(() => expect(regenerateMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(updateBeatMock).toHaveBeenCalled());
    const saveBeforeRegenerateIndex = updateBeatMock.mock.invocationCallOrder.findIndex(
      (order) => order < regenerateMock.mock.invocationCallOrder[0],
    );
    expect(saveBeforeRegenerateIndex).toBeGreaterThanOrEqual(0);
    const payload = updateBeatMock.mock.calls[saveBeforeRegenerateIndex][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config.resolution).toBe("720p");
    expect(updateBeatMock.mock.invocationCallOrder[saveBeforeRegenerateIndex]).toBeLessThan(
      regenerateMock.mock.invocationCallOrder[0],
    );
  });

  it("hides scene optimize styles for non-value Seedance2 models", () => {
    renderPane();

    expect(screen.queryByRole("radiogroup", { name: "风格" })).not.toBeInTheDocument();
  });

  it("does not expose raw Seedance2 mode names in the Seedance2 controls", () => {
    renderPane();

    expect(screen.getAllByText("已配置").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("生成模式")).toHaveTextContent("多参模式");
    expect(screen.queryByText("multimodal_reference")).not.toBeInTheDocument();
  });

  it("uses first-generation confirmation copy when the beat has no video", async () => {
    const user = userEvent.setup();
    renderPane(makeBeat({ beat_number: 2, video_url: null }));

    await user.click(screen.getAllByRole("button", { name: "生成视频" })[0]);

    expect(screen.getByText("生成视频？")).toBeInTheDocument();
    expect(
      screen.getByText("已仔细检查参考图与提示词，将为 Beat #2 生成视频片段。"),
    ).toBeInTheDocument();
    expect(screen.queryByText("重新生成视频？")).not.toBeInTheDocument();
  });

  it("uses the Seedance2 configured ratio for multimodal image asset crops", async () => {
    const user = userEvent.setup();
    useAspectRatioStore.getState().setOrientation("demo", "landscape");
    renderPane();
    expandSeedance2References();

    await user.click(screen.getAllByRole("button", { name: "裁剪" })[0]);
    expect(await screen.findByText("裁剪 9:16")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "16:9" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("X")).not.toBeInTheDocument();

    const image = screen
      .getAllByAltText("当前 render · Beat 1")
      .find((element) => element.closest('[role="dialog"]'));
    if (!image) throw new Error("crop image not found");
    Object.defineProperty(image, "naturalWidth", {
      configurable: true,
      value: 569,
    });
    Object.defineProperty(image, "naturalHeight", {
      configurable: true,
      value: 839,
    });
    fireEvent.load(image);

    await waitFor(() => {
      expect(screen.getByLabelText("移动裁剪区域")).toHaveStyle({
        left: "8.611599297012302%",
        top: "0%",
        width: "82.95254833040421%",
        height: "100%",
      });
    });

    const cropButtons = screen.getAllByRole("button", { name: "裁剪" });
    await user.click(cropButtons[cropButtons.length - 1]);
    expect(cropSeedance2AssetMock).toHaveBeenCalledWith({
      beatNum: 1,
      assetKey: "first_frame",
      sourcePath: "frames/ep001/beat_01.png",
      target: "reference_image",
      crop: { x: 49, y: 0, width: 472, height: 839 },
    });
  });

  it("maps 2:3 first-frame Seedance2 crops to 9:16 video input", async () => {
    const user = userEvent.setup();
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          mode: "first_frame",
          mode_user_set: true,
          final_prompt: "wide video prompt",
          ratio: "16:9",
        }),
      }),
    );
    expandSeedance2References();

    await user.click(screen.getAllByRole("button", { name: "裁剪" })[0]);
    expect(await screen.findByText("裁剪 9:16")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "16:9" })).not.toBeInTheDocument();

    const image = screen
      .getAllByAltText("当前 render · Beat 1")
      .find((element) => element.closest('[role="dialog"]'));
    if (!image) throw new Error("crop image not found");
    Object.defineProperty(image, "naturalWidth", {
      configurable: true,
      value: 569,
    });
    Object.defineProperty(image, "naturalHeight", {
      configurable: true,
      value: 839,
    });
    fireEvent.load(image);

    await waitFor(() => {
      expect(screen.getByLabelText("移动裁剪区域")).toHaveStyle({
        left: "8.611599297012302%",
        top: "0%",
        width: "82.95254833040421%",
        height: "100%",
      });
    });

    const cropButtons = screen.getAllByRole("button", { name: "裁剪" });
    await user.click(cropButtons[cropButtons.length - 1]);
    expect(cropSeedance2AssetMock).toHaveBeenCalledWith({
      beatNum: 1,
      assetKey: "first_frame",
      sourcePath: "frames/ep001/beat_01.png",
      target: "first_frame",
      crop: { x: 49, y: 0, width: 472, height: 839 },
    });
  });

  it("keeps using the original render as crop source after a video-input override exists", async () => {
    const user = userEvent.setup();
    videoQueryMockState.seedance2AssetsOverride = [
      {
        key: "first_frame",
        label: "当前 render · Beat 1",
        media_type: "image",
        selected: true,
        exists: true,
        reference_label: "图片1",
        note: "首帧模式只发送这一张首帧图，不混用参考图。",
        path: "video_inputs/ep001/beat_01/first_frame.png",
        url: "/static/demo/video_inputs/ep001/beat_01/first_frame.png",
        abs_path: "/project/video_inputs/ep001/beat_01/first_frame.png",
        crop_source_path: "frames/ep001/beat_01.png",
        crop_source_abs_path: "/project/frames/ep001/beat_01.png",
        crop_source_url: "/static/demo/frames/ep001/beat_01.png",
        can_crop: true,
        can_delete: false,
      },
    ];
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          mode: "first_frame",
          mode_user_set: true,
          final_prompt: "wide video prompt",
        }),
      }),
    );
    expandSeedance2References();

    await user.click(screen.getAllByRole("button", { name: "裁剪" })[0]);
    await screen.findByRole("dialog");
    const cropImage = screen
      .getAllByAltText("当前 render · Beat 1")
      .find((element) => element.closest('[role="dialog"]'));
    if (!cropImage) throw new Error("crop image not found");
    expect(cropImage).toHaveAttribute("src", "/static/demo/frames/ep001/beat_01.png");
    const cropButtons = await screen.findAllByRole("button", { name: "裁剪" });
    await user.click(cropButtons[cropButtons.length - 1]);

    expect(cropSeedance2AssetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assetKey: "first_frame",
        target: "first_frame",
        sourcePath: "/project/frames/ep001/beat_01.png",
      }),
    );
  });

  it("keeps 16:9 first-frame Seedance2 crops at 16:9 video input", async () => {
    const user = userEvent.setup();
    useAspectRatioStore.getState().setOrientation("demo", "landscape");
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          mode: "first_frame",
          mode_user_set: true,
          final_prompt: "wide video prompt",
          ratio: "9:16",
        }),
      }),
    );
    expandSeedance2References();

    await user.click(screen.getAllByRole("button", { name: "裁剪" })[0]);
    expect(await screen.findByText("裁剪 16:9")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "9:16" })).not.toBeInTheDocument();
  });

  it("allows trimming Seedance2 audio reference assets", async () => {
    const user = userEvent.setup();
    videoQueryMockState.includeAudioAsset = true;
    renderPane();
    expandSeedance2References();

    const audioTile = screen
      .getByText("项目解说声线")
      .closest("[data-seedance2-reference-tile]");
    if (!audioTile) throw new Error("audio tile not found");
    await user.click(within(audioTile as HTMLElement).getByRole("button", { name: "裁剪" }));
    await user.click(screen.getByRole("button", { name: "裁剪到 3-5 秒" }));

    expect(trimSeedance2AssetMock).toHaveBeenCalledWith({
      beatNum: 1,
      assetKey: "voice:narrator",
      sourcePath: "/project/assets/narrator/voice.mp3",
      startSeconds: 0,
      durationSeconds: 4,
    });
  });

  it("autosaves prompt and basic Seedance2 config as one JSON patch", async () => {
    renderPane();

    fireEvent.change(screen.getByLabelText("Seedance2.0主体提示词"), {
      target: { value: "new seedance2 prompt" },
    });
    fireEvent.change(screen.getByLabelText("时长"), {
      target: { value: "8" },
    });
    await waitForSeedance2Autosave();

    const payload = updateBeatMock.mock.calls[0][0];
    expect(payload.beatNum).toBe(1);
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config).toMatchObject({
      final_prompt: "new seedance2 prompt",
      duration: 8,
      generate_audio: true,
      generate_audio_user_set: false,
      human_review: true,
      mode: "multimodal_reference",
      resolution: "720p",
      ratio: "9:16",
    });
    expect(screen.queryByRole("checkbox", { name: "生成声音" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "真人审核" })).not.toBeInTheDocument();
  });

  it("autosave keeps the trailing space left by an inserted @mention", async () => {
    renderPane(makeBeat({ seedance2_config_json: "" }));

    fireEvent.change(screen.getByLabelText("Seedance2.0主体提示词"), {
      target: { value: "@图片1 @图片2 " },
    });
    await waitForSeedance2Autosave();

    const payload = updateBeatMock.mock.calls[0][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    // The trailing separator must survive the save → re-parse → draft-reset
    // round-trip, otherwise the next reference glues onto the last one.
    expect(config.final_prompt).toBe("@图片1 @图片2 ");
  });

  it("defaults new Seedance2 drafts to the project render aspect", async () => {
    useAspectRatioStore.getState().setOrientation("demo", "landscape");
    renderPane(makeBeat({ seedance2_config_json: "" }));

    fireEvent.change(screen.getByLabelText("Seedance2.0主体提示词"), {
      target: { value: "new landscape prompt" },
    });
    await waitForSeedance2Autosave();

    const payload = updateBeatMock.mock.calls[0][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config.ratio).toBe("16:9");
  });

  it("inserts the highlighted @ mention candidate when pressing Enter", async () => {
    renderPane();
    const textarea = (await screen.findByLabelText(
      "Seedance2.0主体提示词",
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "@" } });
    expect(await screen.findByText("引用候选")).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toContain("@图片1"));
  });

  it("navigates @ mention candidates with arrows and inserts on Tab", async () => {
    renderPane();
    const textarea = (await screen.findByLabelText(
      "Seedance2.0主体提示词",
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "@" } });
    expect(await screen.findByText("引用候选")).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "Tab" });
    await waitFor(() => expect(textarea.value).toContain("@图片2"));
  });

  it("keeps already-inserted references available in the @ mention dropdown", async () => {
    renderPane();
    const textarea = (await screen.findByLabelText(
      "Seedance2.0主体提示词",
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "@图片1 @" } });
    expect(await screen.findByText("引用候选")).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });
    // Selecting a mention appends a trailing space so the next keystroke can't
    // glue onto it.
    await waitFor(() => expect(textarea.value).toBe("@图片1 @图片1 "));
  });

  it("normalizes legacy unmarked first_frame Seedance2 configs to the NiceGUI multimodal default", async () => {
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          mode: "first_frame",
          final_prompt: "legacy prompt",
        }),
      }),
    );

    fireEvent.change(screen.getByLabelText("Seedance2.0主体提示词"), {
      target: { value: "legacy prompt updated" },
    });
    await waitForSeedance2Autosave();

    const payload = updateBeatMock.mock.calls[0][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config.mode).toBe("multimodal_reference");
  });

  it("persists legacy unmarked first_frame configs so status assets use multimodal mode", async () => {
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          mode: "first_frame",
          final_prompt: "legacy prompt",
        }),
      }),
    );

    await waitFor(() => expect(updateBeatMock).toHaveBeenCalledTimes(1));
    const payload = updateBeatMock.mock.calls[0][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config.mode).toBe("multimodal_reference");
    expect(config.mode_user_set).toBe(false);
  });

  it("persists legacy React-forced Seedance2 audio-off configs back to the NiceGUI audio default", async () => {
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          mode: "multimodal_reference",
          generate_audio: false,
          generate_audio_user_set: true,
          final_prompt: "legacy adapter-forced audio-off prompt",
        }),
      }),
    );

    await waitFor(() => expect(updateBeatMock).toHaveBeenCalledTimes(1));
    const payload = updateBeatMock.mock.calls[0][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config.generate_audio).toBe(true);
    expect(config.generate_audio_user_set).toBe(false);
  });

  it("autosaves Seedance2 mode changes so reference assets refresh by mode", async () => {
    const user = userEvent.setup();
    renderPane();

    const modeTrigger = screen.getByLabelText("生成模式");
    expect(modeTrigger).toHaveTextContent("多参模式");
    expect(modeTrigger).not.toHaveTextContent("multimodal_reference");
    await user.click(modeTrigger);
    expect(await screen.findByRole("option", { name: "首帧模式" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "首尾帧模式" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "多参模式" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "first_last_frame" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "首尾帧模式" }));
    await waitForSeedance2Autosave();

    const payload = updateBeatMock.mock.calls[0][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config.mode).toBe("first_last_frame");
    expect(config.mode_user_set).toBe(true);
  });

  it("does not render manual Seedance2 save actions", () => {
    renderPane();

    expect(screen.queryByRole("button", { name: "保存配置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存prompt" })).not.toBeInTheDocument();
  });

  it("keeps Seedance2 API audio generation enabled by default", async () => {
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          mode: "multimodal_reference",
          generate_audio: false,
          generate_audio_user_set: true,
          final_prompt: "legacy adapter-forced audio-off prompt",
        }),
      }),
    );

    fireEvent.change(screen.getByLabelText("Seedance2.0主体提示词"), {
      target: { value: "seedance2 prompt with generated audio" },
    });
    await waitForSeedance2Autosave();

    const payload = updateBeatMock.mock.calls[0][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config.generate_audio).toBe(true);
    expect(config.generate_audio_user_set).toBe(false);
  });

  it("shows and downloads the returned last frame when enabled", () => {
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          mode: "multimodal_reference",
          duration: 5,
          resolution: "720p",
          ratio: "9:16",
          generate_audio: false,
          return_last_frame: true,
          human_review: false,
          final_prompt: "existing seedance2 prompt",
        }),
      }),
    );

    const image = screen
      .getAllByAltText("返回尾帧 · Beat 1")
      .find((element) => element.closest("[data-seedance2-returned-last-frame]"));
    if (!image) throw new Error("returned last frame image not found");
    const panel = image.closest("[data-seedance2-returned-last-frame]");

    expect(image).toHaveAttribute(
      "src",
      "/static/demo/seedance2/beat_01_last_frame.png",
    );
    expect(panel).toBeTruthy();
    expect(within(panel as HTMLElement).getByRole("link", { name: "下载" })).toHaveAttribute(
      "href",
      "/static/demo/seedance2/beat_01_last_frame.png",
    );
  });

  it("shows a returned last frame image box before the image is ready", () => {
    videoQueryMockState.hideReturnedLastFrame = true;

    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          mode: "multimodal_reference",
          duration: 5,
          resolution: "720p",
          ratio: "9:16",
          generate_audio: false,
          return_last_frame: true,
          human_review: false,
          final_prompt: "existing seedance2 prompt",
        }),
      }),
    );

    const panel = screen.getByTestId("seedance2-returned-last-frame-panel");
    const box = screen.getByTestId("seedance2-returned-last-frame-box");
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveClass("w-fit", "max-w-full");
    expect(box).toHaveClass("w-[7.5rem]", "max-w-full");
    expect(box).toHaveStyle({ aspectRatio: "9 / 16" });
    expect(within(panel).getByText("等待生成尾帧")).toBeInTheDocument();
    expect(within(panel).queryByRole("link", { name: "下载" })).not.toBeInTheDocument();
  });

  it("opens Seedance2 mention candidates when typing @ and inserts the selected reference", async () => {
    const user = userEvent.setup();
    renderPane();

    fireEvent.change(screen.getByLabelText("Seedance2.0主体提示词"), {
      target: { value: "镜头推进 @" },
    });
    expect(screen.getByText("引用候选")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "@图片1" }));

    expect(screen.getByLabelText("Seedance2.0主体提示词")).toHaveValue("镜头推进 @图片1 ");
  });

  it("appends a space when picking consecutive references via the popover", async () => {
    const user = userEvent.setup();
    renderPane();
    const textarea = screen.getByLabelText(
      "Seedance2.0主体提示词",
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "@" } });
    await user.click(screen.getByRole("button", { name: "@图片1" }));
    expect(textarea).toHaveValue("@图片1 ");

    fireEvent.change(textarea, { target: { value: "@图片1 @" } });
    await user.click(screen.getByRole("button", { name: "@图片2" }));
    expect(textarea).toHaveValue("@图片1 @图片2 ");
  });

  it("keeps a space after every popover pick when typing @ between them", async () => {
    const user = userEvent.setup();
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          mode: "multimodal_reference",
          final_prompt: "",
        }),
      }),
    );
    const textarea = screen.getByLabelText(
      "Seedance2.0主体提示词",
    ) as HTMLTextAreaElement;

    await user.click(textarea);
    await user.type(textarea, "@");
    await user.click(screen.getByRole("button", { name: "@图片1" }));
    await user.type(textarea, "@");
    await user.click(screen.getByRole("button", { name: "@图片2" }));

    expect(textarea.value).toBe("@图片1 @图片2 ");
  });

  it("inserts an @ reference when dragging a reference image into the prompt editor", () => {
    renderPane();
    expandSeedance2References();
    const image = screen.getByAltText("手动素材 2");
    const textarea = screen.getByLabelText("Seedance2.0主体提示词");
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: vi.fn((type: string, value: string) => data.set(type, value)),
      getData: vi.fn((type: string) => data.get(type) ?? ""),
      effectAllowed: "",
      dropEffect: "",
    };

    fireEvent.dragStart(image, { dataTransfer });
    fireEvent.drop(textarea, { dataTransfer });

    expect(textarea).toHaveValue("existing seedance2 prompt\n@图片2 ");
  });

  it("makes uploaded image and audio reference tiles draggable", () => {
    videoQueryMockState.includeAudioAsset = true;
    renderPane();
    expandSeedance2References();
    const imageTile = screen
      .getByText("手动素材 2")
      .closest("[data-seedance2-reference-tile]");
    const audioTile = screen
      .getByText("项目解说声线")
      .closest("[data-seedance2-reference-tile]");
    if (!imageTile) throw new Error("image tile not found");
    if (!audioTile) throw new Error("audio tile not found");
    const textarea = screen.getByLabelText("Seedance2.0主体提示词");
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: vi.fn((type: string, value: string) => data.set(type, value)),
      getData: vi.fn((type: string) => data.get(type) ?? ""),
      effectAllowed: "",
      dropEffect: "",
    };

    expect(imageTile).toHaveAttribute("draggable", "true");
    expect(audioTile).toHaveAttribute("draggable", "true");
    fireEvent.dragStart(audioTile, { dataTransfer });
    fireEvent.drop(textarea, { dataTransfer });

    expect(textarea).toHaveValue("existing seedance2 prompt\n@音频1 ");
  });

  it("inserts a dragged @ reference at the prompt cursor position", () => {
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          mode: "multimodal_reference",
          final_prompt: "参考作为起始构图",
        }),
      }),
    );
    expandSeedance2References();
    const image = screen.getByAltText("手动素材 2");
    const textarea = screen.getByLabelText("Seedance2.0主体提示词") as HTMLTextAreaElement;
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: vi.fn((type: string, value: string) => data.set(type, value)),
      getData: vi.fn((type: string) => data.get(type) ?? ""),
      effectAllowed: "",
      dropEffect: "",
    };

    textarea.focus();
    textarea.setSelectionRange(2, 2);
    fireEvent.dragStart(image, { dataTransfer });
    fireEvent.drop(textarea, { dataTransfer });

    expect(textarea).toHaveValue("参考@图片2 作为起始构图");
  });

  it("uses the prompt cursor position from before dragging the image tile steals focus", () => {
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          mode: "multimodal_reference",
          final_prompt: "参考作为起始构图",
        }),
      }),
    );
    expandSeedance2References();
    const image = screen.getByAltText("手动素材 2");
    const textarea = screen.getByLabelText("Seedance2.0主体提示词") as HTMLTextAreaElement;
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: vi.fn((type: string, value: string) => data.set(type, value)),
      getData: vi.fn((type: string) => data.get(type) ?? ""),
      effectAllowed: "",
      dropEffect: "",
    };

    textarea.focus();
    textarea.setSelectionRange(2, 2);
    fireEvent.select(textarea);
    fireEvent.blur(textarea);
    fireEvent.dragStart(image, { dataTransfer });
    fireEvent.drop(textarea, { dataTransfer });

    expect(textarea).toHaveValue("参考@图片2 作为起始构图");
  });

  it("inserts a dragged reference even when the prompt already mentions it", () => {
    renderPane();
    expandSeedance2References();
    const image = screen.getByAltText("手动素材 2");
    const textarea = screen.getByLabelText("Seedance2.0主体提示词");
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: vi.fn((type: string, value: string) => data.set(type, value)),
      getData: vi.fn((type: string) => data.get(type) ?? ""),
      effectAllowed: "",
      dropEffect: "",
    };

    fireEvent.change(textarea, { target: { value: "已有 @图片2" } });
    fireEvent.dragStart(image, { dataTransfer });
    fireEvent.drop(textarea, { dataTransfer });

    expect(textarea).toHaveValue("已有 @图片2 @图片2 ");
  });

  it("accepts browser image drags whose dragover data lacks the custom reference type", () => {
    renderPane();
    const textarea = screen.getByLabelText("Seedance2.0主体提示词");
    const dataTransfer = {
      types: ["text/plain"],
      getData: vi.fn((type: string) => (type === "text/plain" ? "@图片2" : "")),
      dropEffect: "",
    };

    expect(fireEvent.dragOver(textarea, { dataTransfer })).toBe(false);
    fireEvent.drop(textarea, { dataTransfer });

    expect(textarea).toHaveValue("existing seedance2 prompt\n@图片2 ");
  });

  it("hides screen text overlay controls and disables stale overlay config on save", async () => {
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          final_prompt: "existing seedance2 prompt",
          text_overlay: {
            enabled: true,
            kind: "speech_bubble",
            content: "鹿镇北口",
            placement: "画面下方居中",
            timing: "全片持续",
            style: "干净易读",
            speaker: "陆辰_青年时期",
          },
        }),
      }),
    );

    expect(screen.queryByRole("button", { name: "画面文字" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("文字内容")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Seedance2.0主体提示词"), {
      target: { value: "updated seedance2 prompt" },
    });
    await waitForSeedance2Autosave();

    const payload = updateBeatMock.mock.calls[0][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config.text_overlay).toMatchObject({
      enabled: false,
      kind: "speech_bubble",
      content: "鹿镇北口",
      placement: "画面下方居中",
      timing: "全片持续",
      style: "干净易读",
      speaker: "陆辰_青年时期",
    });
  });

  it("generates Seedance2 final prompt from the current draft and guidance", async () => {
    const user = userEvent.setup();
    renderPane();

    fireEvent.change(screen.getByLabelText("自定义提示词"), {
      target: { value: "more camera motion" },
    });
    fireEvent.change(screen.getByLabelText("Seedance2.0主体提示词"), {
      target: { value: "manual reference prompt" },
    });
    const optimizeButton = screen.getByRole("button", { name: "AI 优化" });
    expect(optimizeButton).toHaveTextContent("6");
    await user.click(optimizeButton);

    expect(generateSeedance2PromptMock).toHaveBeenCalledTimes(1);
    expect(generateSeedance2PromptMock).toHaveBeenCalledWith({
      beatNum: 1,
      manualPromptReference: "manual reference prompt",
      promptGuidance: "more camera motion",
    });
    expect(screen.getByLabelText("Seedance2.0主体提示词")).toHaveValue(
      "optimized seedance2 prompt",
    );
  });

  it("opens reference mention candidates from the custom prompt field", async () => {
    const user = userEvent.setup();
    renderPane();

    const guidance = screen.getByLabelText("自定义提示词");
    fireEvent.change(guidance, { target: { value: "保持 @" } });
    expect(screen.getByText("引用候选")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "@图片1" }));

    expect(guidance).toHaveValue("保持 @图片1 ");
  });

  it("inserts a dragged reference into the custom prompt field", () => {
    videoQueryMockState.includeAudioAsset = true;
    renderPane();
    expandSeedance2References();
    const audioTile = screen
      .getByText("项目解说声线")
      .closest("[data-seedance2-reference-tile]");
    if (!audioTile) throw new Error("audio tile not found");
    const guidance = screen.getByLabelText("自定义提示词");
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: vi.fn((type: string, value: string) => data.set(type, value)),
      getData: vi.fn((type: string) => data.get(type) ?? ""),
      effectAllowed: "",
      dropEffect: "",
    };

    fireEvent.change(guidance, { target: { value: "声音参考：" } });
    fireEvent.dragStart(audioTile, { dataTransfer });
    fireEvent.drop(guidance, { dataTransfer });

    expect(guidance).toHaveValue("声音参考：@音频1 ");
  });

  it("places the AI optimize button in the main prompt input field", () => {
    renderPane();
    const promptField = screen.getByTestId("seedance2-prompt-panel");

    expect(promptField).toBeTruthy();
    expect(
      within(promptField as HTMLElement).getByRole("button", { name: "AI 优化" }),
    ).toBeInTheDocument();
  });

  it("appends and saves Seedance2 prompt guidance templates without duplicates", async () => {
    const user = userEvent.setup();
    renderPane();

    await user.click(screen.getByRole("button", { name: "镜头" }));
    await user.click(screen.getByRole("button", { name: "镜头" }));

    const template =
      "镜头：说明景别、视角、运镜速度和运动方向，保持镜头运动清晰可执行。";
    expect(screen.getByLabelText("自定义提示词")).toHaveValue(template);
    await waitForSeedance2Autosave();
    const payload = updateBeatMock.mock.calls[0][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config.prompt_guidance).toBe(template);
  });

  it("does not render project narrator voice management inside the video pane", () => {
    renderPane();

    expect(screen.queryByText("解说声线")).not.toBeInTheDocument();
    expect(screen.queryByText("第三人称项目解说声线")).not.toBeInTheDocument();
    expect(screen.queryByText("assets/narrator/voice.wav")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "项目音频" })).not.toBeInTheDocument();
    expect(deleteNarratorVoiceMock).not.toHaveBeenCalled();
  });
});
