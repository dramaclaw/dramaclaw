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

import {
  useSketchSettings,
  useUpdateSketchSettings,
} from "@/lib/queries/sketch-settings";

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("sketch settings query", () => {
  it("loads Sketch-stage image model settings", async () => {
    let requestedPath = "";
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/sketch-settings",
        ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          return HttpResponse.json({
            ok: true,
            data: {
              sketch_image_selection: "openrouter_nanobanana2",
              options: { openrouter_nanobanana2: "OpenRouter NanoBanana 2" },
            },
          });
        },
      ),
    );

    const { result } = renderHook(() => useSketchSettings("demo"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe("/api/v1/projects/demo/sketch-settings");
    expect(result.current.data?.data.sketch_image_selection).toBe(
      "openrouter_nanobanana2",
    );
  });

  it("patches Sketch-stage image model settings", async () => {
    let requestedPath = "";
    let receivedBody: unknown = undefined;
    server.use(
      http.patch(
        "http://localhost:3000/api/v1/projects/demo/sketch-settings",
        async ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          receivedBody = await request.clone().json();
          return HttpResponse.json({
            ok: true,
            data: {
              sketch_image_selection: "openrouter_nanobanana2",
              options: { openrouter_nanobanana2: "OpenRouter NanoBanana 2" },
            },
          });
        },
      ),
    );

    const { result } = renderHook(() => useUpdateSketchSettings("demo"), {
      wrapper,
    });

    result.current.mutate({
      sketch_image_selection: "openrouter_nanobanana2",
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe("/api/v1/projects/demo/sketch-settings");
    expect(receivedBody).toEqual({
      sketch_image_selection: "openrouter_nanobanana2",
    });
  });
});
