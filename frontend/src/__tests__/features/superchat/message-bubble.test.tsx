// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("dramaclaw-spec-render", () => ({
  SpecRenderer: () => null,
  SpecRendererProvider: ({ children }: { children: ReactNode }) => children,
  VideoDetailModal: () => null,
}));

import { MessageBubble } from "@/features/superchat/superchat-panel";
import type { ChatMessage } from "@/features/superchat/types";

const baseMessage: ChatMessage = {
  id: "message-1",
  role: "assistant",
  text: "A normal assistant response.",
  timestamp: 1,
};

const sharedProps = {
  onOpenDetail: vi.fn(),
  onOpenMedia: vi.fn(),
  pinned: false,
  onDelete: vi.fn(),
  onTogglePin: vi.fn(),
};

describe("MessageBubble presentation", () => {
  it("uses a low-contrast surface for the user bubble", () => {
    const { container } = render(
      <MessageBubble message={{ ...baseMessage, role: "user" }} {...sharedProps} />,
    );

    const bubble = container.querySelector("article > div > div");
    expect(bubble).toHaveClass("bg-white/[0.07]");
    expect(bubble).not.toHaveClass("bg-white/[0.12]");
  });

  it("renders a completed assistant response without a bubble surface", () => {
    const { container } = render(<MessageBubble message={baseMessage} {...sharedProps} />);
    const article = container.querySelector("article");

    expect(article).toHaveClass("max-w-full", "text-foreground");
    expect(article).not.toHaveClass("border", "rounded-[14px]", "bg-transparent", "px-4");
    expect(screen.getByRole("group", { name: "aiAssistant.actions.label" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "aiAssistant.actions.copy" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "aiAssistant.actions.more" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "aiAssistant.actions.details" })).not.toBeInTheDocument();
  });

  it("hides completion actions while the assistant response is streaming", () => {
    render(<MessageBubble message={baseMessage} {...sharedProps} streaming />);

    expect(screen.queryByRole("group", { name: "aiAssistant.actions.label" })).not.toBeInTheDocument();
  });

  it("keeps semantic surfaces for errors and tool events", () => {
    const { container, rerender } = render(
      <MessageBubble
        message={{ ...baseMessage, text: "hermes returned no content" }}
        {...sharedProps}
      />,
    );

    expect(container.querySelector("article")).toHaveClass(
      "border-red-400/20",
      "bg-red-400/[0.06]",
    );

    rerender(
      <MessageBubble
        message={{ ...baseMessage, role: "tool", text: "Tool result" }}
        {...sharedProps}
      />,
    );
    expect(container.querySelector("article")).toHaveClass(
      "border-amber-500/20",
      "bg-amber-500/8",
    );
  });

  it("marks structured media cards for lightweight interaction feedback", () => {
    const mediaSpec = {
      type: "character_showcase",
      root: "root",
      elements: {
        root: { type: "Stack", children: ["portrait"], props: {} },
        portrait: {
          type: "Image",
          children: [],
          props: {
            src: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
            title: "沈月",
          },
        },
      },
    };
    const { container } = render(
      <MessageBubble
        message={{
          ...baseMessage,
          text: `<ui-spec>${JSON.stringify(mediaSpec)}</ui-spec>`,
        }}
        {...sharedProps}
      />,
    );

    expect(container.querySelector(".st-unified-media-card")).toHaveClass("st-ai-media-card");
  });
});
