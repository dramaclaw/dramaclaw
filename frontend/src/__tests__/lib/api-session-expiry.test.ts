// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logout: vi.fn<() => Promise<void>>(),
  resetUserSessionState: vi.fn(),
}));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: {
    getState: () => ({ logout: mocks.logout }),
  },
}));
vi.mock("@/lib/nav-lock", () => ({
  tryAcquireNavLock: () => true,
}));
vi.mock("@/lib/reset-region-state", () => ({
  resetRegionState: vi.fn(),
  resetUserSessionState: mocks.resetUserSessionState,
}));

import { handleSessionExpired, setApiQueryClient } from "@/lib/api";
import { SESSION_EXPIRED_EVENT } from "@/lib/session-expiry";

afterEach(() => {
  mocks.logout.mockReset();
  mocks.resetUserSessionState.mockReset();
});

describe("handleSessionExpired", () => {
  it("coalesces concurrent 401 teardown into one logout and one reset", async () => {
    let resolveLogout!: () => void;
    mocks.logout.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveLogout = resolve;
      }),
    );
    const queryClient = {} as Parameters<typeof setApiQueryClient>[0];
    setApiQueryClient(queryClient);
    const sessionExpired = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, sessionExpired);

    const first = handleSessionExpired();
    const second = handleSessionExpired();

    expect(second).toBe(first);
    expect(sessionExpired).toHaveBeenCalledOnce();
    expect(mocks.logout).toHaveBeenCalledOnce();
    expect(mocks.resetUserSessionState).not.toHaveBeenCalled();

    // Keep jsdom on the same target URL so assigning location.href does not
    // emit its unsupported cross-document navigation warning.
    window.history.replaceState({}, "", "/login");
    resolveLogout();
    await first;

    expect(mocks.resetUserSessionState).toHaveBeenCalledOnce();
    expect(mocks.resetUserSessionState).toHaveBeenCalledWith({ queryClient });
    window.removeEventListener(SESSION_EXPIRED_EVENT, sessionExpired);
    window.history.replaceState({}, "", "/");
  });
});
