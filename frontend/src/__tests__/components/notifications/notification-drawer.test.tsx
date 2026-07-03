// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
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
        "notifications.title": "Notification Center",
        "notifications.close": "Close notifications",
        "notifications.empty": "No notifications",
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

describe("NotificationDrawer release feed behavior", () => {
  beforeEach(() => {
    localStorage.clear();
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
});
