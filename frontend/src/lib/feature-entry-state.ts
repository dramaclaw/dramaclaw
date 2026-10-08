// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useSyncExternalStore } from "react";

const CHANGE_EVENT = "dramaclaw:feature-entry-seen";
const sessionSeen = new Set<string>();

export function featureEntrySeenKey(feature: string, username: string | null): string {
  return `dramaclaw:feature-entry-seen:${JSON.stringify([feature, username])}`;
}

/** Keep launch reminders until the entry is activated, scoped to the account. */
export function useFeatureEntrySeen(feature: string, username: string | null) {
  const key = featureEntrySeenKey(feature, username);
  const subscribe = useCallback((onChange: () => void) => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === key || event.key === null) onChange();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(CHANGE_EVENT, onChange);
    };
  }, [key]);
  const getSnapshot = useCallback(() => {
    if (sessionSeen.has(key)) return true;
    try {
      return window.localStorage.getItem(key) === "seen";
    } catch {
      return false;
    }
  }, [key]);
  const seen = useSyncExternalStore(subscribe, getSnapshot, () => false);
  const markSeen = useCallback(() => {
    try {
      window.localStorage.setItem(key, "seen");
    } catch {
      // Storage may be unavailable; still dismiss the reminder for this session.
      sessionSeen.add(key);
    }
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, [key]);

  return { seen, markSeen };
}
