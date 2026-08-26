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

import { queryKeys } from "@/lib/query-keys";
import { useAddProjectGrant, useProjectGrants } from "@/lib/queries/projects";

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper(queryClient: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function grant(index: number) {
  return {
    id: `g${index}`,
    project_id: "p1",
    principal_type: "user",
    principal_id: `u${index}`,
    principal_username: `user${index}`,
    role: "editor",
  };
}

describe("project grant mutation refresh", () => {
  it("only resolves once the member list has caught up", async () => {
    // 配额只有前端在数，数的就是这份名单。mutation 先结束、刷新还在路上的话，
    // 那个窗口里 isLoading 是 false、data 还是加人之前的旧数量——照它放行，
    // 下一次添加就可能是真的第 26 个。
    const rows = [grant(0), grant(1)];
    server.use(
      http.get("http://localhost:3000/api/v1/projects/p1/grants", () =>
        HttpResponse.json({ ok: true, data: rows }),
      ),
      http.post("http://localhost:3000/api/v1/projects/p1/grants", async () => {
        // 幂等地加：msw + ky 在 jsdom 里会把同一个 POST 的 resolver 跑两遍
        // （拿一次普通 ky.post 单测过），照 push 会数出多出来的一行。
        if (!rows.some((row) => row.id === "g2")) rows.push(grant(2));
        return HttpResponse.json({ ok: true, data: grant(2) });
      }),
    );

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => ({ grants: useProjectGrants("p1"), add: useAddProjectGrant("p1") }),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.grants.data?.data).toHaveLength(2));

    await result.current.add.mutateAsync({ principal_username: "user2", role: "editor" });

    // mutateAsync 一返回，缓存里的名单就必须是加完人之后的那份。
    // （读缓存而不是读 hook 快照：后者还要等 React 重渲染，测的就不是这件事了。）
    const cached = queryClient.getQueryData<{ data: unknown[] }>(queryKeys.projectGrants("p1"));
    expect(cached?.data).toHaveLength(3);
  });
});
