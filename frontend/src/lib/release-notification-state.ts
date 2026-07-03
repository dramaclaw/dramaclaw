// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ReleaseFeed } from "@/lib/queries/release-notifications";

export const RELEASE_NOTIFICATIONS_MUTED_KEY = "dramaclaw:release-notifications:muted";

export function releaseSeenKey(tag: string | null | undefined): string | null {
  return tag ? `dramaclaw:release-seen:${tag}` : null;
}

export function releaseUpgradeKey(tag: string | null | undefined): string | null {
  return tag ? `dramaclaw:release-upgrade:${tag}` : null;
}

function storage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

export function releaseNotificationsMuted(): boolean {
  return storage()?.getItem(RELEASE_NOTIFICATIONS_MUTED_KEY) === "true";
}

export function markCurrentReleaseSeen(tag: string | null | undefined): void {
  const key = releaseSeenKey(tag);
  if (!key) return;
  storage()?.setItem(key, "seen");
}

export function markUpgradeSeen(tag: string | null | undefined): void {
  const key = releaseUpgradeKey(tag);
  if (!key) return;
  storage()?.setItem(key, "seen");
}

export function markUpgradeSkipped(tag: string | null | undefined): void {
  const key = releaseUpgradeKey(tag);
  if (!key) return;
  storage()?.setItem(key, "skipped");
}

export function shouldAutoShowCurrentRelease(feed: ReleaseFeed | null | undefined): boolean {
  if (!feed?.current_tag || feed.current_items.length === 0) return false;
  if (releaseNotificationsMuted()) return false;
  const key = releaseSeenKey(feed.current_tag);
  return key ? storage()?.getItem(key) !== "seen" : false;
}

export function shouldShowUpgradeNudge(feed: ReleaseFeed | null | undefined): boolean {
  if (!feed?.update_available || !feed.latest_tag) return false;
  if (feed.attention !== "medium" && feed.attention !== "high") return false;
  if (releaseNotificationsMuted()) return false;
  const key = releaseUpgradeKey(feed.latest_tag);
  if (!key) return false;
  const status = storage()?.getItem(key);
  return status !== "seen" && status !== "skipped";
}
