// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isQuotaExceededError,
  isStaleByTtl,
  pruneLocalStorageByPrefix,
  quotaSafeStateStorage,
  registerStorageReclaimer,
  safeLocalStorageSet,
} from "@/lib/localStorageQuota";

function quotaError(): DOMException {
  return new DOMException("quota", "QuotaExceededError");
}

function createTestStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    key(index: number) {
      return [...store.keys()][index] ?? null;
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}

const originalLocalStorage = window.localStorage;

function installTestStorage(): void {
  const storage = createTestStorage();
  Object.defineProperty(globalThis, "localStorage", { value: storage, writable: true, configurable: true });
  Object.defineProperty(window, "localStorage", { value: storage, writable: true, configurable: true });
}

function restoreOriginalStorage(): void {
  Object.defineProperty(globalThis, "localStorage", {
    value: originalLocalStorage,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, "localStorage", {
    value: originalLocalStorage,
    writable: true,
    configurable: true,
  });
}

describe("safeLocalStorageSet", () => {
  beforeEach(() => {
    installTestStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreOriginalStorage();
  });

  it("writes straight through when there is room", () => {
    const ok = safeLocalStorageSet("k", "v");
    expect(ok).toBe(true);
    expect(window.localStorage.getItem("k")).toBe("v");
  });

  it("prunes via reclaimers then retries once on quota overflow", () => {
    const reclaim = vi.fn(() => {
      window.localStorage.removeItem("junk");
    });
    const unregister = registerStorageReclaimer(reclaim);
    window.localStorage.setItem("junk", "big");

    const setItem = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementationOnce(() => {
        throw quotaError();
      });

    const ok = safeLocalStorageSet("settings-storage", "small");

    expect(reclaim).toHaveBeenCalledTimes(1);
    expect(ok).toBe(true);
    // First call threw (mockImplementationOnce); the retry used the real impl.
    expect(setItem).toHaveBeenCalledTimes(2);

    unregister();
  });

  it("returns false without reclaiming on a non-quota error", () => {
    const reclaim = vi.fn();
    const unregister = registerStorageReclaimer(reclaim);

    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    const ok = safeLocalStorageSet("k", "v");

    expect(ok).toBe(false);
    expect(reclaim).not.toHaveBeenCalled();

    unregister();
  });

  it("returns false when the retry still overflows", () => {
    const unregister = registerStorageReclaimer(() => {
      /* frees nothing */
    });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw quotaError();
    });

    expect(safeLocalStorageSet("k", "v")).toBe(false);

    unregister();
  });

  it("drops its own key and retries when reclaimers free nothing", () => {
    const unregister = registerStorageReclaimer(() => {
      /* no key this reclaimer owns is freeable */
    });
    const real = window.localStorage.setItem.bind(window.localStorage);
    let calls = 0;
    vi.spyOn(window.localStorage, "setItem").mockImplementation(function (
      this: Storage,
      k: string,
      v: string,
    ) {
      calls += 1;
      // Initial write + post-reclaim retry both overflow; only after the
      // target key's own value is removed does the write fit.
      if (calls <= 2) throw quotaError();
      return real(k, v);
    });

    const ok = safeLocalStorageSet("supertale-app", "payload");

    expect(ok).toBe(true);
    expect(calls).toBe(3);
    expect(window.localStorage.getItem("supertale-app")).toBe("payload");
    unregister();
  });
});

describe("isStaleByTtl", () => {
  it("is false for a fresh timestamp within the TTL", () => {
    expect(isStaleByTtl(1_000, 5_000, 10_000)).toBe(false);
  });

  it("is true once the timestamp is older than the TTL", () => {
    expect(isStaleByTtl(1_000, 20_000, 10_000)).toBe(true);
  });

  it("is true for a future timestamp (clock skew / corruption)", () => {
    expect(isStaleByTtl(20_000, 5_000, 10_000)).toBe(true);
  });
});

describe("pruneLocalStorageByPrefix", () => {
  beforeEach(() => {
    installTestStorage();
  });

  afterEach(() => {
    restoreOriginalStorage();
  });

  it("removes matching keys the predicate rejects and keeps the rest", () => {
    window.localStorage.setItem("p:keep", "1");
    window.localStorage.setItem("p:drop", "1");
    window.localStorage.setItem("other:keep", "1");

    pruneLocalStorageByPrefix("p:", (key) => key.endsWith(":drop"));

    expect(window.localStorage.getItem("p:keep")).toBe("1");
    expect(window.localStorage.getItem("p:drop")).toBeNull();
    expect(window.localStorage.getItem("other:keep")).toBe("1");
  });

  it("removes every matching key without skipping due to index shift", () => {
    for (let i = 0; i < 5; i += 1) window.localStorage.setItem(`p:${i}`, "1");

    pruneLocalStorageByPrefix("p:", () => true);

    for (let i = 0; i < 5; i += 1) {
      expect(window.localStorage.getItem(`p:${i}`)).toBeNull();
    }
  });

  it("accepts a function matcher and passes raw to the predicate", () => {
    window.localStorage.setItem("a", "stale");
    window.localStorage.setItem("b", "fresh");

    pruneLocalStorageByPrefix(
      (key) => key === "a" || key === "b",
      (_key, raw) => raw === "stale",
    );

    expect(window.localStorage.getItem("a")).toBeNull();
    expect(window.localStorage.getItem("b")).toBe("fresh");
  });
});

describe("quotaSafeStateStorage", () => {
  beforeEach(() => {
    installTestStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreOriginalStorage();
  });

  it("reads and writes through like normal storage", () => {
    quotaSafeStateStorage.setItem("k", "v");
    expect(quotaSafeStateStorage.getItem("k")).toBe("v");
    quotaSafeStateStorage.removeItem("k");
    expect(quotaSafeStateStorage.getItem("k")).toBeNull();
  });

  it("runs reclaimers and retries when setItem overflows", () => {
    const reclaim = vi.fn(() => window.localStorage.removeItem("junk"));
    const unregister = registerStorageReclaimer(reclaim);
    window.localStorage.setItem("junk", "big");
    vi.spyOn(window.localStorage, "setItem").mockImplementationOnce(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    quotaSafeStateStorage.setItem("supertale-app", "payload");

    expect(reclaim).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem("supertale-app")).toBe("payload");
    unregister();
  });

  it("never throws even when storage is fully unavailable", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    expect(() => quotaSafeStateStorage.setItem("k", "v")).not.toThrow();
  });
});

describe("isQuotaExceededError", () => {
  it("matches the DOMException quota name", () => {
    expect(isQuotaExceededError(quotaError())).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(isQuotaExceededError(new Error("nope"))).toBe(false);
    expect(isQuotaExceededError(null)).toBe(false);
  });
});
