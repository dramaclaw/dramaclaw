// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReleaseFeed } from "@/lib/queries/release-notifications";

const feedState = vi.hoisted<{ feed: ReleaseFeed }>(() => ({
  feed: {
    source: "local_file+github",
    current_version: "1.0.2",
    current_tag: "v1.0.2",
    current_items: [
      {
        id: "release:v1.0.2:abc12345",
        kind: "release",
        icon: "sparkles",
        title: "Current highlight",
        body: "Current body",
      },
    ],
    update_available: true,
    latest_version: "1.0.5",
    latest_tag: "v1.0.5",
    release_url: "https://example.test/v1.0.5",
    update_items: [],
    attention: "high",
    latest_published_at: "2026-07-01T08:00:00Z",
  },
}));

vi.mock("@/lib/queries/release-notifications", () => ({
  useReleaseNotifications: () => ({ data: { ok: true, data: feedState.feed }, isLoading: false }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string>) =>
      ({
        "notifications.title": "Announcement Center",
        "notifications.close": "Close announcement center",
        "notifications.empty": "No announcements",
        "notifications.upgrade.title": `New version ${vars?.version} available`,
        "notifications.upgrade.body": "Open the release page to update.",
        "notifications.upgrade.open": "Update",
        "notifications.upgrade.skip": "Skip this version",
      })[key] ?? key,
    i18n: { language: "en", resolvedLanguage: "en" },
  }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

import { NotificationDrawer } from "@/components/notifications/notification-drawer";

const drawerSource = readFileSync("src/components/notifications/notification-drawer.tsx", "utf8");
const cardStyles = readFileSync(
  "src/components/notifications/announcement-card.module.css",
  "utf8",
);

describe("NotificationDrawer release feed behavior", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("matches the login announcement card surface without a title icon", () => {
    expect(drawerSource).toContain("SharedAnnouncementCard");
    expect(cardStyles).toContain("grid-template-columns: 34px minmax(0, 1fr)");
    expect(cardStyles).toContain("border-radius: 14px");
    expect(cardStyles).toContain("border: 1px solid rgba(255, 255, 255, 0.075)");
    expect(drawerSource).not.toMatch(/<header[\s\S]*?<Bell[\s\S]*?<h2/);
    expect(drawerSource).toContain("overflow-y-auto px-5 pb-3 pt-1");
    expect(drawerSource).not.toContain("pl-2 pr-4");
    expect(cardStyles).toContain("font-size: 10.5px");
  });

  it("renders upgrade and current release rows and marks the upgrade seen on open", async () => {
    const onUpgradeStateChange = vi.fn();

    render(
      <NotificationDrawer
        open={true}
        onOpenChange={vi.fn()}
        onUpgradeStateChange={onUpgradeStateChange}
      />,
    );

    expect(await screen.findByText("New version v1.0.5 available")).toBeInTheDocument();
    expect(screen.getByText("Current highlight")).toBeInTheDocument();
    expect(localStorage.getItem("dramaclaw:release-upgrade:v1.0.5")).toBe("seen");
    expect(onUpgradeStateChange).toHaveBeenCalled();
  });

  it("can skip an upgrade version without hiding release history", async () => {
    render(
      <NotificationDrawer open={true} onOpenChange={vi.fn()} onUpgradeStateChange={vi.fn()} />,
    );

    fireEvent.click(await screen.findByText("Skip this version"));

    await waitFor(() => {
      expect(localStorage.getItem("dramaclaw:release-upgrade:v1.0.5")).toBe("skipped");
    });
    expect(screen.getByText("Current highlight")).toBeInTheDocument();
  });

  it("shows the same remote announcements as the login announcement center", async () => {
    render(
      <NotificationDrawer
        open={true}
        onOpenChange={vi.fn()}
        announcements={[
          {
            id: "channel-release-2026-08",
            publishedAt: "2026-08-24T10:00:00+08:00",
            i18n: {
              en: {
                title: "Channel release update",
                body: "The <hl>channel release</hl> arrives at <time>18:00</time>.",
              },
            },
          },
        ]}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Announcement Center" })).toBeInTheDocument();
    expect(screen.getByText("Channel release update")).toBeInTheDocument();
    expect(
      screen.getByText(
        (_content, element) =>
          element?.tagName === "P" &&
          element.textContent === "The channel release arrives at 18:00.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("channel release").className).toMatch(/highlight/);
    expect(screen.getByText("18:00").className).toMatch(/highlightTime/);
  });
});
