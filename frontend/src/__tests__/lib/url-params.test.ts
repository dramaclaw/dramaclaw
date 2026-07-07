// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnyRouter } from "@tanstack/react-router";

import { setAppRouter } from "@/lib/app-router";
import { writeUrl } from "@/lib/url-params";

describe("freezone url params", () => {
  it("does not rewrite non-freezone routes when stale freezone code writes canvas state", () => {
    window.history.pushState(null, "", "/projects/proj-a/episodes/3/script");

    writeUrl({ canvas: "canvas-2" });

    expect(window.location.pathname).toBe("/projects/proj-a/episodes/3/script");
    expect(window.location.search).toBe("");
  });

  it("writes canvas params while on the project freezone route", () => {
    window.history.pushState(null, "", "/projects/proj-a/freezone");

    writeUrl({ canvas: "canvas-2" });

    expect(window.location.pathname).toBe("/projects/proj-a/freezone");
    expect(window.location.search).toBe("?canvas=canvas-2");
  });

  it("can replace canvas params without notifying route listeners", () => {
    window.history.pushState(null, "", "/projects/proj-a/freezone");
    let popstateCount = 0;
    const listener = () => {
      popstateCount += 1;
    };
    window.addEventListener("popstate", listener);

    try {
      writeUrl({ canvas: "canvas-2" }, { replace: true, notify: false });

      expect(window.location.pathname).toBe("/projects/proj-a/freezone");
      expect(window.location.search).toBe("?canvas=canvas-2");
      expect(popstateCount).toBe(0);
    } finally {
      window.removeEventListener("popstate", listener);
    }
  });
});

describe("freezone url params — routes through tanstack when a router is registered", () => {
  afterEach(() => setAppRouter(null));

  function mockRouter(pathname: string, search: Record<string, unknown> = {}) {
    const navigate = vi.fn();
    setAppRouter({
      navigate,
      state: { location: { pathname, search } },
    } as unknown as AnyRouter);
    return navigate;
  }

  it("navigates through the router instead of mutating window.history", () => {
    window.history.pushState(null, "", "/projects/proj-a/freezone");
    const navigate = mockRouter("/projects/proj-a/freezone");
    let popstateCount = 0;
    const listener = () => {
      popstateCount += 1;
    };
    window.addEventListener("popstate", listener);

    try {
      writeUrl({ canvas: "canvas-9" }, { replace: true, notify: false });

      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "/projects/$project/freezone",
          params: { project: "proj-a" },
          search: { canvas: "canvas-9" },
          replace: true,
        }),
      );
      // The router owns the URL now: no raw history write, no synthetic popstate
      // that could race with tanstack's throttled history queue.
      expect(window.location.search).toBe("");
      expect(popstateCount).toBe(0);
    } finally {
      window.removeEventListener("popstate", listener);
    }
  });

  it("targets the ingest route when the project is cleared", () => {
    window.history.pushState(null, "", "/projects/proj-a/freezone");
    const navigate = mockRouter("/projects/proj-a/freezone", { canvas: "c1" });

    writeUrl({ project: null, canvas: null });

    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/projects/$project/ingest",
        params: { project: "proj-a" },
        search: {},
      }),
    );
  });

  it("still no-ops on non-freezone routes even with a router registered", () => {
    window.history.pushState(null, "", "/projects/proj-a/episodes/3/script");
    const navigate = mockRouter("/projects/proj-a/episodes/3/script");

    writeUrl({ canvas: "canvas-2" });

    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not yank back to freezone when the router already left (window.location lags)", () => {
    // Real leave transition: tanstack throttles history onto a microtask, so
    // the router's location is already /characters while window.location still
    // reads the old /freezone. A stray canvas-sync write here must NOT navigate
    // back to freezone — that was the regression that trapped users on 虾画.
    window.history.pushState(null, "", "/projects/proj-a/freezone");
    const navigate = mockRouter("/projects/proj-a/characters");

    writeUrl({ canvas: "canvas-2" }, { replace: true, notify: false });

    expect(navigate).not.toHaveBeenCalled();
  });
});
