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

import { useDeleteIdentityCostume } from "@/lib/queries/characters";

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("identity costume query hooks", () => {
  it("posts to the identity costume delete endpoint", async () => {
    let requestedPath = "";
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/characters/%E7%A7%A6/identities/id-1/costume/delete",
        ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          return HttpResponse.json({
            ok: true,
            data: { deleted: true },
          });
        },
      ),
    );

    const { result } = renderHook(() => useDeleteIdentityCostume("demo", "秦"), {
      wrapper,
    });
    result.current.mutate("id-1");

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe(
      "/api/v1/projects/demo/characters/%E7%A7%A6/identities/id-1/costume/delete",
    );
    expect(result.current.data?.data.deleted).toBe(true);
  });
});
