// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import ky from "ky";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "app.versionUpdate.title": "New features are live",
        "app.versionUpdate.confirm": "Got it",
        "app.versionUpdate.empty": "No release notes",
      })[key] ?? key,
    i18n: {
      language: "en",
      resolvedLanguage: "en",
    },
  }),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

import { VersionUpdateDialog } from "@/features/version-update/VersionUpdateDialog";
import { openVersionUpdateDialog } from "@/features/version-update/version-update-events";
import { RELEASE_NOTIFICATIONS_MUTED_KEY } from "@/lib/release-notification-state";

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function feed(items = [{ title: "Current highlight", body: "Current body" }]) {
  return {
    ok: true,
    data: {
      source: "local_file",
      current_version: "1.0.2",
      current_tag: "v1.0.2",
      current_items: items.map((item, index) => ({
        id: `release:v1.0.2:${index}`,
        kind: "release",
        icon: "sparkles",
        title: item.title,
        body: item.body,
      })),
      update_available: false,
      latest_version: null,
      latest_tag: null,
      release_url: null,
      update_items: [],
      attention: "low",
      latest_published_at: null,
    },
  };
}

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VersionUpdateDialog />
    </QueryClientProvider>,
  );
}

describe("VersionUpdateDialog release feed behavior", () => {
  beforeEach(() => {
    localStorage.clear();
    server.use(
      http.get("http://localhost:3000/api/v1/release-notifications", () =>
        HttpResponse.json(feed()),
      ),
    );
  });

  it("auto-opens once for an unseen current release and marks it seen", async () => {
    const first = renderDialog();

    expect(await screen.findByText(/Current highlight/)).toBeInTheDocument();
    expect(localStorage.getItem("dramaclaw:release-seen:v1.0.2")).toBe("seen");

    first.unmount();
    renderDialog();

    await waitFor(() => {
      expect(screen.queryByText(/Current highlight/)).not.toBeInTheDocument();
    });
  });

  it("manual entry ignores seen and muted state", async () => {
    localStorage.setItem("dramaclaw:release-seen:v1.0.2", "seen");
    localStorage.setItem(RELEASE_NOTIFICATIONS_MUTED_KEY, "true");

    renderDialog();
    openVersionUpdateDialog();

    expect(await screen.findByText(/Current highlight/)).toBeInTheDocument();
  });
});
