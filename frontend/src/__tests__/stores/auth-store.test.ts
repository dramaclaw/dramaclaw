// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAuthStore } from "@/stores/auth-store";
import { regionAbortController, resetRegionAbortController } from "@/lib/region-abort";

beforeEach(() => {
  useAuthStore.getState().reset();
  localStorage.clear();
});

// `login()` 成功后会顺带 void refreshAvatar() 打一发 `/api/v1/account/avatar`
// (EE 头像端点;getCurrentUser 不再搭这趟便车,改由 App 顶层独立触发)。这些
// 去重/缓存断言只关心 `/auth/me` 被打了几次,所以按 URL 过滤,别把 avatar 那一发算进来。
function authMeCallCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes("/auth/me")).length;
}

// 非 /auth/me 的请求(如 /account/avatar)统一返回 ok:false,让 refreshAvatar 静默早退。
const avatarMiss = { ok: false, json: async () => ({}) };

describe("auth-store", () => {
  it("starts with null state", () => {
    const state = useAuthStore.getState();
    expect(state.username).toBeNull();
    expect(state.role).toBeNull();
  });

  it("login stores username/role on success (cookie handles credential)", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        data: { username: "admin", role: "admin" },
      }),
    });
    await useAuthStore.getState().login("admin", "admin123");
    const state = useAuthStore.getState();
    expect(state.username).toBe("admin");
    expect(state.role).toBe("admin");
  });

  it("login calls fetch with credentials: include so the Set-Cookie is honored", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        data: { username: "admin", role: "admin" },
      }),
    });
    global.fetch = fetchMock;
    await useAuthStore.getState().login("admin", "admin123");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe("include");
  });

  it("login throws on invalid credentials", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Invalid credentials" }),
    });
    await expect(
      useAuthStore.getState().login("bad", "bad"),
    ).rejects.toThrow("Invalid credentials");
  });

  it("logout hits /auth/logout and clears local state", async () => {
    useAuthStore.setState({ username: "admin", role: "admin" });
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    global.fetch = fetchMock;
    await useAuthStore.getState().logout();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/auth/logout",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    const state = useAuthStore.getState();
    expect(state.username).toBeNull();
    expect(state.role).toBeNull();
  });

  it("logout tolerates network failure and still clears local state", async () => {
    useAuthStore.setState({ username: "admin", role: "admin" });
    global.fetch = vi.fn().mockRejectedValueOnce(new Error("offline"));
    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().username).toBeNull();
  });

  it("validateSession returns true on 200 via cookie", async () => {
    useAuthStore.setState({ username: "admin", role: "admin" });
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, data: { username: "admin", role: "admin" } }),
    });
    const result = await useAuthStore.getState().validateSession();
    expect(result).toBe(true);
  });

  it("dedupes concurrent validateSession calls", async () => {
    useAuthStore.setState({ username: "admin", role: "admin" });
    let resolveFetch: (value: { ok: true; json: () => Promise<unknown> }) => void = () => {};
    const fetchPromise = new Promise<{ ok: true; json: () => Promise<unknown> }>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      String(url).includes("/auth/me") ? fetchPromise : Promise.resolve(avatarMiss),
    );
    global.fetch = fetchMock;

    const first = useAuthStore.getState().validateSession();
    const second = useAuthStore.getState().validateSession();
    resolveFetch({
      ok: true,
      json: async () => ({ ok: true, data: { username: "admin", role: "admin" } }),
    });

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(authMeCallCount(fetchMock)).toBe(1);
  });

  it("returns false for all concurrent validateSession callers when the shared request fails", async () => {
    useAuthStore.setState({ username: "admin", role: "admin" });
    let rejectFetch: (reason: Error) => void = () => {};
    const fetchPromise = new Promise((_resolve, reject) => {
      rejectFetch = reject;
    });
    const fetchMock = vi.fn().mockReturnValue(fetchPromise);
    global.fetch = fetchMock;

    const first = useAuthStore.getState().validateSession();
    const second = useAuthStore.getState().validateSession();
    rejectFetch(new Error("offline"));

    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
    expect(useAuthStore.getState().username).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses a recent successful validateSession result", async () => {
    useAuthStore.setState({ username: "admin", role: "admin" });
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes("/auth/me")
          ? {
              ok: true,
              json: async () => ({
                ok: true,
                data: { username: "admin", role: "admin", credit_balance: 10 },
              }),
            }
          : avatarMiss,
      ),
    );
    global.fetch = fetchMock;

    await expect(useAuthStore.getState().validateSession()).resolves.toBe(true);
    await expect(useAuthStore.getState().validateSession()).resolves.toBe(true);

    expect(authMeCallCount(fetchMock)).toBe(1);
  });

  it("shares the recent /auth/me result between validateSession and getCurrentUser", async () => {
    useAuthStore.setState({ username: "admin", role: "admin" });
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes("/auth/me")
          ? {
              ok: true,
              json: async () => ({
                ok: true,
                data: { username: "admin", role: "admin", credit_balance: 42 },
              }),
            }
          : avatarMiss,
      ),
    );
    global.fetch = fetchMock;

    await expect(useAuthStore.getState().validateSession()).resolves.toBe(true);
    await expect(useAuthStore.getState().getCurrentUser()).resolves.toMatchObject({
      username: "admin",
      credit_balance: 42,
    });

    expect(authMeCallCount(fetchMock)).toBe(1);
  });

  it("can keep local auth state when a non-guard current-user refresh hits a network failure", async () => {
    useAuthStore.setState({ username: "admin", role: "admin" });
    global.fetch = vi.fn().mockRejectedValueOnce(new Error("offline"));

    await expect(
      useAuthStore.getState().getCurrentUser({ clearOnNetworkFailure: false }),
    ).resolves.toBeNull();

    expect(useAuthStore.getState().username).toBe("admin");
    expect(useAuthStore.getState().role).toBe("admin");
  });

  it("validateSession clears state on 401", async () => {
    useAuthStore.setState({ username: "admin", role: "admin" });
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 401 });
    const result = await useAuthStore.getState().validateSession();
    expect(result).toBe(false);
    expect(useAuthStore.getState().username).toBeNull();
  });

  it("keeps state when /auth/me returns a transient 5xx (backend mid-rollout)", async () => {
    // A 502 during a backend rolling restart must NOT log the user out, even on
    // the strict route-guard default: the cookie is still valid and the next
    // poll recovers on 200.
    useAuthStore.setState({ username: "admin", role: "admin" });
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 502 });
    const result = await useAuthStore.getState().validateSession();
    expect(result).toBe(false);
    expect(useAuthStore.getState().username).toBe("admin");
    expect(useAuthStore.getState().role).toBe("admin");
  });

  it("validateSession clears state on network failure", async () => {
    useAuthStore.setState({ username: "admin", role: "admin" });
    global.fetch = vi.fn().mockRejectedValueOnce(new Error("offline"));
    const result = await useAuthStore.getState().validateSession();
    expect(result).toBe(false);
    expect(useAuthStore.getState().username).toBeNull();
  });
});

describe("auth-store abort + reset", () => {
  beforeEach(() => {
    resetRegionAbortController();
    useAuthStore.getState().reset();
    vi.unstubAllGlobals();
  });

  it("login passes regionAbortController.signal to fetch", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    void useAuthStore.getState().login("a", "b");
    await Promise.resolve();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("login rejects when the shared controller aborts mid-flight", async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const p = useAuthStore.getState().login("a", "b");
    regionAbortController().abort();
    await expect(p).rejects.toThrow();
  });

  it("reset() clears username and role", () => {
    useAuthStore.setState({ username: "alice", role: "admin" });
    useAuthStore.getState().reset();
    expect(useAuthStore.getState().username).toBeNull();
    expect(useAuthStore.getState().role).toBeNull();
  });
});
