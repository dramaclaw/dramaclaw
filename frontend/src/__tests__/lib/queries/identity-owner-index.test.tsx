// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import ky from "ky";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
  uploadApi: ky.create({ baseUrl: "http://localhost:3000/" }),
}));

import {
  useCreateIdentity,
  useDeleteIdentity,
  useIdentityOwnerIndex,
} from "@/lib/queries/characters";
// Shared server, not a second `setupServer()` — two listening instances dispatch
// every request twice, which doubles the request counters these tests assert on.
import { server } from "@/__mocks__/msw/server";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

// A wrapper that holds ONE client across re-renders. The plain `wrapper` above
// builds a fresh QueryClient in its body, so every re-render starts from an
// empty cache — fine for a single read, useless for a mutation test, where the
// entire question is whether invalidation reaches a cache that is still there.
function makeStableWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("useIdentityOwnerIndex", () => {
  // This hook used to fan out `/characters/{name}/identities` for every
  // character in the project, unconditionally on mount — 100 characters meant
  // 100 requests on every visit to the assets page, to build a lookup table
  // that is only read when an `?type=identity&id=` deep link is present.
  it("resolves owners from the character list without per-character requests", async () => {
    const identityPaths: string[] = [];
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/characters", () =>
        HttpResponse.json({
          ok: true,
          data: [
            { name: "林昭", identity_ids: ["林昭_青年", "林昭_少年"] },
            { name: "苏清晏", identity_ids: ["苏清晏_少女"] },
            { name: "路人", identity_ids: [] },
          ],
        }),
      ),
      http.get(
        "http://localhost:3000/api/v1/projects/demo/characters/:name/identities",
        ({ request }) => {
          identityPaths.push(new URL(request.url).pathname);
          return HttpResponse.json({ ok: true, data: [] });
        },
      ),
    );

    const { result } = renderHook(() => useIdentityOwnerIndex("demo"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.ownerOf("林昭_少年")).toBe("林昭");
    expect(result.current.ownerOf("苏清晏_少女")).toBe("苏清晏");
    expect(result.current.ownerOf("不存在的身份")).toBeNull();
    // The whole point: the owner index costs the character list and nothing else.
    expect(identityPaths).toEqual([]);
  });

  it("reports no owner while the character list is still loading", async () => {
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/characters", () =>
        HttpResponse.json({ ok: true, data: [] }),
      ),
    );

    const { result } = renderHook(() => useIdentityOwnerIndex("demo"), {
      wrapper,
    });

    expect(result.current.ownerOf("林昭_青年")).toBeNull();
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.ownerOf("林昭_青年")).toBeNull();
  });

  // Older backends predate `identity_ids`; a missing field must degrade to
  // "deep link unresolved", not to a crash on `undefined.length`.
  it("tolerates a character list without identity_ids", async () => {
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/characters", () =>
        HttpResponse.json({ ok: true, data: [{ name: "林昭" }] }),
      ),
    );

    const { result } = renderHook(() => useIdentityOwnerIndex("demo"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.ownerOf("林昭_青年")).toBeNull();
  });
});

// The owner map is what `?type=identity&id=` deep links resolve against, and it
// is built from `identity_ids` on the CHARACTER list — a different query key
// from the identities list the mutation obviously touches. Invalidating only
// `queryKeys.identities` therefore leaves the map holding a membership set that
// no longer matches, and the staleness lasts as long as the page stays mounted:
// a link to an identity the user just created resolves to no owner at all.
describe("owner index freshness across identity mutations", () => {
  function serveCharacters(identityIds: () => string[]) {
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/characters", () =>
        HttpResponse.json({
          ok: true,
          data: [{ name: "lin", identity_ids: identityIds() }],
        }),
      ),
    );
  }

  it("resolves the owner of a just-created identity without a remount", async () => {
    let owned = ["lin_young"];
    serveCharacters(() => owned);
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/characters/lin/identities",
        () => {
          owned = ["lin_young", "lin_old"];
          return HttpResponse.json({
            ok: true,
            data: { identity_id: "lin_old" },
          });
        },
      ),
    );

    const { result } = renderHook(
      () => ({
        index: useIdentityOwnerIndex("demo"),
        create: useCreateIdentity("demo", "lin"),
      }),
      { wrapper: makeStableWrapper() },
    );

    await waitFor(() => expect(result.current.index.isLoading).toBe(false));
    expect(result.current.index.ownerOf("lin_old")).toBeNull();

    await act(async () => {
      await result.current.create.mutateAsync({ identity_name: "old" });
    });

    await waitFor(() =>
      expect(result.current.index.ownerOf("lin_old")).toBe("lin"),
    );
  });

  it("drops the owner of a deleted identity without a remount", async () => {
    let owned = ["lin_young", "lin_old"];
    serveCharacters(() => owned);
    server.use(
      http.delete(
        "http://localhost:3000/api/v1/projects/demo/characters/lin/identities/lin_old",
        () => {
          owned = ["lin_young"];
          return HttpResponse.json({ ok: true, data: null });
        },
      ),
    );

    const { result } = renderHook(
      () => ({
        index: useIdentityOwnerIndex("demo"),
        remove: useDeleteIdentity("demo", "lin"),
      }),
      { wrapper: makeStableWrapper() },
    );

    await waitFor(() => expect(result.current.index.isLoading).toBe(false));
    expect(result.current.index.ownerOf("lin_old")).toBe("lin");

    await act(async () => {
      await result.current.remove.mutateAsync("lin_old");
    });

    await waitFor(() =>
      expect(result.current.index.ownerOf("lin_old")).toBeNull(),
    );
    // The surviving identity must still resolve — a blanket cache reset would
    // pass the assertion above for the wrong reason.
    expect(result.current.index.ownerOf("lin_young")).toBe("lin");
  });
});
