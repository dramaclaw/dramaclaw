// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// TCP-EU-B4b 第 2 节 —— `/sketches/generate-missing-manual` 的尽力投递半边。
//
// 这个端点**自愈**：后端每次都重算还缺哪些手动镜头段（CE
// `src/novelvideo/api/routes/generation.py:4425` `missing_manual_shot_segments`），
// 所以「只重投被拒的那部分」在这里的正确形状就是**逐字再调一次同一个请求**：
// 没有 body、没有 scope、没有任何新参数。本文件把这条钉死，防止后来人往
// 重投里塞「把被拒的 scope 回传」这种会双计费的自由发挥。
import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import ky from "ky";
import type { ReactNode } from "react";

// 同 `src/__tests__/lib/queries/render-plan.test.tsx:11-17` 的既有处方。
vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
  handleSessionExpired: vi.fn(),
  setApiQueryClient: vi.fn(),
}));

import { server } from "@/__mocks__/msw/server";
import {
  useGenerateMissingManualSketches,
  type GenerateMissingManualResult,
} from "@/lib/queries/sketches";

interface Seen {
  url: string;
  method: string;
  body: string;
}

let seen: Seen[];

beforeEach(() => {
  seen = [];
  server.use(
    http.post("*/sketches/generate-missing-manual", async ({ request }) => {
      seen.push({
        url: new URL(request.url).pathname,
        method: request.method,
        body: await request.text(),
      });
      return HttpResponse.json({
        ok: true,
        task_type: "sketch_regen",
        data: {
          dispatched: 2,
          scopes: ["a", "b"],
          segments: [[1, 2], [3, 4]],
          rejected: [{ scope: "c", reason: "channel", limit: 12, active: 12 }],
        },
      });
    }),
  );
});

afterEach(() => vi.clearAllMocks());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useGenerateMissingManualSketches — 尽力投递后的重投", () => {
  it("重投＝逐字同一个请求（无 body、无 scope、无新参数）", async () => {
    const { result } = renderHook(() => useGenerateMissingManualSketches("demo", 1), {
      wrapper,
    });

    await result.current.mutateAsync();
    await result.current.mutateAsync();

    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0].body).toBe("{}");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe(
      "/api/v1/projects/demo/episodes/1/sketches/generate-missing-manual",
    );
  });

  it("响应里的 `rejected` 被类型承认，且不再被注释说成 diagnostics", async () => {
    const { result } = renderHook(() => useGenerateMissingManualSketches("demo", 1), {
      wrapper,
    });
    const res = (await result.current.mutateAsync()) as {
      data: GenerateMissingManualResult;
    };
    expect(res.data.rejected).toEqual([
      { scope: "c", reason: "channel", limit: 12, active: 12 },
    ]);

    // 形制先例：`src/__tests__/routes/beats-sketch-render-contract.test.ts` 就是
    // 在源码字符串层面钉契约。这里钉的是「注释别再骗人」：`rejected` 要驱动重投，
    // 不是只给人看的诊断字段。
    const source = readFileSync("src/lib/queries/sketches.ts", "utf8");
    expect(source).toContain("rejected");
    expect(source).not.toContain("surfaced for diagnostics only");
  });
});
