// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import ky from "ky";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
  uploadApi: ky.create({ baseUrl: "http://localhost:3000/" }),
}));

import { EpisodeAssetPlanning } from "@/components/episode/episode-asset-planning";

const labels = {
  identities: "身份",
  scenes: "场景",
  props: "道具",
  noIdentities: "身份未规划",
  noScenes: "场景未规划",
  noProps: "道具未规划",
  planIdentities: "规划身份",
  replanIdentities: "重新规划身份",
  defaultIdentity: "默认",
  planScenes: "规划场景",
  replanScenes: "重新规划场景",
  planProps: "规划道具",
  replanProps: "重新规划道具",
  propInGlobal: "已在全局道具库",
  propCheckingGlobal: "正在检查全局道具库",
  promoteProp: "加入全局道具库",
  promotePropTitle: (name: string) => `加入全局道具库: ${name}`,
  promotePropName: "全局道具名",
  promotePropType: "道具类型",
  promoteVisualPrompt: "视觉 Prompt",
  promoteOwner: "所属角色",
  promoteSubmit: "加入全局",
  promoteCancel: "取消",
  propTypeLabel: (value: string) => value,
};

const server = setupServer(
  http.get("http://localhost:3000/api/v1/projects/demo/props", () =>
    HttpResponse.json({ ok: true, data: [] }),
  ),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function renderPlanning(props: Partial<Parameters<typeof EpisodeAssetPlanning>[0]> = {}) {
  return render(
    <EpisodeAssetPlanning
      project="demo"
      sceneMenu={[]}
      propMenu={[]}
      labels={labels}
      onPlanIdentities={vi.fn()}
      onPlanScenes={vi.fn()}
      onPlanProps={vi.fn()}
      {...props}
    />,
    { wrapper },
  );
}

describe("EpisodeAssetPlanning", () => {
  it("shows the scenes panel with items and replan action", async () => {
    const user = userEvent.setup();
    const onPlanScenes = vi.fn();

    renderPlanning({
      selectedCategory: "scenes",
      sceneMenu: [{ scene_id: "宫门" }],
      onPlanScenes,
    });

    expect(screen.getByText("宫门")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新规划场景" }));
    expect(onPlanScenes).toHaveBeenCalledTimes(1);
  });

  it("shows the props panel with items and replan action", async () => {
    const user = userEvent.setup();
    const onPlanProps = vi.fn();
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/props", () =>
        HttpResponse.json({ ok: true, data: [] }),
      ),
    );

    renderPlanning({
      selectedCategory: "props",
      propMenu: [{ prop_id: "玉佩", prop_type: "object" }],
      onPlanProps,
    });

    expect(screen.getByText("玉佩")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新规划道具" }));
    expect(onPlanProps).toHaveBeenCalledTimes(1);
  });

  it("only renders the selected category's panel", () => {
    const { rerender } = renderPlanning({ selectedCategory: "scenes" });
    expect(screen.getByText("场景未规划")).toBeInTheDocument();
    expect(screen.queryByText("道具未规划")).not.toBeInTheDocument();
    expect(screen.queryByText("身份未规划")).not.toBeInTheDocument();

    rerender(
      <EpisodeAssetPlanning
        project="demo"
        selectedCategory="props"
        sceneMenu={[]}
        propMenu={[]}
        labels={labels}
        onPlanIdentities={vi.fn()}
        onPlanScenes={vi.fn()}
        onPlanProps={vi.fn()}
      />,
    );
    expect(screen.getByText("道具未规划")).toBeInTheDocument();
    expect(screen.queryByText("场景未规划")).not.toBeInTheDocument();
  });

  it("disables the plan action while planning", () => {
    renderPlanning({ selectedCategory: "scenes", scenePending: true });
    expect(screen.getByText("场景未规划")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "规划场景" })).toBeDisabled();
  });

  it("shows planned character identities grouped by character with the default marked", async () => {
    const user = userEvent.setup();
    const onPlanIdentities = vi.fn();
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/characters/hero/identities",
        () =>
          HttpResponse.json({
            ok: true,
            data: [
              { identity_id: "hero_young", identity_name: "青年时期" },
              { identity_id: "hero_old", identity_name: "老年时期" },
            ],
          }),
      ),
    );

    renderPlanning({
      characters: [{ name: "hero" } as never],
      selectedIdentityIds: ["hero_young"],
      identityDefaultMap: { hero: "hero_young" },
      onPlanIdentities,
    });

    // Only the selected identity is shown, tagged as default; the unselected one is not.
    expect(await screen.findByText("青年时期")).toBeInTheDocument();
    expect(screen.getByText("默认")).toBeInTheDocument();
    expect(screen.queryByText("老年时期")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重新规划身份" }));
    expect(onPlanIdentities).toHaveBeenCalledTimes(1);
  });

  it("promotes an episode prop into the global prop library like NiceGUI", async () => {
    const user = userEvent.setup();
    let receivedBody: unknown;
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/props", () =>
        HttpResponse.json({
          ok: true,
          data: [{ name: "玉佩", prop_type: "object" }],
        }),
      ),
      http.post("http://localhost:3000/api/v1/projects/demo/props", async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({
          ok: true,
          data: {
            name: "青铜镜",
            prop_type: "artifact",
            visual_prompt: "old bronze mirror with cloud pattern",
            owner: "",
          },
        });
      }),
    );

    renderPlanning({
      selectedCategory: "props",
      propMenu: [
        { prop_id: "玉佩", prop_type: "object" },
        {
          prop_id: "青铜镜",
          prop_type: "artifact",
          visual_prompt: "old bronze mirror with cloud pattern",
          description: "fallback description",
          owner_identity_id: "秦_青年",
        },
      ],
    });

    expect(await screen.findByLabelText("已在全局道具库")).toBeInTheDocument();
    await user.click(
      await screen.findByRole("button", {
        name: "加入全局道具库",
      }),
    );

    expect(screen.getByText("加入全局道具库: 青铜镜")).toBeInTheDocument();
    expect(screen.getAllByText("青铜镜").length).toBeGreaterThan(0);
    expect(screen.getByDisplayValue("old bronze mirror with cloud pattern")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "加入全局" }));

    expect(receivedBody).toEqual({
      name: "青铜镜",
      prop_type: "artifact",
      visual_prompt: "old bronze mirror with cloud pattern",
      owner: "",
    });
  });
});
