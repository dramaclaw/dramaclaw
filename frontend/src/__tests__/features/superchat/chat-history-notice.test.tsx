// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatHistoryNotice } from "@/features/superchat/chat-history-notice";
import { useSuperChat } from "@/features/superchat/use-superchat";

const runtime = vi.hoisted(() => ({ ce: true }));
vi.mock("@/lib/runtime-config", () => ({ isCeRuntime: () => runtime.ce }));
vi.mock("@/lib/api", () => ({
  api: { post: vi.fn(() => ({ json: async () => ({ ok: true }) })) },
}));

class TestSocket {
  static OPEN = 1;
  static instances: TestSocket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror = null;
  onclose = null;
  constructor() { TestSocket.instances.push(this); }
  send() {}
  close() {}
}

const scope = {
  kind: "project", id: "history-notice-test", surface: "freezone",
  canvasId: "canvas", agentId: "main",
};

beforeEach(() => {
  runtime.ce = true;
  localStorage.clear();
  TestSocket.instances = [];
  vi.stubGlobal("WebSocket", TestSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mountChat() {
  const hook = renderHook(() => useSuperChat({
    project: scope.id, surface: "freezone", freezoneCanvasId: scope.canvasId,
    freezoneAgentId: scope.agentId, displayName: "Tester",
  }));
  await waitFor(() => expect(TestSocket.instances).toHaveLength(1));
  return hook;
}

async function history(incomplete: boolean) {
  await act(async () => {
    TestSocket.instances[0].onmessage?.({ data: JSON.stringify({
      type: "scope.changed", scope, busy: false,
      history: [{
        id: "assistant-history", role: "assistant", content: "Saved message",
        turn_id: "history-turn", ...(incomplete ? { parts_incomplete: true } : {}),
      }],
    }) } as MessageEvent);
  });
}

describe("CE history loading warning", () => {
  it("keeps incomplete history separate from chat errors and clears it after recovery", async () => {
    const hook = await mountChat();
    await history(true);
    expect(hook.result.current.historyIncomplete).toBe(true);
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.connected).toBe(true);
    expect(hook.result.current.busy).toBe(false);
    expect(hook.result.current.messages[0].text).toBe("Saved message");

    await act(async () => {
      TestSocket.instances[0].onmessage?.({ data: JSON.stringify({
        type: "error", scope, message: "Model connection failed",
      }) } as MessageEvent);
    });
    expect(hook.result.current.error).toBe("Model connection failed");
    expect(hook.result.current.historyIncomplete).toBe(true);

    await history(false);
    expect(hook.result.current.historyIncomplete).toBe(false);
  });

  it("preserves the existing administrator message in EE", async () => {
    runtime.ce = false;
    const hook = await mountChat();
    await history(true);
    expect(hook.result.current.historyIncomplete).toBe(false);
    expect(hook.result.current.error).toBe("此对话的部分历史内容过大，已限制加载；正文仍可查看，请联系管理员整理历史记录。");
    expect(render(<ChatHistoryNotice />).container).toBeEmptyDOMElement();
  });

  it.each(["zh", "en", "pt", "vi"])("offers localized, non-destructive help in %s", async (language) => {
    const translations = JSON.parse(readFileSync(`public/locales/${language}/translation.json`, "utf8"));
    const i18n = createInstance();
    await i18n.init({
      lng: language, fallbackLng: false,
      resources: { [language]: { translation: translations } },
      react: { useSuspense: false },
    });
    const labels = translations.chatSnapshot.ceHistory;
    const view = render(<I18nextProvider i18n={i18n}><ChatHistoryNotice /></I18nextProvider>);
    expect(view.getByRole("status")).toHaveTextContent(labels.title);
    expect(view.getByRole("status")).toHaveClass("bg-warning/8");
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.container.textContent).not.toContain("chatSnapshot.");
    expect(view.container.textContent).not.toContain(translations.chatSnapshot.historyIncomplete);
    const toggle = view.getByText(labels.help);
    expect(toggle.closest("details")).not.toHaveAttribute("open");
    fireEvent.click(toggle);
    expect(toggle.closest("details")).toHaveAttribute("open");
    expect(view.getByText(labels.backup)).toBeVisible();
    expect(view.getByText(labels.privacy)).toBeVisible();
    for (const [label, url] of [
      [labels.recoveryGuide, "https://github.com/dramaclaw/dramaclaw/blob/main/docs/chat-history-oom-recovery.md"],
      [labels.support, "https://github.com/dramaclaw/dramaclaw/issues/new/choose"],
    ]) {
      const link = view.getByRole("link", { name: label });
      expect(link).toHaveAttribute("href", url);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });
});
