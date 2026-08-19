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
  useRenderSettings,
  useUpdateRenderSettings,
} from "@/lib/queries/render-settings";

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("render settings query", () => {
  it("loads the Render image model and sketch padding switch", async () => {
    let requestedPath = "";
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/render-settings", ({ request }) => {
        requestedPath = new URL(request.url).pathname;
        return HttpResponse.json({
          ok: true,
          data: {
            render_image_selection: "openrouter_nanobanana2",
            options: {
              openrouter_nanobanana2: "OpenRouter NanoBanana 2",
            },
            sketch_aspect_padding: true,
          },
        });
      }),
    );

    const { result } = renderHook(() => useRenderSettings("demo"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe("/api/v1/projects/demo/render-settings");
    expect(result.current.data?.data.render_image_selection).toBe(
      "openrouter_nanobanana2",
    );
    expect(result.current.data?.data.sketch_aspect_padding).toBe(true);
  });

  it("patches Render settings through the project-level contract", async () => {
    let requestedPath = "";
    let receivedBody: unknown = undefined;
    server.use(
      http.patch(
        "http://localhost:3000/api/v1/projects/demo/render-settings",
        async ({ request }) => {
          requestedPath = new URL(request.url).pathname;
          receivedBody = await request.clone().json();
          return HttpResponse.json({
            ok: true,
            data: {
              render_image_selection: "openrouter_nanobanana2",
              options: {
                openrouter_nanobanana2: "OpenRouter NanoBanana 2",
              },
            sketch_aspect_padding: true,
          },
        });
        },
      ),
    );

    const { result } = renderHook(() => useUpdateRenderSettings("demo"), {
      wrapper,
    });

    result.current.mutate({
      render_image_selection: "openrouter_nanobanana2",
      sketch_aspect_padding: true,
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requestedPath).toBe("/api/v1/projects/demo/render-settings");
    expect(receivedBody).toEqual({
      render_image_selection: "openrouter_nanobanana2",
      sketch_aspect_padding: true,
    });
  });
});
