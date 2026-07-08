// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { quotaSafeStateStorage } from "@/lib/localStorageQuota";
import { regionAbortController } from "@/lib/region-abort";
import type { OkResponse } from "@/types/api";

export interface CurrentUser {
  username: string;
  role: string;
  credit_balance: number;
  credential_kind?: string;
  avatar_url?: string | null;
}

interface GetCurrentUserOptions {
  clearOnNetworkFailure?: boolean;
}

interface CurrentUserFetchResult {
  user: CurrentUser | null;
  authFailure: boolean;
  networkFailure: boolean;
}

export interface AuthState {
  username: string | null;
  role: string | null;
  avatarUrl: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  validateSession: () => Promise<boolean>;
  getCurrentUser: (options?: GetCurrentUserOptions) => Promise<CurrentUser | null>;
  setAvatarUrl: (url: string | null) => void;
  refreshAvatar: () => Promise<void>;
  reset: () => void;
}

const SESSION_VALIDATION_TTL_MS = 15_000;

let currentUserInFlight: Promise<CurrentUserFetchResult> | null = null;
let cachedCurrentUser: CurrentUser | null = null;
let lastSuccessfulValidationAt = 0;

// Schema guard for persisted auth blob. Anything that doesn't match exactly
// gets discarded so a tampered localStorage value can't inject objects into
// the store. Previously the persisted payload also carried `apiKey`; the SPA
// is now cookie-backed so we deliberately ignore that field even if legacy
// clients have one sitting in localStorage — letting the cookie drive auth
// avoids two sources of truth disagreeing.
function sanitizePersisted(raw: unknown): Pick<AuthState, "username" | "role"> {
  const empty = { username: null, role: null };
  if (!raw || typeof raw !== "object") return empty;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  return {
    username: str(r.username),
    role: str(r.role),
  };
}

function clearCurrentUserCache(): void {
  currentUserInFlight = null;
  cachedCurrentUser = null;
  lastSuccessfulValidationAt = 0;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      username: null,
      role: null,
      avatarUrl: null,
      login: async (username: string, password: string) => {
        // `credentials: "include"` lets the browser store the HttpOnly
        // Set-Cookie the BE returns on success. Without it, the cookie
        // would be silently dropped and every subsequent /api/ call would
        // 401 despite login appearing to succeed.
        const res = await fetch("/api/v1/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ username, password }),
          signal: regionAbortController().signal,
        });
        if (!res.ok) {
          const err = await res
            .json()
            .catch(() => ({ error: "Login failed" }));
          throw new Error(err.error || err.detail || "Login failed");
        }
        const data = await res.json();
        // The response body carries identity only; the HttpOnly cookie is the credential.
        cachedCurrentUser = data.data;
        lastSuccessfulValidationAt = Date.now();
        set({
          username: data.data.username,
          role: data.data.role,
        });
        // Avatar is an EE-only feature served by its own endpoint, not /auth/me.
        void useAuthStore.getState().refreshAvatar();
      },
      logout: async () => {
        // Ask the BE to clear the HttpOnly cookie. If the network call fails
        // we still tear down the local username/role so the UI redirects to
        // /login — a phantom cookie can be cleaned up on the next login.
        try {
          await fetch("/api/v1/auth/logout", {
            method: "POST",
            credentials: "include",
            signal: regionAbortController().signal,
          });
        } catch {
          /* ignore — local logout proceeds regardless */
        }
        clearCurrentUserCache();
        set({ username: null, role: null, avatarUrl: null });
      },
      getCurrentUser: async (options: GetCurrentUserOptions = {}) => {
        // The cookie isn't visible to JS (HttpOnly), so we can't pre-check
        // it. Ask the BE directly: /auth/me is cheap and its 401 path
        // tells us the cookie is missing or stale.
        if (
          cachedCurrentUser &&
          Date.now() - lastSuccessfulValidationAt < SESSION_VALIDATION_TTL_MS
        ) {
          return cachedCurrentUser;
        }
        const request =
          currentUserInFlight ??
          (currentUserInFlight = (async (): Promise<CurrentUserFetchResult> => {
            try {
              const res = await fetch("/api/v1/auth/me", {
                credentials: "include",
                signal: regionAbortController().signal,
              });
              if (!res.ok) {
                // A 401/403 is the ONLY response that means the session cookie
                // is missing or stale — the sole case that should tear auth
                // down. Any other non-2xx (500/502/503 while the backend pod is
                // mid-rollout, gateway errors) carries no auth signal: leave the
                // session intact so a routine backend restart doesn't log every
                // user out. We surface it as neither authFailure nor
                // networkFailure so no caller — not even the strict route-guard
                // default — clears local auth; the next poll recovers on 200.
                if (res.status === 401 || res.status === 403) {
                  return { user: null, authFailure: true, networkFailure: false };
                }
                return { user: null, authFailure: false, networkFailure: false };
              }
              const body = (await res.json()) as OkResponse<CurrentUser>;
              cachedCurrentUser = body.data;
              lastSuccessfulValidationAt = Date.now();
              set({
                username: body.data.username,
                role: body.data.role,
              });
              // NB: avatar is refreshed independently (login() + the App-root
              // mount effect), NOT here — getCurrentUser has a 15s cache, so a
              // cache hit would skip the refresh and leave the avatar stale.
              return { user: body.data, authFailure: false, networkFailure: false };
            } catch {
              return { user: null, authFailure: false, networkFailure: true };
            }
          })());
        try {
          const result = await request;
          const shouldClearAuth =
            result.authFailure ||
            (result.networkFailure && options.clearOnNetworkFailure !== false);
          if (shouldClearAuth) {
            // Route guards use the strict default so a failed session check does
            // not bounce between "/" and "/login". Lightweight consumers such as
            // the credit badge can opt out for transient network failures.
            clearCurrentUserCache();
            set({ username: null, role: null, avatarUrl: null });
          }
          return result.user;
        } finally {
          if (currentUserInFlight === request) {
            currentUserInFlight = null;
          }
        }
      },
      validateSession: async (): Promise<boolean> =>
        Boolean(await useAuthStore.getState().getCurrentUser()),
      setAvatarUrl: (url: string | null) => {
        if (cachedCurrentUser) cachedCurrentUser = { ...cachedCurrentUser, avatar_url: url };
        set({ avatarUrl: url });
      },
      refreshAvatar: async () => {
        // EE-only avatar endpoint; absent on CE backends, so failures are silent.
        try {
          const res = await fetch("/api/v1/account/avatar", {
            credentials: "include",
            signal: regionAbortController().signal,
          });
          if (!res.ok) return;
          const body = await res.json();
          useAuthStore.getState().setAvatarUrl(body?.data?.avatar_url ?? null);
        } catch {
          /* ignore — avatar is non-critical */
        }
      },
      reset: () => {
        clearCurrentUserCache();
        set({ username: null, role: null, avatarUrl: null });
      },
    }),
    {
      name: "supertale-auth",
      storage: createJSONStorage(() => quotaSafeStateStorage),
      partialize: (state) => ({
        username: state.username,
        role: state.role,
      }),
      merge: (persisted, current) => ({
        ...current,
        ...sanitizePersisted(persisted),
      }),
    },
  ),
);
