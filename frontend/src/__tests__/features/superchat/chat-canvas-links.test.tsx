// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from "@testing-library/react";
import type { AnyRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("dramaclaw-spec-render", () => ({
  SpecRenderer: () => null,
  SpecRendererProvider: ({ children }: { children: ReactNode }) => children,
  VideoDetailModal: () => null,
}));

import { setAppRouter } from "@/lib/app-router";
import { MessageBubble } from "@/features/superchat/superchat-panel";

const PROJECT = "01M7A4MTT5KWZXF0GD7YR7E79J";
const CANVAS = "canvas_k4_36m2mz";
const CANVAS_PATH = `/projects/${PROJECT}/freezone?canvas=${CANVAS}`;

const sharedProps = {
  onOpenDetail: vi.fn(),
  onOpenMedia: vi.fn(),
  pinned: false,
  onDelete: vi.fn(),
  onTogglePin: vi.fn(),
};

function renderAssistant(text: string) {
  return render(
    <MessageBubble
      message={{ id: "message-1", role: "assistant", text, timestamp: 1 }}
      {...sharedProps}
    />,
  );
}

function registerRouter() {
  const navigate = vi.fn();
  setAppRouter({
    navigate,
    state: { location: { pathname: `/projects/${PROJECT}/assistant`, search: {} } },
  } as unknown as AnyRouter);
  return navigate;
}

// Records whether the app already handled each click, then stops jsdom from
// attempting a real page navigation for clicks the app leaves to the browser.
let browserDefault: boolean[] = [];
function recordClick(event: MouseEvent) {
  browserDefault.push(!event.defaultPrevented);
  event.preventDefault();
}

beforeEach(() => {
  browserDefault = [];
  document.addEventListener("click", recordClick);
});

afterEach(() => {
  document.removeEventListener("click", recordClick);
  setAppRouter(null);
});

describe("canvas links in assistant messages", () => {
  it("opens a Markdown canvas link in this tab through the router", () => {
    const navigate = registerRouter();
    renderAssistant(`Created [Autumn canvas](${CANVAS_PATH}).`);
    const link = screen.getByRole("link", { name: "Autumn canvas" });
    expect(link).toHaveAttribute("href", CANVAS_PATH);
    expect(link).not.toHaveAttribute("target");

    fireEvent.click(link);

    expect(browserDefault).toEqual([false]);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({
      to: "/projects/$project/freezone",
      params: { project: PROJECT },
      search: { canvas: CANVAS },
    }));
  });

  it("turns a bare canvas path into the same link", () => {
    const navigate = registerRouter();
    renderAssistant(`- Canvas: ${CANVAS_PATH}.`);
    const link = screen.getByRole("link", { name: CANVAS_PATH });
    expect(link).toHaveAttribute("href", CANVAS_PATH);
    expect(link).not.toHaveAttribute("target");

    fireEvent.click(link);

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({
      params: { project: PROJECT },
      search: { canvas: CANVAS },
    }));
  });

  it("leaves a canvas path written as inline code alone", () => {
    registerRouter();
    renderAssistant(`Path \`${CANVAS_PATH}\``);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(CANVAS_PATH).tagName).toBe("CODE");
  });

  it("does not nest a canvas path inside another link", () => {
    registerRouter();
    renderAssistant(`[see ${CANVAS_PATH}](https://example.com/docs)`);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "https://example.com/docs");
  });

  it("leaves modifier clicks to the browser", () => {
    const navigate = registerRouter();
    renderAssistant(`[Autumn canvas](${CANVAS_PATH})`);
    const link = screen.getByRole("link", { name: "Autumn canvas" });

    for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }]) {
      fireEvent.click(link, init);
    }

    expect(browserDefault).toEqual([true, true, true, true]);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("falls back to a same-tab link when no router is registered", () => {
    renderAssistant(`[Autumn canvas](${CANVAS_PATH})`);
    const link = screen.getByRole("link", { name: "Autumn canvas" });
    expect(link).toHaveAttribute("href", CANVAS_PATH);
    expect(link).not.toHaveAttribute("target");

    fireEvent.click(link);

    expect(browserDefault).toEqual([true]);
  });

  it.each([
    `https://example.com${CANVAS_PATH}`,
    `//example.com${CANVAS_PATH}`,
    `/projects/${PROJECT}/assistant`,
    `${CANVAS_PATH}&compose=node-1`,
    `${CANVAS_PATH}#node-1`,
    `/projects/${PROJECT}/freezone?canvas=..%2Fother`,
    `/projects/${PROJECT}/extra/freezone?canvas=${CANVAS}`,
    `/projects/${PROJECT}/freezone?canvas=`,
  ])("keeps every other link opening in a new tab: %s", (href) => {
    const navigate = registerRouter();
    renderAssistant(`[Other](${href})`);
    const link = screen.getByRole("link", { name: "Other" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");

    fireEvent.click(link);

    expect(browserDefault).toEqual([true]);
    expect(navigate).not.toHaveBeenCalled();
  });
});
