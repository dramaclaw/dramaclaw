// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// reducedMotion 下 autoPlay 关闭，onEnded/onTimeUpdate 都不触发，onError 是轮换的
// 唯一驱动，也是这条回归想守住的场景。
vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => true,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "zh", resolvedLanguage: "zh" },
  }),
}));

vi.mock("@/components/login/login-card", () => ({
  LoginCard: () => <div data-testid="login-card" />,
}));

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  motion: new Proxy({} as Record<string, unknown>, {
    get:
      () =>
      ({ children, ...rest }: Record<string, unknown> & { children?: React.ReactNode }) => {
        const {
          initial: _initial,
          animate: _animate,
          exit: _exit,
          transition: _transition,
          ...domProps
        } = rest;
        return <div {...domProps}>{children}</div>;
      },
  }),
}));

const { LoginModal } = await import("@/components/login/login-modal");
const { loginModalShowcaseVideos } = await import("@/components/login/cinematic/media");

function videos(): HTMLVideoElement[] {
  return Array.from(document.querySelectorAll<HTMLVideoElement>("[data-showcase-id]"));
}

describe("LoginModal showcase 兜底", () => {
  it("所有片源都失败后停止轮换，而不是无限重建 <video>", () => {
    render(<LoginModal open onClose={() => undefined} />);

    const seen = new Set<string>();
    // 每失败一次最多推进一格；给足 2 倍片源数的余量，能停就一定在这之内停。
    for (let step = 0; step < loginModalShowcaseVideos.length * 2; step += 1) {
      const current = videos();
      if (current.length === 0) break;
      current.forEach((video) => {
        seen.add(video.dataset.showcaseId ?? "");
        fireEvent.error(video);
      });
    }

    expect(seen.size).toBe(loginModalShowcaseVideos.length);
    expect(videos()).toHaveLength(0);
    // 兜底后文案仍在，面板不是空白。
    expect(screen.getByText("auth.modal.showcaseTitle")).toBeTruthy();
  });
});
