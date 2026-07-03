// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BatchBar,
  episodeAudioModelCallCount,
} from "@/components/episode/beat-workbench/batch-bar";

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
            cancel: "取消",
            confirmExecute: "确认执行",
            error: "错误",
            ok: "OK",
            billingRuleNotConfiguredShort: "需配置",
          },
          episode: {
            script: { identityRequired: "需要身份规划" },
            workbench: {
              batch: {
                rewriteScript: "重写脚本",
                rewriteScriptTitle: "重写脚本？",
                rewriteScriptDesc: "确认重写脚本？",
                genSketch: "生成草图",
                genSketchTitle: "生成草图？",
                genSketchDesc: "确认生成草图？",
                aiOptimize: "生成全 Beat 视频提示词",
                aiOptimizeTitle: "生成全 Beat 视频提示词？",
                aiOptimizeDesc: "确认生成全 Beat 视频提示词？",
                aiDetect: "AI 检测",
                aiDetectTooltip: "AI 检测",
                aiDetectRunning: "AI 检测中",
                aiDetectEmpty: "无检测结果",
                aiDetectSuccess:
                  "AI 检测完成：{{beats}} 个 beat，共 {{ids}} 个身份、{{props}} 个道具",
                aiDetectReview:
                  "请核对每个 beat；漏识别可在更多里的出场身份/出场道具中补选。",
                reassignColors: "重新配色",
                reassignColorsTooltip: "重新配色",
                reassignColorsTitle: "重新配色？",
                reassignColorsDesc: "确认重新配色？",
                reassignColorsSuccess:
                  "已分配 {{count}} 个身份、{{propCount}} 个道具",
                insertManualBeforeFirst: "首镜前插入",
                insertManualBeforeFirstTooltip: "首镜前插入",
                genMissingManualTitle: "补生成草图？",
                genMissingManualDesc: "确认补生成草图？",
                genMissingManual: "补生成草图",
                genMissingManualTooltip: "补生成草图",
                genMissingManualEmpty: "没有缺草图的手工镜头",
                genMissingManualDispatched:
                  "已发起 {{count}} 组手工镜头草图任务",
                genRender: "规划渲染",
                genRenderShort: "全集渲染",
                genRenderTooltip: "规划渲染",
                genAudio: "生成音频",
                genAudioTitle: "生成音频？",
                genAudioDesc: "确认生成音频？",
                genAudioUnavailableForVideoModel: "当前模型无需单独生成音频",
                videoModel: "视频模型",
                sketchSettingsLabel: "草图设置",
                renderSettingsLabel: "渲染设置",
                videoSettingsLabel: "视频设置",
                genVideo: "生成视频",
                genVideoTitle: "生成视频？",
                genVideoDesc: "确认生成视频？",
                narrationIncompatible: "不兼容旁白 {{count}}",
                globalOptimizeStarted: "已启动 AI 优化",
                selectedCount: "已选 {{count}} 个节拍",
                clearSelection: "清除选择",
                singleRegen: "单张重抽",
                autoCombine: "批量重抽",
                regenSketchSingleTitle: "单张重抽 {{count}} 个 beat 草图？",
                regenSketchSingleDesc: "按当前画幅把 #{{beats}} 拆成 1×1 草图任务。",
                dispatched: "已发配 {{count}} 个 beat → {{mode}}",
                dispatchedBatch: " × {{batches}} 组",
                dispatchFailed: "发配失败",
                sketch: "草图",
                sketchGroupRunning: "相同草图组正在运行中",
                sketchGroupSkippedRunning: "已跳过 {{count}} 个正在运行的草图组",
              },
              video: {
                noteDefault: "默认",
                noteDialogue: "对白镜头",
              },
            },
            renderSettings: {
              model: "模型",
              modelPlaceholder: "请选择",
              sketchAspectPadding: "草图适配",
            },
            sketchSettings: {
              model: "草图模型",
              modelPlaceholder: "请选择草图模型",
              wide16x9: "16:9",
            },
            renderPlan: {
              dispatched: "已发起 {{scope}}",
            },
          },
        },
      },
    },
  });
});

const {
  assignColorsMock,
  detectIdentitiesMock,
  generateMissingManualMock,
  regenerateSketchesMock,
  sketchStartMock,
  toastSuccessMock,
} = vi.hoisted(() => ({
  assignColorsMock: vi.fn(),
  detectIdentitiesMock: vi.fn(),
  generateMissingManualMock: vi.fn(),
  regenerateSketchesMock: vi.fn(),
  sketchStartMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}));

vi.mock("@/lib/queries/sketches", () => ({
  useAssignColors: () => ({
    mutateAsync: assignColorsMock,
    isPending: false,
  }),
  useDetectIdentities: () => ({
    mutateAsync: detectIdentitiesMock,
    isPending: false,
  }),
  useGenerateMissingManualSketches: () => ({
    mutateAsync: generateMissingManualMock,
    isPending: false,
  }),
  useRegenerateSketches: () => ({
    mutateAsync: regenerateSketchesMock,
    isPending: false,
  }),
}));

vi.mock("@/lib/queries/sketch-image-usage", () => ({
  useSketchImageUsage: () => ({ data: undefined }),
}));

vi.mock("@/lib/queries/audio", () => ({
  useGenerateAudio: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/lib/queries/episodes", () => ({
  useEpisodeBeats: () => ({
    data: {
      ok: true,
      data: [
        {
          beat_number: 1,
          narration_segment: "n1",
          visual_description: "v1",
          scene_ref: { scene_id: "store" },
        },
        {
          beat_number: 2,
          narration_segment: "n2",
          visual_description: "v2",
          scene_ref: { scene_id: "store" },
        },
      ],
    },
  }),
  useEpisodeDetail: () => ({
    data: { ok: true, data: { identity_ids: ["Hero_Main"] } },
  }),
}));

vi.mock("@/lib/queries/scripts", () => ({
  useGenerateScript: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/lib/queries/sketch-regen-queue", () => ({
  useSaveSketchRegenQueue: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useSketchRegenQueue: () => ({
    data: { ok: true, data: { items: [] } },
  }),
}));

vi.mock("@/lib/queries/tasks", () => ({
  useTasks: () => ({
    data: { ok: true, data: [] },
  }),
}));

vi.mock("@/lib/queries/video", () => ({
  useGlobalOptimize: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useVideoBackends: () => ({
    data: {
      ok: true,
      data: [
        {
          value: "seedance",
          label: "Seedance 1.0",
          is_default: true,
          is_seedance2: false,
          dialogue_only: false,
        },
        {
          value: "huimeng_seedance-2.0-fast",
          label: "Seedance 2.0 Fast",
          is_default: false,
          is_seedance2: true,
          dialogue_only: false,
        },
      ],
    },
  }),
}));

vi.mock("@/lib/queries/sketch-settings", () => ({
  useSketchSettings: () => ({
    data: {
      ok: true,
      data: {
        sketch_image_selection: "newapi_gpt_image2",
        options: {},
      },
    },
  }),
}));

vi.mock("@/lib/queries/generation-credit-cost", () => ({
  useGenerationCreditCost: () => ({
    data: {
      ok: true,
      data: {
        cost: 5,
        display: "5",
      },
    },
  }),
}));

vi.mock("@/hooks/use-task-controller", () => ({
  useTaskController: (opts: { key: { taskType: string } }) => ({
    started: false,
    stopping: false,
    stream: { status: "idle" },
    start:
      opts.key.taskType === "sketch_generation" ? sketchStartMock : vi.fn(),
    stop: vi.fn(),
  }),
}));

vi.mock("@/components/episode/beat-workbench/render-settings-controls", () => ({
  RenderModelSelect: () => <div data-testid="render-model-select" />,
  RenderCheckboxes: () => <div data-testid="render-checkboxes" />,
}));

vi.mock("@/components/episode/beat-workbench/sketch-settings-controls", () => ({
  SketchModelSelect: () => <div data-testid="sketch-model-select" />,
  SketchAspectCheckbox: () => <div data-testid="sketch-aspect-checkbox" />,
}));

vi.mock("@/components/episode/beat-workbench/insert-manual-shot-dialog", () => ({
  InsertManualShotDialog: () => null,
}));

vi.mock("@/components/episode/beat-workbench/render-plan-dialog", () => ({
  RenderPlanDialog: () => null,
}));

vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(() => "toast-1"),
    success: toastSuccessMock,
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

beforeEach(() => {
  assignColorsMock.mockReset();
  assignColorsMock.mockResolvedValue({
    ok: true,
    data: { count: 1, prop_count: 2 },
  });
  detectIdentitiesMock.mockReset();
  detectIdentitiesMock.mockResolvedValue({
    ok: true,
    data: {
      total_beats: 3,
      total_identities: 2,
      total_props: 1,
      review_message: "后端核对提示",
    },
  });
  generateMissingManualMock.mockReset();
  generateMissingManualMock.mockResolvedValue({
    ok: true,
    task_type: "sketch_generation",
    data: {
      dispatched: 1,
      scopes: ["selected__manual__1-2"],
      segments: [[1, 2]],
    },
  });
  regenerateSketchesMock.mockReset();
  regenerateSketchesMock.mockResolvedValue({
    ok: true,
    scope: "sketch_grid:demo",
  });
  sketchStartMock.mockReset();
  toastSuccessMock.mockReset();
});

const DEFAULT_BEATS = [
  {
    beat_number: 1,
    narration_segment: "n1",
    visual_description: "v1",
    scene_ref: { scene_id: "store" },
    is_manual_shot: true,
    sketch_url: null,
  },
  {
    beat_number: 2,
    narration_segment: "n2",
    visual_description: "v2",
    scene_ref: { scene_id: "store" },
    is_manual_shot: true,
    sketch_url: null,
  },
  {
    beat_number: 3,
    narration_segment: "n3",
    visual_description: "v3",
    scene_ref: { scene_id: "store" },
    audio_type: "narration",
    is_manual_shot: false,
    sketch_url: "/sketch-3.png",
  },
];

describe("BatchBar", () => {
  it("estimates whole-episode audio model calls from eligible beats", () => {
    expect(
      episodeAudioModelCallCount([
        ...DEFAULT_BEATS,
        {
          beat_number: 4,
          narration_segment: "no audio",
          visual_description: "v4",
          audio_type: "silence",
        },
        {
          beat_number: 5,
          narration_segment: "manual",
          visual_description: "v5",
          audio_type: "narration",
          is_manual_shot: true,
        },
        {
          beat_number: 6,
          narration_segment: "dialogue",
          visual_description: "v6",
          audio_type: "dialogue",
          speaker: "Hero_Main",
        },
        {
          beat_number: 7,
          narration_segment: "",
          visual_description: "v7",
          audio_type: "narration",
        },
      ]),
    ).toBe(3);
  });

  it("hides whole-episode script rewrite from the batch toolbar", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <BatchBar
          project="demo"
          episode={1}
          beats={DEFAULT_BEATS}
          videoBackend="seedance"
          sketchAspectRatio="2:3"
          onSketchAspectRatioChange={vi.fn()}
        />
      </I18nextProvider>,
    );

    expect(
      screen.queryByRole("button", { name: "重写脚本" }),
    ).not.toBeInTheDocument();
  });

  it("hides whole-episode sketch generation from the batch toolbar", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <BatchBar
          project="demo"
          episode={1}
          beats={DEFAULT_BEATS}
          videoBackend="seedance"
          sketchAspectRatio="2:3"
          onSketchAspectRatioChange={vi.fn()}
        />
      </I18nextProvider>,
    );

    expect(screen.queryByRole("button", { name: "生成草图" })).not.toBeInTheDocument();
  });

  it("hides whole-episode render generation from the batch toolbar", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <BatchBar
          project="demo"
          episode={1}
          beats={DEFAULT_BEATS}
          videoBackend="seedance"
          sketchAspectRatio="2:3"
          onSketchAspectRatioChange={vi.fn()}
        />
      </I18nextProvider>,
    );

    expect(screen.queryByRole("button", { name: "全集渲染" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "规划渲染" })).not.toBeInTheDocument();
  });

  it("does not expose the 0.5K render setting", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <BatchBar
          project="demo"
          episode={1}
          beats={DEFAULT_BEATS}
          videoBackend="seedance"
          sketchAspectRatio="2:3"
          onSketchAspectRatioChange={vi.fn()}
        />
      </I18nextProvider>,
    );

    expect(screen.queryByText("0.5K")).not.toBeInTheDocument();
  });

  it("shows whole-episode video prompt generation only for narrated projects", () => {
    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <BatchBar
          project="demo"
          episode={1}
          beats={DEFAULT_BEATS}
          videoBackend="seedance"
          spineTemplate="narrated"
          sketchAspectRatio="2:3"
          onSketchAspectRatioChange={vi.fn()}
        />
      </I18nextProvider>,
    );

    expect(
      screen.getByRole("button", { name: "生成全 Beat 视频提示词" }),
    ).toBeInTheDocument();

    rerender(
      <I18nextProvider i18n={i18n}>
        <BatchBar
          project="demo"
          episode={1}
          beats={DEFAULT_BEATS}
          videoBackend="seedance"
          spineTemplate="drama"
          sketchAspectRatio="2:3"
          onSketchAspectRatioChange={vi.fn()}
        />
      </I18nextProvider>,
    );

    expect(
      screen.queryByRole("button", { name: "生成全 Beat 视频提示词" }),
    ).not.toBeInTheDocument();
  });

  it("keeps video model and missing-manual sketch actions out of the top batch toolbar", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <BatchBar
          project="demo"
          episode={1}
          beats={DEFAULT_BEATS}
          videoBackend="seedance"
          sketchAspectRatio="2:3"
          onSketchAspectRatioChange={vi.fn()}
        />
      </I18nextProvider>,
    );

    expect(screen.queryByText("视频模型")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "补生成草图" })).not.toBeInTheDocument();
  });

  it("shows whole-episode audio cost on the button and confirm action", async () => {
    const user = userEvent.setup();
    render(
      <I18nextProvider i18n={i18n}>
        <BatchBar
          project="demo"
          episode={1}
          beats={DEFAULT_BEATS}
          videoBackend="seedance"
          spineTemplate="narrated"
          sketchAspectRatio="2:3"
          onSketchAspectRatioChange={vi.fn()}
        />
      </I18nextProvider>,
    );

    expect(screen.getByRole("button", { name: "生成音频" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "生成音频" }));

    expect(screen.getByRole("button", { name: "确认执行" })).toBeInTheDocument();
    expect(screen.getAllByText("5").length).toBeGreaterThanOrEqual(2);
  });

  it("keeps whole-episode TTS generation visible but unavailable when Seedance2 is selected", async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <BatchBar
          project="demo"
          episode={1}
          beats={DEFAULT_BEATS}
          videoBackend="huimeng_seedance-2.0-fast"
          spineTemplate="narrated"
          sketchAspectRatio="2:3"
          onSketchAspectRatioChange={vi.fn()}
        />
      </I18nextProvider>,
    );

    expect(screen.getByRole("button", { name: "生成音频" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("hides whole-episode audio for 精品剧 (drama) projects", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <BatchBar
          project="demo"
          episode={1}
          beats={DEFAULT_BEATS}
          videoBackend="seedance"
          spineTemplate="drama"
          sketchAspectRatio="2:3"
          onSketchAspectRatioChange={vi.fn()}
        />
      </I18nextProvider>,
    );

    expect(screen.queryByRole("button", { name: "生成音频" })).not.toBeInTheDocument();
  });

  it("shows AI detect and reassign color actions in the top batch toolbar", async () => {
    const user = userEvent.setup();
    render(
      <I18nextProvider i18n={i18n}>
        <BatchBar
          project="demo"
          episode={1}
          beats={DEFAULT_BEATS}
          videoBackend="seedance"
          sketchAspectRatio="2:3"
          onSketchAspectRatioChange={vi.fn()}
        />
      </I18nextProvider>,
    );

    const aiDetectButton = screen.getByRole("button", { name: "AI 检测" });
    expect(aiDetectButton).toHaveTextContent("5");
    await user.click(aiDetectButton);

    expect(detectIdentitiesMock).toHaveBeenCalledTimes(1);
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "AI 检测完成：3 个 beat，共 2 个身份、1 个道具\n后端核对提示",
      { id: "toast-1" },
    );

    await user.click(screen.getByRole("button", { name: "重新配色" }));
    await user.click(screen.getByRole("button", { name: "确认执行" }));

    expect(assignColorsMock).toHaveBeenCalledWith({ force: true });
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "已分配 1 个身份、2 个道具",
    );
  });

});
