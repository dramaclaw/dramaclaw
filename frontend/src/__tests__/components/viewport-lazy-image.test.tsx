// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ViewportLazyImage } from "@/components/viewport-lazy-image";

describe("ViewportLazyImage", () => {
  let callback!: IntersectionObserverCallback;
  const observe = vi.fn();
  const disconnect = vi.fn();

  beforeEach(() => {
    observe.mockClear();
    disconnect.mockClear();
    class MockIntersectionObserver {
      root = null;
      rootMargin = "160px 0px";
      thresholds = [0];
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
      takeRecords = vi.fn(() => []);

      constructor(nextCallback: IntersectionObserverCallback) {
        callback = nextCallback;
      }
    }
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not expose src until the image intersects the viewport", () => {
    render(<ViewportLazyImage src="/portrait.png" alt="郑家悦" />);

    const image = screen.getByRole("img", { name: "郑家悦" });
    expect(image).not.toHaveAttribute("src");
    expect(observe).toHaveBeenCalledWith(image);

    act(() => {
      callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });

    expect(image).toHaveAttribute("src", "/portrait.png");
    expect(disconnect).toHaveBeenCalled();
  });

  it("does not leak a replacement src before it intersects", () => {
    const view = render(
      <ViewportLazyImage src="/portrait-v1.png" alt="郑家悦" />,
    );
    act(() => {
      callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    expect(screen.getByRole("img")).toHaveAttribute(
      "src",
      "/portrait-v1.png",
    );

    view.rerender(
      <ViewportLazyImage src="/portrait-v2.png" alt="郑家悦" />,
    );

    expect(screen.getByRole("img")).not.toHaveAttribute("src");
  });

  it("falls back to native lazy loading when observers are unavailable", () => {
    vi.stubGlobal("IntersectionObserver", undefined);

    render(<ViewportLazyImage src="/portrait.png" alt="郑家悦" />);

    expect(screen.getByRole("img")).toHaveAttribute("src", "/portrait.png");
    expect(screen.getByRole("img")).toHaveAttribute("loading", "lazy");
  });
});
