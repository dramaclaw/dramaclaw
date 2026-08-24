// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 打开角色 Tab 不能按角色扇出 identities。
 *
 * ``/characters/{name}/identities`` 原先是每个角色一发——列表里有几个角色就几个请
 * 求，只为在侧栏上标一个身份数。现在归属关系由 ``useIdentityOwnerIndex`` 从角色列
 * 表自带的 ``identity_ids`` 一次算出，真正的身份详情只给**选中**的那个角色拉。
 *
 * 和 ``episodes-list-beats-contract.test.tsx`` 同一个理由渲染整页：扇出不体现在渲
 * 染结果里，它体现在"页面组合层碰巧调了哪些 hook"上，hook 单测防不住组合层把错误
 * 的调用方式重新接回去。
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
    useParams: () => ({ project: "demo" }),
    useSearch: () => ({}),
  }),
  Link: ({ children, ...rest }: { children: ReactNode }) => (
    <a {...(rest as object)}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
  useParams: () => ({ project: "demo" }),
  useRouterState: ({ select }: { select?: (s: unknown) => unknown } = {}) => {
    const state = { location: { pathname: "/projects/demo/characters" } };
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

import { CharactersPage } from "@/routes/_app/projects.$project/characters.lazy";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en", resources: {} });
  // jsdom 没有 matchMedia，``useMediaQuery`` 会一路退回 false，页面渲染成移动端那
  // 套折叠 Select——角色名藏在没展开的下拉里，断言的前置检查就无从落地。这里让它
  // 报桌面宽度，跑的是真正列出全部角色的那条分支。
  // jsdom 不实现这两个：角色列表选中后会滚到可视区，缺了会直接把组件抛掉。
  Element.prototype.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
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

const CHARACTERS = [
  { name: "苏清晏", is_main: true, identity_ids: ["苏清晏_少女", "苏清晏_嫡女"] },
  { name: "沈砚", is_main: false, identity_ids: ["沈砚_少年"] },
  { name: "柳明微", is_main: false, identity_ids: [] },
];

function recordRequests(): string[] {
  const seen: string[] = [];
  server.use(
    http.get("http://localhost:3000/api/v1/*", ({ request }) => {
      seen.push(new URL(request.url).pathname);
      return HttpResponse.json({ ok: true, data: [] });
    }),
  );
  // 分两次 use：``server.use`` 是 unshift，后注册的排在前面。角色列表得压过上面
  // 那条 catch-all，否则整页拿到空数组，什么身份请求都不会发，断言空过。
  server.use(
    http.get("http://localhost:3000/api/v1/projects/demo/characters", ({ request }) => {
      // 专用 handler 不走 catch-all，得自己记一笔，否则这条请求不进 ``seen``。
      seen.push(new URL(request.url).pathname);
      return HttpResponse.json({ ok: true, data: CHARACTERS });
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

describe("the characters tab does not fan identities out per character", () => {
  it("lists every character but only asks for the selected one's identities", async () => {
    const seen = recordRequests();

    renderWithProviders(<CharactersPage />);

    // 先确认三个角色真的渲染出来了——否则页面崩在半路，下面的请求断言会因为
    // 什么都没发而空过。
    // 先确认三个角色真的都渲染出来了——否则页面崩在半路，下面的请求断言会因为
    // 什么都没发而空过。首个角色同时出现在侧栏和右侧详情里，所以用 All。
    expect((await screen.findAllByText("苏清晏")).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText("柳明微")).toBeInTheDocument());
    expect(screen.getByText("沈砚")).toBeInTheDocument();

    // 路径里的中文是百分号编码过的，解出来比对，断言里才看得出是哪个角色。
    const identityRequests = seen
      .map((path) => decodeURIComponent(path))
      .filter((path) => path.endsWith("/identities"));
    // 三个角色，一条身份请求：归属关系由 ``useIdentityOwnerIndex`` 从角色列表自带的
    // ``identity_ids`` 算出，不额外发请求；详情只给自动选中的首个角色拉。
    // 这里列出具体路径而不是数个数——回归的形状就是"每个角色一条"，列出来才看得
    // 出漏的是哪几个。
    expect(identityRequests).toEqual(["/api/v1/projects/demo/characters/苏清晏/identities"]);
    // 侧栏的用量统计走 ``/assets/references`` 那一个聚合，不再按集翻 beats。
    expect(seen.filter((path) => path.includes("/beats"))).toEqual([]);
  });
});
