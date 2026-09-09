// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { describe, expect, it, vi, beforeEach, beforeAll, type Mock } from "vitest";
import type { ReactNode } from "react";

import { zhTranslation } from "../../../helpers/i18n-fixtures";

// 本地 i18n 实例：直接吃 public/locales/zh/translation.json，不走 HTTP backend。
// 以前是手抄一份子集，新增 key 时抄漏了测试就挂在「渲染出 key」上，索性用真的。
const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "zh",
    interpolation: { escapeValue: false },
    resources: { zh: { translation: zhTranslation } },
  });
});

const mutateAsync: Mock = vi.fn().mockResolvedValue({ ok: true, data: null });
const mutate: Mock = vi.fn();
const updateState = { isPending: false };

vi.mock("@/lib/queries/scripts", () => ({
  useUpdateBeat: () => ({
    mutateAsync,
    mutate,
    isPending: updateState.isPending,
  }),
}));

const episodeDetailState: {
  identity_ids: string[];
  prop_menu: { prop_id: string }[];
  scene_menu: {
    scene_id: string;
    base_scene_id?: string;
    variant_id?: string;
    time_of_day?: string;
  }[];
} = { identity_ids: [], prop_menu: [], scene_menu: [] };
vi.mock("@/lib/queries/episodes", () => ({
  useEpisodeDetail: () => ({
    data: {
      ok: true,
      data: {
        number: 1,
        title: "ep1",
        identity_ids: episodeDetailState.identity_ids,
        prop_menu: episodeDetailState.prop_menu,
        scene_menu: episodeDetailState.scene_menu,
      },
    },
  }),
}));

const scenesState: {
  names: string[];
  records?: Array<{
    name: string;
    base_scene_id?: string;
    variant_id?: string;
    time_of_day?: string;
  }>;
} = { names: [] };
vi.mock("@/lib/queries/scenes", () => ({
  useScenes: () => ({
    data: {
      ok: true,
      data: scenesState.records ?? scenesState.names.map((name) => ({ name })),
    },
  }),
  useScenePlatePreview: () => ({
    data: {
      ok: true,
      data: {
        render: {
          label: "Render：将使用 卫生间_漏水_夜晚，锁图光",
          status: "time_baked",
          relight: false,
          resolved_scene_name: "卫生间_漏水_夜晚",
          planned_scene_name: "",
        },
      },
    },
  }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { TextPane } from "@/components/episode/beat-workbench/text-pane";
import type { Beat } from "@/types/episode";

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
    narration_segment: "我带着丧尸病毒样本来，坠入闹市街头。",
    visual_description: "阳光刺眼的繁忙街头",
    scene_ref: { scene_id: "闹市街头" },
    time_of_day: "午后",
    audio_type: "narration",
    video_mode: "first_frame",
    video_prompt: "",
    keyframe_prompt: "",
    speaker: "",
    detected_identities: [],
    detected_props: [],
    ...overrides,
  };
}

beforeEach(() => {
  mutateAsync.mockClear();
  mutateAsync.mockResolvedValue({ ok: true, data: null });
  updateState.isPending = false;
  episodeDetailState.identity_ids = [];
  episodeDetailState.prop_menu = [];
  episodeDetailState.scene_menu = [];
  scenesState.names = [];
  scenesState.records = undefined;
});

describe("TextPane", () => {
  it("renders v2 scene fields without legacy staging editors", () => {
    const { container } = render(
      <Wrapper>
        <TextPane beat={makeBeat()} project="demo" episode={1} />
      </Wrapper>,
    );

    expect(screen.getByText("台词")).toBeInTheDocument();
    expect(screen.getByText("画面描述")).toBeInTheDocument();
    expect(screen.queryByText("视频提示词")).not.toBeInTheDocument();
    expect(screen.queryByText("关键帧提示词")).not.toBeInTheDocument();
    expect(screen.queryByText(/Fish Speech|fishSpeechPrompt/)).not.toBeInTheDocument();
    expect(screen.getByText("类型")).toBeInTheDocument();
    expect(screen.getByText("场景")).toBeInTheDocument();
    expect(screen.getByText("场景变体")).toBeInTheDocument();
    expect(screen.getByText("时间")).toBeInTheDocument();
    expect(screen.getByText("出场身份")).toBeInTheDocument();
    expect(screen.getByText("出场道具")).toBeInTheDocument();
    expect(screen.queryByText("更多")).not.toBeInTheDocument();
    expect(container.querySelector("details")).not.toBeInTheDocument();
    expect(screen.queryByText(/置景/)).not.toBeInTheDocument();
    expect(screen.queryByText("episode.workbench.text.setScene")).not.toBeInTheDocument();
    expect(screen.queryByText("episode.workbench.text.setProps")).not.toBeInTheDocument();
  });

  it("keeps prompt optimization out of the text editor; SuperPower lives on the sketch workflow", () => {
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ video_mode: "first_frame", video_prompt: "" })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    expect(
      screen.queryByRole("button", { name: "AI 生成提示词" }),
    ).not.toBeInTheDocument();
  });

  it("keeps no-character option when episode.identity_ids is empty", () => {
    episodeDetailState.identity_ids = [];
    render(
      <Wrapper>
        <TextPane beat={makeBeat()} project="demo" episode={1} />
      </Wrapper>,
    );

    expect(
      screen.getByRole("button", { name: "无角色出场" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("本集身份未规划，请先到「脚本」页配置本集身份。"),
    ).not.toBeInTheDocument();
  });

  it("renders one badge per episode identity and toggles selection", () => {
    episodeDetailState.identity_ids = ["陈锋_和尚", "陈锋_便装"];
    render(
      <Wrapper>
        <TextPane beat={makeBeat()} project="demo" episode={1} />
      </Wrapper>,
    );

    const group = screen.getByRole("group", { name: "出场身份" });
    const buttons = within(group)
      .getAllByRole("button")
      .filter((b) => b.hasAttribute("aria-pressed"));
    expect(buttons).toHaveLength(3);
    expect(buttons[0]).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByText(
        "未检测/未标注出场身份；如果确实没有角色出场，请选择「无角色出场」。",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "陈锋_和尚" }));
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({
      detected_identities: ["陈锋_和尚"],
    });
    expect(screen.getByRole("button", { name: "陈锋_和尚" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.queryByText(
        "未检测/未标注出场身份；如果确实没有角色出场，请选择「无角色出场」。",
      ),
    ).not.toBeInTheDocument();
  });

  it("offers no-character as a mutually exclusive identity option", () => {
    episodeDetailState.identity_ids = ["陈锋_和尚"];
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ detected_identities: ["__NO_CHARACTER__"] })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    const noCharacter = screen.getByRole("button", { name: "无角色出场" });
    expect(noCharacter).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "陈锋_和尚" }));
    expect(mutateAsync.mock.calls[0][0].data).toEqual({
      detected_identities: ["陈锋_和尚"],
    });

    fireEvent.click(screen.getByRole("button", { name: "陈锋_和尚" }));
    expect(mutateAsync.mock.calls[1][0].data).toEqual({
      detected_identities: ["__NO_CHARACTER__"],
    });
  });

  it("renders stale identities (selected but not in episode plan)", () => {
    episodeDetailState.identity_ids = ["陈锋_和尚"];
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ detected_identities: ["陈锋_和尚", "removed_character_id"] })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    const group = screen.getByRole("group", { name: "出场身份" });
    const buttons = within(group)
      .getAllByRole("button")
      .filter((b) => b.hasAttribute("aria-pressed"));
    expect(buttons).toHaveLength(3);
    expect(screen.getByText("（已移除）")).toBeInTheDocument();
  });

  it("renders episode props and toggles detected_props", () => {
    episodeDetailState.prop_menu = [{ prop_id: "sample_box" }, { prop_id: "jade_sword" }];
    render(
      <Wrapper>
        <TextPane beat={makeBeat()} project="demo" episode={1} />
      </Wrapper>,
    );

    const group = screen.getByRole("group", { name: "出场道具" });
    const buttons = within(group)
      .getAllByRole("button")
      .filter((b) => b.hasAttribute("aria-pressed"));
    expect(buttons).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "sample_box" }));
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({
      detected_props: ["sample_box"],
    });
    expect(screen.getByRole("button", { name: "sample_box" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("offers no-prop as a mutually exclusive prop option", () => {
    episodeDetailState.prop_menu = [{ prop_id: "sample_box" }];
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ detected_props: ["__NO_PROP__"] })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    expect(screen.getByRole("button", { name: "无道具出场" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "sample_box" }));
    expect(mutateAsync.mock.calls[0][0].data).toEqual({
      detected_props: ["sample_box"],
    });

    fireEvent.click(screen.getByRole("button", { name: "sample_box" }));
    expect(mutateAsync.mock.calls[1][0].data).toEqual({
      detected_props: ["__NO_PROP__"],
    });
  });

  it("fires audio_type PATCH immediately on select change (no blur needed)", async () => {
    episodeDetailState.identity_ids = [];
    const user = userEvent.setup();
    render(
      <Wrapper>
        <TextPane beat={makeBeat()} project="demo" episode={1} />
      </Wrapper>,
    );

    const trigger = screen.getByRole("combobox", { name: "类型" });
    await user.click(trigger);
    const dialogue = await screen.findByRole("option", { name: "对白" });
    await user.click(dialogue);

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({ audio_type: "dialogue" });
  });

  it("renders narration beats with a read-only narrator label instead of speaker input", () => {
    episodeDetailState.identity_ids = ["陈锋_和尚"];
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ audio_type: "narration", speaker: "" })}
          project="demo"
          episode={1}
          spineTemplate="narrated"
        />
      </Wrapper>,
    );

    expect(screen.getByText("解说人")).toBeInTheDocument();
    expect(screen.getByText("项目解说人")).toBeInTheDocument();
    expect(screen.queryByText("说话人")).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("身份ID（如 陈锋_和尚），对白时必填"),
    ).not.toBeInTheDocument();
  });

  it("does not show narrator speaker semantics for drama narration", () => {
    episodeDetailState.identity_ids = ["陈锋_和尚"];
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ audio_type: "narration", speaker: "" })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    expect(screen.queryByText("解说人")).not.toBeInTheDocument();
    expect(screen.queryByText("项目解说人")).not.toBeInTheDocument();
    expect(screen.queryByText("说话人")).not.toBeInTheDocument();
  });

  it("does not show speaker controls for drama dialogue", () => {
    episodeDetailState.identity_ids = ["陈锋_和尚"];
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ audio_type: "dialogue", speaker: "陈锋_和尚" })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    expect(screen.queryByText("说话人")).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("身份ID（如 陈锋_和尚），对白时必填"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "说话人" })).not.toBeInTheDocument();
  });

  it("renders dialogue speaker as a single-select sourced from episode identities", async () => {
    episodeDetailState.identity_ids = ["陈锋_和尚", "陆辰_青年"];
    const user = userEvent.setup();
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ audio_type: "dialogue", speaker: "陈锋_和尚" })}
          project="demo"
          episode={1}
          spineTemplate="narrated"
        />
      </Wrapper>,
    );

    const speaker = screen.getByRole("combobox", { name: "说话人" });
    expect(speaker).toHaveTextContent("陈锋_和尚");

    await user.click(speaker);
    expect(await screen.findByRole("option", { name: "陆辰_青年" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "旧值_不在本集" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "陆辰_青年" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({ speaker: "陆辰_青年" });
  });

  it("clears stale speaker when switching drama beats to dialogue", async () => {
    episodeDetailState.identity_ids = ["陈锋_和尚"];
    const user = userEvent.setup();
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ audio_type: "narration", speaker: "陈锋_和尚" })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    await user.click(screen.getByRole("combobox", { name: "类型" }));
    await user.click(await screen.findByRole("option", { name: "对白" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({
      audio_type: "dialogue",
      speaker: "",
    });
    expect(screen.queryByText("说话人")).not.toBeInTheDocument();
  });

  it("hides speaker controls for silence beats and clears speaker when switching away from dialogue", async () => {
    episodeDetailState.identity_ids = ["陈锋_和尚"];
    const user = userEvent.setup();
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ audio_type: "dialogue", speaker: "陈锋_和尚" })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    await user.click(screen.getByRole("combobox", { name: "类型" }));
    await user.click(await screen.findByRole("option", { name: "静音" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({
      audio_type: "silence",
      speaker: "",
    });
    expect(screen.queryByText("说话人")).not.toBeInTheDocument();
    expect(screen.queryByText("解说人")).not.toBeInTheDocument();
  });

  it("supports the NiceGUI silence audio type", async () => {
    episodeDetailState.identity_ids = [];
    const user = userEvent.setup();
    render(
      <Wrapper>
        <TextPane beat={makeBeat()} project="demo" episode={1} />
      </Wrapper>,
    );

    const trigger = screen.getByRole("combobox", { name: "类型" });
    await user.click(trigger);
    const silence = await screen.findByRole("option", { name: "静音" });
    await user.click(silence);

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({ audio_type: "silence" });
  });

  it("hides silence from narrated project audio type choices", async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ audio_type: "narration" })}
          project="demo"
          episode={1}
          spineTemplate="narrated"
        />
      </Wrapper>,
    );

    await user.click(screen.getByRole("combobox", { name: "类型" }));

    expect(screen.queryByRole("option", { name: "静音" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "类型" })).toHaveTextContent("解说");
  });

  it("edits time_of_day with the shared closed choices", async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ time_of_day: "午后" })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    await user.click(screen.getByRole("combobox", { name: "时间" }));
    await user.click(await screen.findByRole("option", { name: "夜晚" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({ time_of_day: "夜晚" });
  });

  it("shows non-standard time_of_day as a legacy choice and can clear it", async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ time_of_day: "亥时" })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    expect(screen.getByRole("combobox", { name: "时间" })).toHaveTextContent(
      "亥时（剧本原值）",
    );

    await user.click(screen.getByRole("combobox", { name: "时间" }));
    await user.click(
      await screen.findByRole("option", {
        name: "无（保持场景图光线，不重打光）",
      }),
    );

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({ time_of_day: "" });
  });

  it("edits scene_ref scene id and clears current variant", async () => {
    const user = userEvent.setup();
    scenesState.names = ["闹市街头", "森林"];
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ scene_ref: { scene_id: "闹市街头", variant_id: "雨夜" } })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    // 这里原本还断言「场景变体」不出现。那条断言从标签改名起就一直是空跑的：本地
    // i18n 抄的是旧值「变体」，查「场景变体」自然查不到。换成真词条后才露出来 ——
    // beat 上带着 variant_id: "雨夜"，变体选择器本来就该在。真正要验的是换场景后
    // variant_id 被清掉，下面那条断言已经盯着了。
    // Scene is now a base-scene dropdown sourced from the episode scene menu.
    await user.click(screen.getByRole("combobox", { name: "场景" }));
    await user.click(await screen.findByRole("option", { name: "森林" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({
      scene_ref: { scene_id: "森林", variant_id: "" },
    });
  });

  it("writes canonical base and variant when selecting an underscore scene", async () => {
    const user = userEvent.setup();
    scenesState.names = ["卫生间", "卫生间_漏水"];
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ scene_ref: { scene_id: "卫生间" } })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    await user.click(screen.getByRole("combobox", { name: "场景变体" }));
    await user.click(await screen.findByRole("option", { name: "漏水" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({
      scene_ref: { scene_id: "卫生间", variant_id: "漏水" },
    });
  });

  it("filters time-version scene plates out of the scene selector", async () => {
    const user = userEvent.setup();
    scenesState.records = [
      { name: "卫生间", base_scene_id: "", variant_id: "", time_of_day: "" },
      { name: "卫生间_漏水", base_scene_id: "卫生间", variant_id: "漏水", time_of_day: "" },
      {
        name: "卫生间_漏水_夜晚",
        base_scene_id: "卫生间",
        variant_id: "漏水",
        time_of_day: "夜晚",
      },
    ];
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ scene_ref: { scene_id: "卫生间" } })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    await user.click(screen.getByRole("combobox", { name: "场景变体" }));
    expect(
      screen.queryByRole("option", { name: "漏水_夜晚" }),
    ).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "漏水" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({
      scene_ref: { scene_id: "卫生间", variant_id: "漏水" },
    });
  });

  it("shows the composed scene name when the beat has a scene variant", () => {
    scenesState.names = ["卫生间", "卫生间_漏水"];
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ scene_ref: { scene_id: "卫生间", variant_id: "漏水" } })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    expect(screen.getByRole("combobox", { name: "场景" })).toHaveTextContent("卫生间");
    expect(screen.getByRole("combobox", { name: "场景变体" })).toHaveTextContent("漏水");
    expect(screen.getByText("Render：将使用 卫生间_漏水_夜晚，锁图光")).toBeInTheDocument();
  });

  it("does not duplicate scene saves on unmount with an explicit empty variant", async () => {
    const user = userEvent.setup();
    scenesState.names = ["闹市街头", "森林"];
    const { unmount } = render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ scene_ref: { scene_id: "闹市街头", variant_id: "雨夜" } })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    await user.click(screen.getByRole("combobox", { name: "场景" }));
    await user.click(await screen.findByRole("option", { name: "森林" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    mutateAsync.mockClear();

    unmount();

    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("does not duplicate canonical scene saves on unmount", async () => {
    const user = userEvent.setup();
    scenesState.records = [];
    const beat = makeBeat({ scene_ref: { scene_id: "卫生间", variant_id: "" } });
    const { rerender, unmount } = render(
      <Wrapper>
        <TextPane beat={beat} project="demo" episode={1} />
      </Wrapper>,
    );

    scenesState.records = [
      { name: "卫生间", base_scene_id: "", variant_id: "", time_of_day: "" },
      {
        name: "卫生间_漏水_严重",
        base_scene_id: "卫生间",
        variant_id: "漏水_严重",
        time_of_day: "",
      },
    ];
    rerender(
      <Wrapper>
        <TextPane beat={beat} project="demo" episode={1} />
      </Wrapper>,
    );

    await user.click(screen.getByRole("combobox", { name: "场景变体" }));
    await user.click(await screen.findByRole("option", { name: "漏水_严重" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].data).toEqual({
      scene_ref: { scene_id: "卫生间", variant_id: "漏水_严重" },
    });
    mutateAsync.mockClear();

    unmount();

    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("does not PATCH when textarea blur value is unchanged", () => {
    episodeDetailState.identity_ids = [];
    render(
      <Wrapper>
        <TextPane beat={makeBeat()} project="demo" episode={1} />
      </Wrapper>,
    );

    const narration = screen.getByDisplayValue("我带着丧尸病毒样本来，坠入闹市街头。");
    fireEvent.blur(narration);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("does not PATCH on unmount when mention options load without user edits", () => {
    episodeDetailState.identity_ids = [];
    const beat = makeBeat({
      visual_description: "@陆辰_青年 拿起玉佩",
      detected_identities: [],
    });
    const { rerender, unmount } = render(
      <Wrapper>
        <TextPane beat={beat} project="demo" episode={1} />
      </Wrapper>,
    );

    episodeDetailState.identity_ids = ["陆辰_青年"];
    rerender(
      <Wrapper>
        <TextPane beat={beat} project="demo" episode={1} />
      </Wrapper>,
    );
    unmount();

    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("uses latest mention options when flushing a dirty visual draft on unmount", () => {
    episodeDetailState.identity_ids = [];
    const beat = makeBeat({ visual_description: "原画面" });
    const { rerender, unmount } = render(
      <Wrapper>
        <TextPane beat={beat} project="demo" episode={1} />
      </Wrapper>,
    );

    fireEvent.change(screen.getByDisplayValue("原画面"), {
      target: { value: "@陆辰_青年 拿起玉佩" },
    });
    episodeDetailState.identity_ids = ["陆辰_青年"];
    rerender(
      <Wrapper>
        <TextPane beat={beat} project="demo" episode={1} />
      </Wrapper>,
    );
    unmount();

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({
      visual_description: "{{陆辰_青年}} 拿起玉佩",
      detected_identities: ["陆辰_青年"],
    });
  });

  it("converts visual @ mentions to program markers and syncs detected references", () => {
    episodeDetailState.identity_ids = ["陆辰_青年"];
    episodeDetailState.prop_menu = [{ prop_id: "玉佩" }];
    render(
      <Wrapper>
        <TextPane beat={makeBeat()} project="demo" episode={1} />
      </Wrapper>,
    );

    const visual = screen.getByDisplayValue("阳光刺眼的繁忙街头");
    fireEvent.change(visual, { target: { value: "@陆辰_青年 拿起 @玉佩" } });
    fireEvent.blur(visual);

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({
      visual_description: "{{陆辰_青年}} 拿起 [[玉佩]]",
      detected_identities: ["陆辰_青年"],
      detected_props: ["玉佩"],
    });
  });

  it("renders stored program markers as user-facing @ mentions", () => {
    episodeDetailState.identity_ids = ["陆辰_青年"];
    episodeDetailState.prop_menu = [{ prop_id: "玉佩" }];
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({
            visual_description: "{{陆辰_青年}} 拿起 [[玉佩]]",
          })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    expect(screen.getByDisplayValue("@陆辰_青年 拿起 @玉佩")).toBeInTheDocument();
  });
});
