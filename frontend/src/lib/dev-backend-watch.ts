// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { RuntimeConfigResponse } from "@/lib/runtime-config";

const WATCH_INTERVAL_MS = 4_000;

type BackendIdentity = {
  edition: "ce" | "ee";
  instanceId?: string;
};

function hasChanged(previous: BackendIdentity, next: BackendIdentity): boolean {
  if (!previous.instanceId || !next.instanceId) {
    return previous.edition !== next.edition;
  }
  return previous.edition !== next.edition || previous.instanceId !== next.instanceId;
}

function isPreauthPath(pathname: string): boolean {
  return pathname === "/login" || pathname.startsWith("/watch/");
}

export function shouldWatchDevBackend(apiUrl: string | undefined): boolean {
  if (!apiUrl) return true;
  try {
    const parsed = new URL(apiUrl, window.location.origin);
    return (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1"
    );
  } catch {
    return false;
  }
}

async function fetchBackendIdentity(): Promise<BackendIdentity | null> {
  try {
    const response = await fetch("/api/v1/config", {
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) return null;
    const parsed = RuntimeConfigResponse.parse(await response.json());
    return {
      edition: parsed.data.edition,
      instanceId: parsed.data.instance_id,
    };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn("[dev-backend-watch] poll failed:", error);
    return null;
  }
}

export function initDevBackendWatch(): () => void {
  if (!import.meta.env.DEV) return () => {};
  if (!shouldWatchDevBackend(import.meta.env.VITE_API_URL)) return () => {};

  let current: BackendIdentity | null = null;
  let inFlight = false;

  const interval = window.setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void fetchBackendIdentity().then((next) => {
      inFlight = false;
      if (!next) return;
      if (!current) {
        current = next;
        return;
      }
      if (hasChanged(current, next)) {
        current = next;
        if (isPreauthPath(window.location.pathname)) {
          return;
        }
        window.clearInterval(interval);
        window.location.assign("/");
        return;
      }
      current = next;
    });
  }, WATCH_INTERVAL_MS);

  return () => {
    window.clearInterval(interval);
  };
}
