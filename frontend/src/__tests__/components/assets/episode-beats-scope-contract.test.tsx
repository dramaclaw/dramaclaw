// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 真正进入某一集时，只能请求当前这一集的 beats。
 *
 * ``/episodes/{n}/beats`` 是全项目最贵的路由：开库、给每个 beat 拼四个资产 URL、
 * 对每条音频 fork 一次 ffprobe。分集列表已经不碰它了（见
 * ``episodes-list-beats-contract.test.tsx``），剩下的合同是——点进第 3 集就只拉第
 * 3 集，不能顺手把别的集也带出来。
 *
 * 和另外两个合同测试同一个理由渲染整页：多拉一集从来不体现在渲染结果里，它体现在
 * "页面组合层碰巧调了哪些 hook"上。
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

vi.mock("@tanstack/react-router", () => ({
  createLazyFileRoute: () => () => ({
    useParams: () => ({ project: "demo", episode: "3" }),
    useSearch: () => ({}),
  }),
  Link: ({ children, ...rest }: { children: ReactNode }) => (
    <a {...(rest as object)}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
  useParams: () => ({ project: "demo", episode: "3" }),
  useRouterState: ({ select }: { select?: (s: unknown) => unknown } = {}) => {
    const state = { location: { pathname: "/projects/demo/episodes/3/beats" } };
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

import { TaskCenterProvider } from "@/task-center/provider";
import { BeatsTabContent } from "@/routes/_app/projects.$project/episodes.$episode/beats.lazy";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en", resources: {} });
  // jsdom 不实现这几个，缺了组件会直接抛掉。
  Element.prototype.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  // ``BeatCardGrid`` 经 ``useResponsiveColumns`` 用到；jsdom 没有实现，构造函数会抛在
  // effect 里，整棵子树被 React 卸载，页面一片空白——请求断言反而会因为"什么都没发"
  // 而空过。空壳够用：该 hook 在建 observer 之前已经先 ``measure()`` 过一次，jsdom 里
  // 宽度恒为 0，列数取哪个分支都不影响这里要断言的请求面。
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

function recordRequests(): string[] {
  const seen: string[] = [];
  server.use(
    http.get("http://localhost:3000/api/v1/*", ({ request }) => {
      seen.push(new URL(request.url).pathname);
      return HttpResponse.json({ ok: true, data: [] });
    }),
  );
  // 分两次 use：``server.use`` 是 unshift，后注册的排在前面，本集 beats 得压过上面
  // 那条 catch-all，页面才有东西渲染，断言才不会空过。
  server.use(
    http.get("http://localhost:3000/api/v1/projects/demo/episodes/3/beats", ({ request }) => {
      // 专用 handler 不走 catch-all，得自己记一笔，否则这条请求不进 ``seen``。
      seen.push(new URL(request.url).pathname);
      return HttpResponse.json({
        ok: true,
        // 按 ``types/episode.ts`` 的 ``Beat`` 给字段：``beat_number`` 是 ``BeatCardGrid``
        // 的 React key，缺了它两张卡会同 key 折成一张，"渲染出两张"的前置断言就失真。
        data: [
          { beat_number: 1, narration_segment: "第三集第一拍", visual_description: "" },
          { beat_number: 2, narration_segment: "第三集第二拍", visual_description: "" },
        ],
      });
    }),
  );
  return seen;
}

function renderWithProviders(ui: ReactNode) {
  // ``staleTime`` 要跟 ``main.tsx`` 的 30s 对齐，不能用库默认的 0。这一页有两个
  // observer 订同一把 beats key（页面自己一个，``useBeatStates`` 里一个），
  // staleTime=0 时后挂上来的那个会再取一次——production 里不会发生，测试里却会让
  // "只请求当前集一次"变成两条。对齐之后这条断言量的才是真实请求面。
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={qc}>
        {/* 页面里的 ``useEpisodeImageTaskInvalidation`` 要订阅任务事件总线，
            没有这个 Provider 会直接抛。用真的而不是空壳，省得把订阅逻辑一起 mock 掉。 */}
        <TaskCenterProvider projectId="demo">{ui}</TaskCenterProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

describe("entering one episode reads only that episode's beats", () => {
  it("requests /episodes/3/beats exactly once and no other episode's", async () => {
    const seen = recordRequests();

    renderWithProviders(<BeatsTabContent />);

    // 先确认本集内容真的渲染出来了——否则页面崩在半路，下面的请求断言会因为什么
    // 都没发而空过。
    //
    // 认卡片而不是认台词：默认视图 ``BeatCardGrid`` 铺的是图片卡，narration 只进编辑
    // 面板，不在卡面上。每张卡有一个勾选按钮，i18n 资源为空时 ``t()`` 原样返回 key，
    // 数它就等于数卡片。
    await waitFor(() =>
      expect(screen.getAllByLabelText("episode.beat.select")).toHaveLength(2),
    );

    // 列出具体路径而不是数个数——回归的形状是"顺手多拉了第几集"，列出来才看得出。
    expect(seen.filter((path) => path.includes("/beats"))).toEqual([
      "/api/v1/projects/demo/episodes/3/beats",
    ]);
  });
});
