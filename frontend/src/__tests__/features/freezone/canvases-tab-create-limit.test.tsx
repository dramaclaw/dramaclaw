// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FreezoneCanvasSummary } from "@/api/canvas";
import { MAX_USER_CREATED_CANVASES_PER_PROJECT } from "@/lib/limits";
import { useAuthStore } from "@/stores/auth-store";

const CANVASES_ZH: Record<string, string> = {
  "freezone.canvases.createTitle": "新建项目画布",
  "freezone.canvases.createLimitTitle": "画布已达上限",
  "freezone.canvases.createLimitReached": "每人在一个项目里最多创建 {{limit}} 张画布，删掉一些再新建",
  "freezone.canvases.createPlaceholder": "新画布名称",
  "freezone.canvases.switcher": "切换画布",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      let value = CANVASES_ZH[key] ?? key;
      for (const [optKey, optValue] of Object.entries(options ?? {})) {
        value = value.split(`{{${optKey}}}`).join(String(optValue));
      }
      return value;
    },
  }),
}));

const listFreezoneCanvases = vi.fn();

vi.mock("@/api/canvas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/canvas")>()),
  listFreezoneCanvases: (...args: unknown[]) => listFreezoneCanvases(...args),
}));

type NoticeOptions = { title?: string; description: string };

const alertDialog = vi.hoisted(() =>
  vi.fn((_options: { title?: string; description: string }) => Promise.resolve()),
);

vi.mock("@/components/confirm-dialog-host", () => ({
  alertDialog: (options: NoticeOptions) => alertDialog(options),
  confirmDialog: vi.fn(() => Promise.resolve(false)),
}));

import { CanvasesTab } from "@/features/freezone/CanvasesTab";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function myCanvas(index: number): FreezoneCanvasSummary {
  return {
    id: `canvas_mine_${index}`,
    modified_at: "2026-06-03T00:00:00Z",
    size: 1,
    metadata: {
      canvas_origin: "user_created",
      display_name: `我的画布 ${index}`,
      creator_username: "admin",
    },
  } as FreezoneCanvasSummary;
}

async function openCanvasMenu() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "切换画布" }));
  return user;
}

describe("CanvasesTab canvas quota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ username: "admin", role: "admin" });
  });

  afterEach(() => {
    useAuthStore.setState({ username: null, role: null });
  });

  it("keeps the create entry clickable at the quota and explains itself in a dialog", async () => {
    listFreezoneCanvases.mockResolvedValue(
      Array.from({ length: MAX_USER_CREATED_CANVASES_PER_PROJECT }, (_unused, i) => myCanvas(i)),
    );

    render(
      <CanvasesTab project="demo" currentCanvasId="canvas_mine_0" hasPresetLabel={false} />,
      { wrapper },
    );

    const user = await openCanvasMenu();
    // 入口不置灰：用户点得到，才有地方把「为什么不行」说出来。
    const createItem = await screen.findByText("新建项目画布");
    await user.click(createItem);

    expect(alertDialog).toHaveBeenCalledTimes(1);
    expect(alertDialog.mock.calls[0][0]).toMatchObject({
      title: "画布已达上限",
      description: `每人在一个项目里最多创建 ${MAX_USER_CREATED_CANVASES_PER_PROJECT} 张画布，删掉一些再新建`,
    });
    // 弹窗代替表单：没到上限之前不该看到输入框。
    expect(screen.queryByPlaceholderText("新画布名称")).toBeNull();
  });

  it("keeps the create and delete entries out of the scrolling canvas list", async () => {
    listFreezoneCanvases.mockResolvedValue(
      Array.from({ length: MAX_USER_CREATED_CANVASES_PER_PROJECT }, (_unused, i) => myCanvas(i)),
    );

    render(
      <CanvasesTab project="demo" currentCanvasId="canvas_mine_0" hasPresetLabel={false} />,
      { wrapper },
    );

    await openCanvasMenu();
    const createItem = await screen.findByText("新建项目画布");
    const scroller = document.querySelector<HTMLElement>(
      '[data-slot="dropdown-menu-content"] .overflow-y-auto',
    );

    // 画布多到要滚时，滚的只能是列表本身；动作跟着列表滚就等于每次都要先拖到底。
    expect(scroller).not.toBeNull();
    expect(scroller!.querySelector('[data-slot="dropdown-menu-radio-item"]')).not.toBeNull();
    expect(scroller!.contains(createItem)).toBe(false);
  });

  it("opens the create form without a dialog below the quota", async () => {
    listFreezoneCanvases.mockResolvedValue(
      Array.from({ length: MAX_USER_CREATED_CANVASES_PER_PROJECT - 1 }, (_unused, i) =>
        myCanvas(i),
      ),
    );

    render(
      <CanvasesTab project="demo" currentCanvasId="canvas_mine_0" hasPresetLabel={false} />,
      { wrapper },
    );

    const user = await openCanvasMenu();
    await user.click(await screen.findByText("新建项目画布"));

    expect(alertDialog).not.toHaveBeenCalled();
    expect(await screen.findByPlaceholderText("新画布名称")).toBeTruthy();
  });
});
