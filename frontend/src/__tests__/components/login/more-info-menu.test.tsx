// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const runtimeState = vi.hoisted(() => ({ isCe: false }));
const translationState = vi.hoisted(() => ({ language: "zh" }));

vi.mock("@/lib/runtime-config", () => ({
  isCeRuntime: () => runtimeState.isCe,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: () =>
      translationState.language === "en" ? "More information" : "更多信息",
    i18n: { language: translationState.language },
  }),
}));

import { MoreInfoMenu } from "@/components/login/cinematic/MoreInfoMenu";

const validItems = [
  {
    id: "guide",
    title: "使用说明",
    content_type: "markdown",
    content: "## 使用说明",
    url: "",
    panel_width: 360,
    panel_height: 440,
    panel_width_auto: false,
    panel_height_auto: false,
  },
  {
    id: "poster",
    title: "活动海报",
    content_type: "image",
    content: "https://example.com/poster.png",
    url: "",
    panel_width: 480,
    panel_height: 520,
    panel_width_auto: false,
    panel_height_auto: true,
  },
  {
    id: "docs",
    title: "帮助中心",
    content_type: "link",
    content: "",
    url: "https://example.com/docs",
    panel_width: 360,
    panel_height: 440,
    panel_width_auto: false,
    panel_height_auto: false,
  },
] as const;

function mockResponse(body: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok,
      json: vi.fn().mockResolvedValue(body),
    }),
  );
}

describe("MoreInfoMenu", () => {
  beforeEach(() => {
    runtimeState.isCe = false;
    translationState.language = "zh";
    vi.unstubAllGlobals();
  });

  it("does not request or render EE information in CE", () => {
    runtimeState.isCe = true;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<MoreInfoMenu />);

    expect(container.firstChild).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads and renders markdown, image, and external link items in EE", async () => {
    mockResponse({ ok: true, items: validItems });
    render(<MoreInfoMenu />);

    const trigger = await screen.findByRole("button", { name: "更多信息" });
    fireEvent.focus(trigger);
    const helpItem = screen.getByRole("menuitem", { name: "帮助中心" });
    expect(helpItem.tagName).toBe("A");
    expect(helpItem).toHaveAttribute("href", "https://example.com/docs");

    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "使用说明" }));
    expect(await screen.findByRole("heading", { name: "使用说明" })).toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "活动海报" }));
    expect(await screen.findByRole("img", { name: "活动海报" })).toHaveAttribute(
      "src",
      "https://example.com/poster.png",
    );
  });

  it.each([
    ["a failed request", null, false],
    ["an invalid response", { items: [{ id: "broken" }] }, true],
    [
      "an unsafe external URL",
      {
        items: [
          {
            ...validItems[2],
            url: "javascript:alert(1)",
          },
        ],
      },
      true,
    ],
  ])("stays hidden for %s", async (_label, body, ok) => {
    mockResponse(body, ok);
    const { container } = render(<MoreInfoMenu />);

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
  });

  it("updates the trigger and menu label when the language changes", async () => {
    mockResponse({ ok: true, items: validItems });
    const { rerender } = render(<MoreInfoMenu />);
    const trigger = await screen.findByRole("button", { name: "更多信息" });
    fireEvent.focus(trigger);

    translationState.language = "en";
    rerender(<MoreInfoMenu />);

    expect(screen.getByRole("button", { name: "More information" })).toBeInTheDocument();
    expect(screen.getByRole("menu", { name: "More information" })).toBeInTheDocument();
  });
});
