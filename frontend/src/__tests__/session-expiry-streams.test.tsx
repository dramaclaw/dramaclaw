// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (value: string) => value }),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { openTaskStream } from "@/api/tasks";
import { useTaskStream } from "@/hooks/use-task-stream";
import { SESSION_EXPIRED_EVENT } from "@/lib/session-expiry";
import { useAuthStore } from "@/stores/auth-store";

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

beforeEach(() => {
  MockEventSource.instances.length = 0;
  // @ts-expect-error test EventSource replacement
  globalThis.EventSource = MockEventSource;
  useAuthStore.setState({ username: "alice", role: "admin" });
});

describe("session-expired stream teardown", () => {
  it("closes the freezone task stream immediately", () => {
    const handle = openTaskStream({
      projectId: "demo",
      onTask: vi.fn(),
    });
    const stream = MockEventSource.instances[0];

    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));

    expect(stream.readyState).toBe(2);
    handle.close();
  });

  it("closes the legacy task stream immediately", () => {
    const { unmount } = renderHook(
      () =>
        useTaskStream({
          taskType: "script_writer",
          project: "demo",
          episode: 1,
        }),
      { wrapper },
    );
    const stream = MockEventSource.instances[0];

    act(() => {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    });

    expect(stream.readyState).toBe(2);
    unmount();
  });
});
