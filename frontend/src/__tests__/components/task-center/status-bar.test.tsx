// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import i18n from "@/i18n";
import { TaskStatusBar } from "@/components/task-center/status-bar";
import { useTaskCenterStore } from "@/task-center/store";
import { sampleTask } from "@/__mocks__/msw/handlers/tasks";
import enTranslation from "../../../../public/locales/en/translation.json";
import zhTranslation from "../../../../public/locales/zh/translation.json";

function renderBar(onOpenPikoStation?: () => void) {
  return render(
    <I18nextProvider i18n={i18n}>
      <TaskStatusBar onOpenPikoStation={onOpenPikoStation} />
    </I18nextProvider>,
  );
}

beforeAll(async () => {
  // HttpBackend can't reach /locales/*.json under jsdom, so seed the bundles
  // synchronously and drive init to completion so useTranslation() doesn't suspend.
  if (!i18n.isInitialized) {
    await i18n.init({
      lng: "en",
      fallbackLng: "en",
      resources: {
        en: { translation: enTranslation },
        zh: { translation: zhTranslation },
      },
    });
  }
  i18n.addResourceBundle("en", "translation", enTranslation, true, true);
  i18n.addResourceBundle("zh", "translation", zhTranslation, true, true);
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  useTaskCenterStore.getState().reset();
});

describe("TaskStatusBar", () => {
  it("renders idle when store is empty", () => {
    renderBar();
    expect(screen.getByText(/idle|空闲/i)).toBeInTheDocument();
  });

  it("shows running count when any task is running", () => {
    useTaskCenterStore.getState().hydrate([
      sampleTask({ task_key: "a", status: "running", created_at: "2026-04-18T14:00:00Z" }),
      sampleTask({ task_key: "b", status: "running", created_at: "2026-04-18T14:00:10Z" }),
    ]);
    renderBar();
    // The running count chip shows "2"
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("surfaces leading task label", () => {
    useTaskCenterStore.getState().hydrate([
      sampleTask({
        task_key: "a",
        task_type: "script_writer",
        episode: 3,
        status: "running",
        progress: 0.42,
        created_at: "2026-04-18T14:00:00Z",
      }),
    ]);
    renderBar();
    expect(screen.getByText(/Script writer|ep3/i)).toBeInTheDocument();
  });

  it("shows recent completion when nothing running", () => {
    const recent = new Date(Date.now() - 30_000).toISOString();
    useTaskCenterStore.getState().hydrate([
      sampleTask({
        task_key: "c",
        status: "completed",
        completed_at: recent,
      }),
    ]);
    renderBar();
    expect(screen.getByText(/✓/)).toBeInTheDocument();
  });

  it("shows health indicator reflecting streamHealth state", () => {
    useTaskCenterStore.getState().setHealth("reconnecting");
    renderBar();
    // Both the sr-only and the visible label exist; we just assert at least one match.
    const matches = screen.getAllByText(/reconnecting|重新连接/i);
    expect(matches.length).toBeGreaterThan(0);
  });

  it("renders the image-based Piko launcher and preserves its action semantics", () => {
    const onOpenPikoStation = vi.fn();
    const { container } = renderBar(onOpenPikoStation);
    const launcher = screen.getByRole("button", {
      name: enTranslation.pikoMiniGame.statusTooltip,
    });
    const artwork = container.querySelector<HTMLImageElement>(
      'img[src="/piko/entry/piko-game-launcher.png"]',
    );

    expect(artwork).toHaveAttribute("alt", "");
    expect(artwork).toHaveAttribute("aria-hidden", "true");
    expect(artwork).toHaveClass("h-[30px]");
    expect(artwork).toHaveClass("-translate-y-px");
    expect(artwork).toHaveClass("opacity-90");
    fireEvent.click(launcher);
    expect(onOpenPikoStation).toHaveBeenCalledTimes(1);
  });
});
