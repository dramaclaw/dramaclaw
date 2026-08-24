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
  useAssetReferenceCounts,
  useAssetReferences,
  type AssetRef,
} from "@/lib/queries/asset-references";
import { useUpdateCharacter } from "@/lib/queries/characters";
// The shared server from `__tests__/setup.ts`, not a second `setupServer()`.
// Two listening MSW instances both dispatch every request, which silently
// doubles any handler-side call counter — and counting requests is the whole
// point of the dedup assertions below.
import { server } from "@/__mocks__/msw/server";

// The client is created per-test and held outside the component, not built in
// the wrapper body: these tests re-render, and a fresh QueryClient per render
// would drop the cache and re-issue every request — which is exactly what the
// dedup assertion below is measuring.
function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

/** Capture the `ids` the hook actually asks the backend for, and echo them back. */
function captureIds(): { get: () => string[] } {
  let seen: string[] = [];
  server.use(
    http.get(
      "http://localhost:3000/api/v1/projects/demo/assets/references",
      ({ request }) => {
        seen = new URL(request.url).searchParams.getAll("ids");
        return HttpResponse.json({
          ok: true,
          data: {
            counts: {},
            // Echo one beat per requested key, so `referencesFor` resolving to a
            // non-empty list proves the key survived the request round-trip.
            references: Object.fromEntries(
              seen.map((key, i) => [key, [{ episode: 1, beat_number: i + 1 }]]),
            ),
            scene_co_occurrence: {},
          },
        });
      },
    ),
  );
  return { get: () => seen };
}

describe("useAssetReferences id round-trip", () => {
  // Asset ids are user-authored names. A space-separated cache signature used to
  // be split back apart on whitespace, so `prop:red wine glass` left as one id
  // and came back as three that match nothing — an empty beat list, no error.
  it("keeps ids containing spaces intact", async () => {
    const captured = captureIds();
    const refs: AssetRef[] = [
      { type: "prop", id: "red wine glass" },
      { type: "scene", id: "New York Office" },
    ];

    const { result } = renderHook(() => useAssetReferences("demo", refs), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(captured.get()).toEqual([
      "prop:red wine glass",
      "scene:New York Office",
    ]);
    expect(result.current.referencesFor("prop", "red wine glass")).toHaveLength(1);
    expect(result.current.referencesFor("scene", "New York Office")).toHaveLength(1);
  });

  it("keeps ids containing separators and url-significant characters intact", async () => {
    const captured = captureIds();
    const refs: AssetRef[] = [
      { type: "identity", id: "a:b" },
      { type: "prop", id: "100% cotton" },
      { type: "prop", id: "tag#1" },
      { type: "scene", id: "hall / lobby" },
    ];

    const { result } = renderHook(() => useAssetReferences("demo", refs), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(captured.get().sort()).toEqual(
      [
        "identity:a:b",
        "prop:100% cotton",
        "prop:tag#1",
        "scene:hall / lobby",
      ].sort(),
    );
    // `identity:a:b` is the one that survives a naive `split(":")` too — assert
    // the hook hands it back under the full id, not the truncated `a`.
    expect(result.current.referencesFor("identity", "a:b")).toHaveLength(1);
    expect(result.current.referencesFor("identity", "a")).toHaveLength(0);
    expect(result.current.referencesFor("prop", "100% cotton")).toHaveLength(1);
    expect(result.current.referencesFor("scene", "hall / lobby")).toHaveLength(1);
  });

  it("reuses one cache entry for the same set regardless of order or duplicates", async () => {
    const urls: string[] = [];
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/assets/references",
        ({ request }) => {
          urls.push(request.url);
          return HttpResponse.json({
            ok: true,
            data: { counts: {}, references: {}, scene_co_occurrence: {} },
          });
        },
      ),
    );

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    }

    const { result, rerender } = renderHook(
      ({ refs }: { refs: AssetRef[] }) => useAssetReferences("demo", refs),
      {
        wrapper: Wrapper,
        initialProps: {
          refs: [
            { type: "prop", id: "red wine glass" },
            { type: "identity", id: "lin" },
          ] as AssetRef[],
        },
      },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Same set, new array identity, reversed, with a duplicate.
    rerender({
      refs: [
        { type: "identity", id: "lin" },
        { type: "prop", id: "red wine glass" },
        { type: "identity", id: "lin" },
      ] as AssetRef[],
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(urls).toHaveLength(1);
    expect(qc.getQueryCache().getAll()).toHaveLength(1);
  });

  it("issues no request when nothing is on screen", async () => {
    let calls = 0;
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/assets/references",
        () => {
          calls += 1;
          return HttpResponse.json({
            ok: true,
            data: { counts: {}, references: {}, scene_co_occurrence: {} },
          });
        },
      ),
    );

    const { result } = renderHook(() => useAssetReferences("demo", []), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(calls).toBe(0);
    expect(result.current.referencesFor("prop", "anything")).toEqual([]);
  });
});


// Renaming a character is not just a characters-table edit: the backend's
// `_cascade_character_rename` runs `UPDATE beats SET detected_identities_json,
// visual_description` across the project, remapping every embedded identity id
// and inline marker. Those two columns are precisely what the reference scan
// reads, so a rename moves the whole index. The counts live under their own
// project-wide key, which a `characters` invalidation never reaches — the
// grid's "used in N beats" badges keep the pre-rename numbers, and the renamed
// identity's card reads 0, until something forces a remount.
describe("asset reference counts across a character rename", () => {
  function makeStableWrapper() {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return function Wrapper({ children }: { children: ReactNode }) {
      return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    };
  }

  it("refetches counts after a rename, without a remount", async () => {
    let counts: Record<string, number> = { "identity:lin_young": 4 };
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/assets/references",
        () =>
          HttpResponse.json({
            ok: true,
            data: { counts, references: {}, scene_co_occurrence: {} },
          }),
      ),
      http.patch("http://localhost:3000/api/v1/projects/demo/characters/lin", () => {
        counts = { "identity:shen_young": 4 };
        return HttpResponse.json({
          ok: true,
          data: { name: "shen", updated_fields: ["name"], renamed_from: "lin" },
        });
      }),
    );

    const { result } = renderHook(
      () => ({
        refs: useAssetReferenceCounts("demo"),
        rename: useUpdateCharacter("demo", "lin"),
      }),
      { wrapper: makeStableWrapper() },
    );

    await waitFor(() => expect(result.current.refs.isLoading).toBe(false));
    expect(result.current.refs.countFor("identity", "lin_young")).toBe(4);
    expect(result.current.refs.countFor("identity", "shen_young")).toBe(0);

    await act(async () => {
      await result.current.rename.mutateAsync({ name: "shen" });
    });

    await waitFor(() =>
      expect(result.current.refs.countFor("identity", "shen_young")).toBe(4),
    );
    expect(result.current.refs.countFor("identity", "lin_young")).toBe(0);
  });

  // Reverse sentinel: an edit the backend did NOT treat as a rename leaves
  // `renamed_from` unset, no cascade ran, and the index is still correct —
  // refetching it would be waste on every appearance tweak.
  it("leaves the counts alone for an edit that is not a rename", async () => {
    let referenceRequests = 0;
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/assets/references",
        () => {
          referenceRequests += 1;
          return HttpResponse.json({
            ok: true,
            data: {
              counts: { "identity:lin_young": 4 },
              references: {},
              scene_co_occurrence: {},
            },
          });
        },
      ),
      http.patch("http://localhost:3000/api/v1/projects/demo/characters/lin", () =>
        HttpResponse.json({
          ok: true,
          data: { name: "lin", updated_fields: ["description"] },
        }),
      ),
    );

    const { result } = renderHook(
      () => ({
        refs: useAssetReferenceCounts("demo"),
        update: useUpdateCharacter("demo", "lin"),
      }),
      { wrapper: makeStableWrapper() },
    );

    await waitFor(() => expect(result.current.refs.isLoading).toBe(false));
    expect(referenceRequests).toBe(1);

    await act(async () => {
      await result.current.update.mutateAsync({ description: "换了个设定" });
    });

    expect(referenceRequests).toBe(1);
  });
});
