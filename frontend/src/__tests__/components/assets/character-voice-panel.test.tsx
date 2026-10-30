// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { http, HttpResponse } from "msw";
import { server } from "@/__mocks__/msw/server";
import ky from "ky";
import type { ReactNode } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
  uploadApi: ky.create({ baseUrl: "http://localhost:3000/" }),
}));

import { CharacterVoicePanel } from "@/components/assets/character-voice-panel";
import type { Character } from "@/types/character";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "zh",
    resources: {
      zh: {
        translation: {
          voiceDesign: {
            entry: "按描述生成",
            title: "按描述生成声线",
            target: "保存位置：{{target}}",
            saveSlot: "保存到{{slot}}",
            description: "音色描述",
            previewText: "试听文本",
            generate: "生成试听",
            replace: "替换",
            close: "关闭",
          },
          characters: {
            voiceSamples: {
              title: "声线管理 (IndexTTS2)",
              hint: "通常只需上传默认声线；只有年龄变体需要不同声音时再覆盖。",
              defaultRequired: "默认（必填）",
              ageDefaultRequired: "{{age}}（默认 · 必填）",
              optionalOverride: "{{age}}（可选覆盖）",
              missingDefault: "未配置 → 角色将无法出声",
              inheritedDefault: "→ 继承默认",
              missing: "未配置",
              upload: "上传声音样本",
              record: "录音",
              trim: "裁剪到 3-5 秒",
              clear: "清除",
              loading: "正在读取声线样本",
              loadFailed: "读取声线样本失败",
              currentDuration: "当前约 {{seconds}} 秒",
            },
            ageGroups: {
              child: "幼年",
              young: "青年",
              middle: "中年",
              elder: "老年",
            },
          },
          common: {
            error: "错误",
          },
        },
      },
    },
    interpolation: { escapeValue: false },
  });
});
beforeEach(() =>
  server.use(
    http.get(
      "http://localhost:3000/api/v1/projects/demo/voice-design/quote",
      () =>
        HttpResponse.json(
          {
            ok: false,
            code: "voice_design_unavailable",
            error: "disabled",
            retryable: false,
            request_id: "178727cd-e421-451c-87e7-68779d72a8ec",
          },
          { status: 503 },
        ),
    ),
  ),
);
afterEach(() => server.resetHandlers());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </I18nextProvider>
  );
}

function renderPanel(character: Character) {
  return render(<CharacterVoicePanel project="demo" character={character} />, {
    wrapper,
  });
}

describe("CharacterVoicePanel", () => {
  it("renders default and age voice slots with inherited status and actions", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/characters/%E7%A7%A6/voice-samples",
        () =>
          HttpResponse.json({
            ok: true,
            data: {
              character: "秦",
              slots: [
                {
                  slot: "default",
                  label: "默认（兜底）",
                  path: "assets/characters/秦/voices/voice_default.wav",
                  url: "/static/admin/demo/assets/characters/秦/voices/voice_default.wav",
                  sha256: "sha-default",
                  updated_at: "2026-05-13T00:00:00+00:00",
                  inherited_from_default: false,
                  required: true,
                },
                {
                  slot: "child",
                  label: "幼年",
                  path: "",
                  url: "",
                  sha256: "",
                  updated_at: "",
                  inherited_from_default: true,
                  required: false,
                },
                {
                  slot: "youth",
                  label: "青年",
                  path: "",
                  url: "",
                  sha256: "",
                  updated_at: "",
                  inherited_from_default: true,
                  required: false,
                },
                {
                  slot: "middle",
                  label: "中年",
                  path: "",
                  url: "",
                  sha256: "",
                  updated_at: "",
                  inherited_from_default: true,
                  required: false,
                },
                {
                  slot: "elder",
                  label: "老年",
                  path: "assets/characters/秦/voices/voice_elder.wav",
                  url: "/static/admin/demo/assets/characters/秦/voices/voice_elder.wav",
                  sha256: "sha-elder",
                  updated_at: "2026-05-13T00:00:01+00:00",
                  inherited_from_default: false,
                  required: false,
                },
              ],
            },
          }),
      ),
    );

    const { container } = renderPanel({ name: "秦", age_group: "youth" });

    expect(await screen.findByText("声线管理 (IndexTTS2)")).toBeInTheDocument();
    expect(await screen.findByText("青年（默认 · 必填）")).toBeInTheDocument();
    expect(screen.getByText("幼年（可选覆盖）")).toBeInTheDocument();
    expect(screen.getAllByText("→ 继承默认").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("voice_elder.wav")).toHaveAttribute(
      "title",
      "assets/characters/秦/voices/voice_elder.wav",
    );
    expect(
      screen.getAllByRole("button", { name: "上传声音样本" }),
    ).toHaveLength(4);
    expect(screen.getAllByRole("button", { name: "录音" })).toHaveLength(4);
    expect(
      screen.queryByRole("button", { name: "按描述生成" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "裁剪到 3-5 秒" }),
    ).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "清除" })).toHaveLength(2);

    const audio = await waitFor(() => {
      const el = container.querySelector("audio");
      expect(el).not.toBeNull();
      return el as HTMLAudioElement;
    });
    Object.defineProperty(audio, "duration", {
      value: 6.5,
      configurable: true,
    });
    fireEvent.loadedMetadata(audio);
    expect(await screen.findByText("当前约 6.5 秒")).toBeInTheDocument();
  });

  it("warns when the default voice is missing", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/characters/%E7%A7%A6/voice-samples",
        () =>
          HttpResponse.json({
            ok: true,
            data: {
              character: "秦",
              slots: [
                {
                  slot: "default",
                  label: "默认（兜底）",
                  path: "",
                  url: "",
                  sha256: "",
                  updated_at: "",
                  inherited_from_default: false,
                  required: true,
                },
              ],
            },
          }),
      ),
    );

    renderPanel({ name: "秦" });

    await waitFor(() =>
      expect(screen.getByText("未配置 → 角色将无法出声")).toBeInTheDocument(),
    );
  });

  it("shows an error instead of crashing when the voice API returns ok false", async () => {
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/characters/%E7%A7%A6/voice-samples",
        () =>
          HttpResponse.json({
            ok: false,
            error: "Character '秦' not found",
          }),
      ),
    );

    renderPanel({ name: "秦" });

    expect(await screen.findByText("读取声线样本失败")).toBeInTheDocument();
  });
});

it("saves a primary-age entry to actionSlot default, preserving upload actions", async () => {
  const slot = {
    slot: "default",
    label: "默认（兜底）",
    path: "",
    url: "",
    sha256: "",
    updated_at: "",
    required: true,
    inherited_from_default: false,
  };
  const base = "http://localhost:3000/api/v1/projects/demo";
  let saved: unknown;
  let uploads = 0;
  server.use(
    http.get(`${base}/voice-design/quote`, () =>
      HttpResponse.json({
        ok: true,
        data: { cost: 2, display: "2", unit: "call", quantity: 1 },
      }),
    ),
    http.get(`${base}/characters/%E7%A7%A6/voice-samples`, () =>
      HttpResponse.json({ ok: true, data: { character: "秦", slots: [slot] } }),
    ),
    http.post(`${base}/voice-design/candidates`, async ({ request }) => {
      const data = (await request.json()) as {
        request_id: string;
        surface: string;
      };
      expect(data.surface).toBe("supertale");
      return HttpResponse.json({
        ok: true,
        data: {
          candidate_id: data.request_id,
          status: "ready",
          description: "温柔",
          preview_text: "今天的天气很好，我们沿着河边慢慢走回家。",
          language: "zh",
          preview_url: `/api/v1/projects/demo/voice-design/candidates/${data.request_id}/audio`,
          mime_type: "audio/mpeg",
          duration_seconds: 4,
          sha256: "a".repeat(64),
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        },
      });
    }),
    http.post(
      `${base}/characters/%E7%A7%A6/voice-samples/default/save-generated`,
      async ({ request }) => {
        saved = await request.json();
        return HttpResponse.json({
          ok: true,
          data: { ...slot, path: "new.wav", url: "/new.wav", sha256: "new" },
        });
      },
    ),
    http.post(
      `${base}/characters/%E7%A7%A6/voice-samples/default/upload`,
      () => {
        uploads++;
        return HttpResponse.json({
          ok: true,
          data: { ...slot, path: "uploaded.wav", url: "/uploaded.wav" },
        });
      },
    ),
  );
  const { container } = renderPanel({ name: "秦", age_group: "youth" });
  const entries = await screen.findAllByRole("button", { name: "按描述生成" });
  expect(entries).toHaveLength(4);
  fireEvent.click(entries[1]);
  expect(
    await screen.findByText("保存位置：秦 · 默认（兜底）"),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("音色描述"), {
    target: { value: "温柔" },
  });
  fireEvent.change(screen.getByLabelText("试听文本"), {
    target: { value: "今天的天气很好，我们沿着河边慢慢走回家。" },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "生成试听" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "生成试听" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "保存到默认（兜底）" }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "保存到默认（兜底）" }));
  await waitFor(() =>
    expect(saved).toMatchObject({
      expected_slot: { path: "", sha256: "", updated_at: "" },
      replace_existing: false,
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getAllByRole("button", { name: "上传声音样本" })[1]);
  const input = container.querySelector('input[type="file"]');
  if (!input) throw new Error("missing file input");
  fireEvent.change(input, {
    target: {
      files: [new File(["audio"], "voice.wav", { type: "audio/wav" })],
    },
  });
  await waitFor(() => expect(uploads).toBe(1));
});
