// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import ky from "ky";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
  uploadApi: ky.create({ baseUrl: "http://localhost:3000/" }),
}));

import { CharacterVoicePanel } from "@/components/assets/character-voice-panel";
import type { Character } from "@/types/character";

const server = setupServer();
const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "zh",
    resources: {
      zh: {
        translation: {
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
  server.listen();
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </I18nextProvider>
  );
}

function renderPanel(character: Character) {
  return render(
    <CharacterVoicePanel project="demo" character={character} />,
    { wrapper },
  );
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
    expect(screen.getAllByRole("button", { name: "上传声音样本" })).toHaveLength(4);
    expect(screen.getAllByRole("button", { name: "录音" })).toHaveLength(4);
    expect(screen.getAllByRole("button", { name: "裁剪到 3-5 秒" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "清除" })).toHaveLength(2);

    const audio = await waitFor(() => {
      const el = container.querySelector("audio");
      expect(el).not.toBeNull();
      return el as HTMLAudioElement;
    });
    Object.defineProperty(audio, "duration", { value: 6.5, configurable: true });
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
