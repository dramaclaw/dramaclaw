// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useGithubStars } from "@/hooks/use-github-stars";

const STORAGE_KEY = "dramaclaw.login.githubStars";
const REPO = "dramaclaw/dramaclaw";

function mockFetchOk(count: number) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ stargazers_count: count }),
  });
}

describe("useGithubStars", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("seeds the first render synchronously from the stored value", () => {
    window.localStorage.setItem(STORAGE_KEY, "1234");
    vi.stubGlobal("fetch", mockFetchOk(1234));

    const { result } = renderHook(() => useGithubStars(REPO));

    // No await: the stored value is available on the very first render.
    expect(result.current).toBe(1234);
  });

  it("updates the value and persists it to localStorage on a successful fetch", async () => {
    vi.stubGlobal("fetch", mockFetchOk(1500));

    const { result } = renderHook(() => useGithubStars(REPO));

    await waitFor(() => expect(result.current).toBe(1500));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("1500");
  });

  it("keeps the stored value when the request is rate-limited (403)", async () => {
    window.localStorage.setItem(STORAGE_KEY, "1234");
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 403, json: () => Promise.resolve(null) });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useGithubStars(REPO));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Falls back to the persisted value instead of hiding the badge.
    expect(result.current).toBe(1234);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("1234");
  });

  it("stays null and does not throw when the fetch rejects with no stored value", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useGithubStars(REPO));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(result.current).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
