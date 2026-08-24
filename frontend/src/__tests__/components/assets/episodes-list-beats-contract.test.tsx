// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 打开分集列表不能去拉任意一集的完整 beats。
 *
 * 这一页的每张卡片都要显示镜头数，原先是每张卡片自己 ``useEpisodeBeats``——列表有
 * 几集就发几个 ``/episodes/{n}/beats``，而那是最贵的路由（开库、给每个 beat 拼四个
 * 资产 URL、对每条音频 fork 一次 ffprobe），只为取一个 ``.length``。本 PR 把它换成
 * 列表接口一次 GROUP BY 带出来的 ``beat_count``。
 *
 * 断言落在网络层、且渲染的是整页而不是单个 hook：扇出从来不体现在渲染结果里，它体
 * 现在"页面组合层碰巧调了哪些 hook"上——正是 UI 重构会悄悄接回去的那一类。
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { http, HttpResponse } from "msw";
import ky from "ky";
import type { ReactNode } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { server } from "@/__mocks__/msw/server";

vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
  uploadApi: ky.create({ baseUrl: "http://localhost:3000/" }),
}));

// 路由只留到能让页面跑起来：这个文件断言的是网络看见了什么，不是导航。
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({
    useParams: () => ({ project: "demo" }),
    useSearch: () => ({}),
  }),
  Link: ({ children, ...rest }: { children: ReactNode }) => (
    <a {...(rest as object)}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
  useParams: () => ({ project: "demo" }),
  // ``useActiveStagePath`` 用的是 select 形式，mock 必须把选择器真的跑一遍，
  // 否则拿到的是整个 state 对象而不是 pathname 字符串。
  useRouterState: ({ select }: { select?: (s: unknown) => unknown } = {}) => {
    const state = { location: { pathname: "/projects/demo/episodes" } };
    return select ? select(state) : state;
  },
  useMatches: () => [],
}));

vi.mock("@/hooks/use-task-controller", () => ({
  useTaskController: () => ({
    started: false,
    stream: { status: "idle", progress: 0, currentTask: "", result: null, error: null },
    logs: [],
    start: vi.fn(),
    stop: vi.fn(),
    stopping: false,
  }),
}));

import { EpisodesPage } from "@/routes/_app/projects.$project/episodes";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en", resources: {} });
});

function recordRequests(): string[] {
  const seen: string[] = [];
  server.use(
    http.get("http://localhost:3000/api/v1/*", ({ request }) => {
      seen.push(new URL(request.url).pathname);
      return HttpResponse.json({ ok: true, data: [] });
    }),
  );
  return seen;
}

function renderWithProviders(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </I18nextProvider>,
  );
}

describe("the episode list does not read the beats table", () => {
  it("renders every episode card without requesting any episode's beats", async () => {
    const seen = recordRequests();
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/episodes", ({ request }) => {
        // 专用 handler 比 catch-all 优先，得自己记一笔，否则这条请求不进 ``seen``。
        seen.push(new URL(request.url).pathname);
        return HttpResponse.json({
          ok: true,
          data: [
            { number: 1, title: "第一集", beat_count: 7 },
            { number: 2, title: "第二集", beat_count: 4 },
            { number: 3, title: "第三集", beat_count: 0 },
          ],
        });
      }),
    );

    renderWithProviders(<EpisodesPage />);

    // 先确认三张卡片真的渲染出来了——否则页面崩在半路，下面那条 ``/beats`` 断言
    // 会因为什么都没发而空过。
    expect(await screen.findByText("第一集")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("第三集")).toBeInTheDocument());
    expect(seen.filter((path) => path.endsWith("/episodes"))).toHaveLength(1);
    // 三集，三张卡片，零个 beats 请求。这里写 toEqual([]) 而不是数个数：回归的形状
    // 就是"每集一个"，列出来比一个数字更能说明是哪几集漏了。
    expect(seen.filter((path) => path.includes("/beats"))).toEqual([]);
  });
});
