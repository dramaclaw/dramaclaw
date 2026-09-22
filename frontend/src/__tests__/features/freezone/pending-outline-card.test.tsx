// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// 确认大纲的动线契约：
// 1) revision 冲突只刷新画布请用户复核，绝不自动重试确认（否则会替用户
//    确认一份没看过的新大纲）；
// 2) 确认成功后画布刷新，并触发 onConfirmed 让外壳「提交并继续」。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { PendingOutlineCard } from "@/features/freezone/PendingOutlineCard";
import { confirmStoryOutline } from "@/api/interactiveStoryOutline";
import { refreshRemoteFreezoneCanvas } from "@/features/freezone/canvasSyncRuntime";
import type { PendingStoryOutline } from "@/features/canvas/story/pendingStoryOutline";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));
vi.mock("@/api/interactiveStoryOutline", () => ({ confirmStoryOutline: vi.fn() }));
vi.mock("@/features/freezone/canvasSyncRuntime", () => ({
  refreshRemoteFreezoneCanvas: vi.fn(async () => undefined),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function outline(overrides: Partial<PendingStoryOutline> = {}): PendingStoryOutline {
  return {
    outline_id: "outline-round-1",
    kind: "story",
    title: "雨夜出租车",
    premise: "p",
    plot_summary: "s",
    interaction_summary: "",
    endings_summary: "",
    duration_budget_sec: null,
    open_questions: [],
    status: "pending",
    story_id: null,
    updated_at: "2026-09-21T00:00:00Z",
    ...overrides,
  };
}

async function clickConfirm(view: ReturnType<typeof render>) {
  fireEvent.click(view.getByRole("button", { name: "freezone.outline.confirm" }));
  await waitFor(() => expect(confirmStoryOutline).toHaveBeenCalledTimes(1));
}

describe("PendingOutlineCard confirm flow", () => {
  it("revises the conflict path: refresh only, never an automatic second confirm", async () => {
    vi.mocked(refreshRemoteFreezoneCanvas).mockResolvedValue(true);
    vi.mocked(confirmStoryOutline).mockResolvedValue({ kind: "stale", currentRevision: 9 });
    const onConfirmed = vi.fn();
    const view = render(
      <PendingOutlineCard
        projectId="p1"
        canvasId="c1"
        outline={outline()}
        canvasRevision={3}
        onConfirmed={onConfirmed}
      />,
    );

    await clickConfirm(view);

    // 只发了一次确认请求：即使命令端报告了 current_revision，也不得自动重试。
    await waitFor(() => expect(refreshRemoteFreezoneCanvas).toHaveBeenCalledTimes(1));
    expect(confirmStoryOutline).toHaveBeenCalledTimes(1);
    expect(confirmStoryOutline).toHaveBeenCalledWith("p1", expect.objectContaining({
      outline_id: "outline-round-1",
      status: "confirmed",
      base_revision: 3,
    }));
    expect(view.getByText("freezone.outline.superseded")).toBeInTheDocument();
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("confirms once, refreshes the canvas, then hands off to onConfirmed", async () => {
    vi.mocked(refreshRemoteFreezoneCanvas).mockResolvedValue(true);
    vi.mocked(confirmStoryOutline).mockResolvedValue({
      kind: "confirmed",
      result: {
        ok: true,
        project_id: "p1",
        canvas_id: "c1",
        outline_id: "outline-round-1",
        status: "confirmed",
        revision: 4,
        refresh_canvas: true,
      },
    });
    const onConfirmed = vi.fn();
    const pending = outline();
    const view = render(
      <PendingOutlineCard
        projectId="p1"
        canvasId="c1"
        outline={pending}
        canvasRevision={3}
        onConfirmed={onConfirmed}
      />,
    );

    await clickConfirm(view);

    await waitFor(() => expect(onConfirmed).toHaveBeenCalledTimes(1));
    expect(onConfirmed).toHaveBeenCalledWith(pending);
    expect(refreshRemoteFreezoneCanvas).toHaveBeenCalledTimes(1);
    expect(view.queryByText("freezone.outline.superseded")).toBeNull();
  });

  it("needs-revision success hands off to onRevisionRequested, never to onConfirmed", async () => {
    vi.mocked(refreshRemoteFreezoneCanvas).mockResolvedValue(true);
    // 后端对两种决策都返回成功信封（kind 'confirmed'），status 才是真实落定状态；
    // 回归点 1：曾经把「需要修改」当成确认，代投了「大纲已确认」消息；
    // 回归点 2：曾经什么都不接，点「需要修改」没任何后续动线（Agent 无从知道要改什么）。
    vi.mocked(confirmStoryOutline).mockResolvedValue({
      kind: "confirmed",
      result: {
        ok: true,
        project_id: "p1",
        canvas_id: "c1",
        outline_id: "outline-round-1",
        status: "needs_revision",
        revision: 4,
        refresh_canvas: true,
      },
    });
    const onConfirmed = vi.fn();
    const onRevisionRequested = vi.fn();
    const pending = outline({ status: "pending" });
    const view = render(
      <PendingOutlineCard
        projectId="p1"
        canvasId="c1"
        outline={pending}
        canvasRevision={3}
        onConfirmed={onConfirmed}
        onRevisionRequested={onRevisionRequested}
      />,
    );

    fireEvent.click(view.getByRole("button", { name: "freezone.outline.needsRevision" }));
    await waitFor(() => expect(confirmStoryOutline).toHaveBeenCalledTimes(1));
    expect(confirmStoryOutline).toHaveBeenCalledWith("p1", expect.objectContaining({
      status: "needs_revision",
    }));
    await waitFor(() => expect(refreshRemoteFreezoneCanvas).toHaveBeenCalledTimes(1));
    expect(onRevisionRequested).toHaveBeenCalledWith(pending);
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it.each([
    ["confirmed", "freezone.outline.confirm"],
    ["needs_revision", "freezone.outline.needsRevision"],
  ] as const)(
    "does not continue after a %s decision when protected refresh is blocked",
    async (status, buttonName) => {
      vi.mocked(refreshRemoteFreezoneCanvas).mockResolvedValue(false);
      vi.mocked(confirmStoryOutline).mockResolvedValue({
        kind: "confirmed",
        result: {
          ok: true,
          project_id: "p1",
          canvas_id: "c1",
          outline_id: "outline-round-1",
          status,
          revision: 4,
          refresh_canvas: true,
        },
      });
      const onConfirmed = vi.fn();
      const onRevisionRequested = vi.fn();
      const view = render(
        <PendingOutlineCard
          projectId="p1"
          canvasId="c1"
          outline={outline()}
          canvasRevision={3}
          onConfirmed={onConfirmed}
          onRevisionRequested={onRevisionRequested}
        />,
      );

      fireEvent.click(view.getByRole("button", { name: buttonName }));

      await waitFor(() =>
        expect(view.getByText("freezone.outline.refreshBlocked")).toBeInTheDocument(),
      );
      expect(refreshRemoteFreezoneCanvas).toHaveBeenCalledTimes(1);
      expect(onConfirmed).not.toHaveBeenCalled();
      expect(onRevisionRequested).not.toHaveBeenCalled();
    },
  );
});

describe("PendingOutlineCard duration label", () => {
  function renderWithDuration(seconds: number) {
    return render(
      <PendingOutlineCard
        projectId="p1"
        canvasId="c1"
        outline={outline({ duration_budget_sec: seconds })}
        canvasRevision={3}
      />,
    );
  }

  it("shows sub-minute budgets in seconds instead of rounding them up to 1 minute", () => {
    const view = renderWithDuration(15);
    // 15 秒广告曾被四舍五入成「1 分钟」；不到 60 秒必须按秒展示。
    expect(view.getByText('freezone.outline.durationSeconds:{"seconds":15}')).toBeInTheDocument();
    expect(view.queryByText(/freezone\.outline\.duration:/)).toBeNull();
  });

  it("keeps minute display for budgets of a minute and above", () => {
    const view = renderWithDuration(240);
    expect(view.getByText('freezone.outline.duration:{"minutes":4}')).toBeInTheDocument();
    expect(view.queryByText(/durationSeconds/)).toBeNull();
  });
});
