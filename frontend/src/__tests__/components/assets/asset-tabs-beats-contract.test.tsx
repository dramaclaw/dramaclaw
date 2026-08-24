// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * The assets workbench must never read the beats table.
 *
 * Usage counts used to come from walking every episode's beats: opening a tab
 * fired one `/episodes/{n}/beats` per episode, and each of those is the
 * expensive route — it hydrates a store, probes the filesystem for four asset
 * URLs per beat, and forks ffprobe for every audio clip. The counts now arrive
 * from the single project-wide `/assets/references` aggregate instead.
 *
 * This is a network-level assertion on purpose. The fan-out was never visible
 * in a rendered-output test; it lived in which hooks the panels happened to
 * call, which is exactly the kind of thing a UI refactor reintroduces silently.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { http, HttpResponse } from "msw";
import ky from "ky";
import type { ReactNode } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { server } from "@/__mocks__/msw/server";

vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
  uploadApi: ky.create({ baseUrl: "http://localhost:3000/" }),
}));

// Routing is stubbed to the bare minimum: this file asserts on what the network
// sees, not on navigation.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode }) => (
    <a {...(rest as object)}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
  useParams: () => ({}),
}));

vi.mock("@/hooks/use-task-controller", () => ({
  useTaskController: () => ({
    started: false,
    stream: {
      status: "idle",
      progress: 0,
      currentTask: "",
      result: null,
      error: null,
    },
    logs: [],
    start: vi.fn(),
    stop: vi.fn(),
    stopping: false,
  }),
}));

import { PropsPanel } from "@/components/assets/props-panel";
import { ScenesPanel } from "@/components/assets/scenes-panel";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en", resources: {} });
});

/**
 * Record the API path of every request the render makes.
 *
 * The catch-all is registered first so the per-test handlers below still win,
 * and it answers rather than falling through: an unhandled request would escape
 * to the real network and turn a missing handler into a confusing timeout
 * instead of a recorded path.
 */
function recordRequests(): string[] {
  const seen: string[] = [];
  server.use(
    http.get("http://localhost:3000/api/v1/*", ({ request }) => {
      seen.push(new URL(request.url).pathname);
      return HttpResponse.json({ ok: true, data: [] });
    }),
  );
  return seen;
}

function renderWithProviders(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </I18nextProvider>,
  );
}

describe("asset tabs do not read the beats table", () => {
  it("opens the scenes tab without requesting any episode's beats", async () => {
    const seen = recordRequests();
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/scenes", () =>
        HttpResponse.json({
          ok: true,
          data: [{ name: "Hall", description: "", image_url: "" }],
        }),
      ),
    );

    renderWithProviders(<ScenesPanel project="demo" />);

    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen.filter((path) => path.includes("/beats"))).toEqual([]);
  });

  it("opens the props tab without requesting any episode's beats", async () => {
    const seen = recordRequests();
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/props", () =>
        HttpResponse.json({
          ok: true,
          data: [{ name: "Sword", description: "", image_url: "" }],
        }),
      ),
    );

    renderWithProviders(<PropsPanel project="demo" />);

    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen.filter((path) => path.includes("/beats"))).toEqual([]);
  });

  it("asks the aggregate reference endpoint at most once per panel", async () => {
    const seen = recordRequests();
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/scenes", () =>
        HttpResponse.json({
          ok: true,
          data: [
            { name: "Hall", description: "", image_url: "" },
            { name: "Alley", description: "", image_url: "" },
          ],
        }),
      ),
    );

    renderWithProviders(<ScenesPanel project="demo" />);

    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    // One project-wide call covers every card's usage badge; the old shape was
    // one call per asset, which is the same fan-out wearing a different URL.
    expect(
      seen.filter((path) => path.endsWith("/assets/references")).length,
    ).toBeLessThanOrEqual(1);
  });
});
