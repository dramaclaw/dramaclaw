// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 两条路径的失败时序完全不同，必须都覆盖：
//   reducedMotion=true  —— autoPlay 关闭，onError 是轮换的唯一驱动，且不上过渡锁
//   reducedMotion=false —— 上 720ms 过渡锁，incoming 片源会在锁释放前就报错
const motion = vi.hoisted(() => ({ reduced: true }));
vi.mock("@/hooks/use-reduced-motion", () => ({
  useReducedMotion: () => motion.reduced,
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

// 与 login-modal.tsx 的 SHOWCASE_CROSSFADE_DURATION_MS 对齐（该常量未导出）。
const CROSSFADE_MS = 720;

function videos(): HTMLVideoElement[] {
  return Array.from(document.querySelectorAll<HTMLVideoElement>("[data-showcase-id]"));
}

function incoming(): HTMLVideoElement[] {
  return videos().filter((video) => video.dataset.showcasePhase === "incoming");
}

describe("LoginModal showcase 兜底", () => {
  afterEach(() => {
    motion.reduced = true;
  });

  it("减少动效下片源全挂时停止轮换，而不是无限重建 <video>", () => {
    motion.reduced = true;
    render(<LoginModal open onClose={() => undefined} />);

    const seen = new Set<string>();
    // 每失败一次最多推进一格；给足 2 倍片源数的余量，能停就一定在这之内停。
    for (let step = 0; step < loginModalShowcaseVideos.length * 2; step += 1) {
      if (videos().length === 0) break;
      incoming().forEach((video) => {
        seen.add(video.dataset.showcaseId ?? "");
        fireEvent.error(video);
      });
    }

    expect(seen.size).toBe(loginModalShowcaseVideos.length);
    expect(videos()).toHaveLength(0);
    expect(screen.getByText("auth.modal.showcaseTitle")).toBeTruthy();
  });

  describe("普通动效", () => {
    beforeEach(() => {
      motion.reduced = false;
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("incoming 片源在过渡锁释放前报错时，过渡结束后仍会继续推进直到静态兜底", () => {
      render(<LoginModal open onClose={() => undefined} />);

      const seen = new Set<string>();
      for (let cycle = 0; cycle < loginModalShowcaseVideos.length * 3; cycle += 1) {
        if (videos().length === 0) break;

        // 关键时序：切换到下一片源后，新挂载的 incoming 在**同一 tick**内就报错，
        // 此时 720ms 过渡锁仍握着。推进计时器之前把这一串报完，才是 CDN 整体不可用
        // 的真实形态；先推进计时器就等于锁已释放，复现不出问题。
        for (let guard = 0; guard < loginModalShowcaseVideos.length; guard += 1) {
          const fresh = incoming().filter(
            (video) => !seen.has(video.dataset.showcaseId ?? ""),
          );
          if (fresh.length === 0) break;
          fresh.forEach((video) => {
            seen.add(video.dataset.showcaseId ?? "");
            fireEvent.error(video);
          });
        }

        // 过渡结束：补上被锁挡下的那次推进。
        act(() => {
          vi.advanceTimersByTime(CROSSFADE_MS + 1);
        });
      }

      expect(seen.size).toBe(loginModalShowcaseVideos.length);
      expect(videos()).toHaveLength(0);
      expect(screen.getByText("auth.modal.showcaseTitle")).toBeTruthy();
    });
  });
});
