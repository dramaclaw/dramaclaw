// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 任务流的完成 toast 与日志必须落在 i18n 这一侧。
 *
 * review #462：完成分支原来直接 `toast.success(data.current_task)`，而 run_core
 * 收尾时固定写 `current_task="完成"`，英文界面的完成提示因此还是中文；空值时又
 * 硬编码回退到 "Task completed"，中文界面同样是错的。
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import i18next from "i18next";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";

import { useTaskStream } from "@/hooks/use-task-stream";
import { useAuthStore } from "@/stores/auth-store";

import { enTranslation } from "../helpers/i18n-fixtures";

class MockEventSource {
  static instances: MockEventSource[] = [];
  readyState = 1;
  listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  onerror: ((event: Event) => void) | null = null;

  constructor(
    public readonly url: string,
    public readonly options?: EventSourceInit,
  ) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback =
      typeof listener === "function"
        ? (listener as (event: MessageEvent) => void)
        : (event: MessageEvent) => listener.handleEvent(event);
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }

  emit(type: string, payload: unknown) {
    const event = { data: JSON.stringify(payload) } as MessageEvent;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close() {
    this.readyState = 2;
  }
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function mountStream() {
  return renderHook(
    () =>
      useTaskStream({
        taskType: "ingest_fast",
        project: "demo",
        episode: 0,
      }),
    { wrapper },
  );
}

beforeEach(() => {
  MockEventSource.instances.length = 0;
  // @ts-expect-error test EventSource replacement
  globalThis.EventSource = MockEventSource;
  useAuthStore.setState({ username: "alice", role: "admin" });
  vi.mocked(toast.success).mockClear();
  i18next.addResourceBundle("en", "translation", enTranslation, true, true);
});

afterEach(async () => {
  await act(async () => {
    await i18next.changeLanguage("zh");
  });
});

describe("useTaskStream 完成 toast", () => {
  it("英文界面下不回显后端的「完成」哨兵，用状态词条", async () => {
    await act(async () => {
      await i18next.changeLanguage("en");
    });
    mountStream();
    const stream = MockEventSource.instances[0];

    act(() => {
      stream.emit("completed", {
        status: "completed",
        progress: 1,
        current_task: "完成",
      });
    });

    expect(toast.success).toHaveBeenCalledWith("Completed");
  });

  it("后端没给完成文案时也走词条，不是硬编码的英文", () => {
    mountStream();
    const stream = MockEventSource.instances[0];

    act(() => {
      stream.emit("completed", { status: "completed", progress: 1 });
    });

    expect(toast.success).toHaveBeenCalledWith("已完成");
  });

  it("后端给了真实收尾文案时，按 code 翻译后再提示", async () => {
    await act(async () => {
      await i18next.changeLanguage("en");
    });
    mountStream();
    const stream = MockEventSource.instances[0];

    act(() => {
      stream.emit("completed", {
        status: "completed",
        progress: 1,
        current_task: "场景提取完成",
        current_task_code: "tasks.progress.scenes.complete",
      });
    });

    expect(toast.success).toHaveBeenCalledWith("Scene extraction complete");
  });
});

describe("useTaskStream 日志兼容", () => {
  it("老后端只发 logs（string[]）时照常显示", () => {
    const { result } = mountStream();
    const stream = MockEventSource.instances[0];

    act(() => {
      stream.emit("running", {
        status: "running",
        progress: 0.3,
        current_task: "正在切分章节...",
        logs: ["任务已开始", "原文已保存"],
      });
    });

    expect(result.current.logs).toEqual(["任务已开始", "原文已保存"]);
  });

  it("新后端同时发 logs 和 logs_i18n 时，按结构化那份翻译", async () => {
    await act(async () => {
      await i18next.changeLanguage("en");
    });
    const { result } = mountStream();
    const stream = MockEventSource.instances[0];

    act(() => {
      stream.emit("running", {
        status: "running",
        progress: 0.3,
        current_task: "原文已保存",
        logs: ["原文已保存"],
        logs_i18n: [{ text: "原文已保存", code: "tasks.log.ingest.sourceSaved" }],
      });
    });

    expect(result.current.logs).toEqual(["Source text saved"]);
  });
});
