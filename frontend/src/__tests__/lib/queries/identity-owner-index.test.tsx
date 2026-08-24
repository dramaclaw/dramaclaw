// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import ky from "ky";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
  uploadApi: ky.create({ baseUrl: "http://localhost:3000/" }),
}));

import { useIdentityOwnerIndex } from "@/lib/queries/characters";

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
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
