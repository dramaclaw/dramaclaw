// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// TCP-EU-B4b — 尽力投递（partial dispatch）在 render 计划对话框里的前端半边。
//
// 这个文件刻意走**真的** `useRenderPlan` / `useRenderExecute` + MSW，而不是像
// `render-plan-dialog.test.tsx` 那样整模块 `vi.mock`：本 EU 的核心判据是**重投
// 请求的形状**（`beat_indices` 恰为被拒条目 beats 的并集、`custom_plan: true`、
// `plan` 逐字、新的 `input_fingerprint`），只有在 HTTP 层断言才算真钉住。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import ky from "ky";
import type { ReactNode } from "react";

// MSW 2 + ky 2 in jsdom: the global Request is replaced by an undici-backed
// implementation that requires an absolute URL, so the production `api` (which
// uses `prefix: "/"` + relative inputs) throws `Failed to parse URL`. Inject a
// test-only ky instance with an absolute `baseUrl` so requests reach MSW.
// （先例：`src/__tests__/lib/queries/render-plan.test.tsx:11-17`）
vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
  handleSessionExpired: vi.fn(),
  setApiQueryClient: vi.fn(),
}));

// react-i18next：把 `defaultValue` 原样吐出来并做变量替换，这样三种 reason 的
// 文案能被断言为「三条真的不一样的话」，而不是三次同一个 key。
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (
      key: string,
      vars?: Record<string, string | number> & { defaultValue?: string },
    ) => {
      const base = typeof vars?.defaultValue === "string" ? vars.defaultValue : key;
      if (!vars) return base;
      return Object.entries(vars).reduce(
        (acc, [k, v]) => (k === "defaultValue" ? acc : acc.replace(`{{${k}}}`, String(v))),
        base,
      );
    },
  }),
}));

const { toast } = vi.hoisted(() => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock("sonner", () => ({ toast }));

import { server } from "@/__mocks__/msw/server";
import { queryKeys } from "@/lib/query-keys";
import { RenderPlanDialog } from "@/components/episode/beat-workbench/render-plan-dialog";
import type { PlanEntry } from "@/types/render-plan";
import type { Task } from "@/types/task";

const PROJECT = "demo";
const EPISODE = 1;

function entry(modeKey: string, beats: number[], location: string): PlanEntry {
  return {
    mode_key: modeKey,
    rows: 1,
    cols: beats.length,
    beat_numbers: beats,
    location,
    padding_count: 0,
    reasons: [],
    warnings: [],
  };
}

const G0 = entry("1x2_a", [1, 2], "街头");
const G1 = entry("1x2_b", [3, 4], "巷口");
const G2 = entry("1x2_c", [5, 6], "天台");
const G3 = entry("1x2_d", [7, 8], "地铁");
const FULL_PLAN = [G0, G1, G2, G3];
const ALL_BEATS = [1, 2, 3, 4, 5, 6, 7, 8];

interface Recorded {
  plan: Record<string, unknown>[];
  execute: Record<string, unknown>[];
}

let recorded: Recorded;
/** 依次消费的 /render/execute 响应。 */
let executeResponses: Array<() => Response>;
let planResponses: Array<() => Response>;

function okPlan(hash: string, fingerprint: string, plan: PlanEntry[]) {
  return HttpResponse.json({
    ok: true,
    data: {
      plan,
      plan_hash: hash,
      input_fingerprint: fingerprint,
      strategy: "location",
      total_beats: plan.reduce((n, e) => n + e.beat_numbers.length, 0),
      total_grids: plan.length,
    },
  });
}

function okExecute(opts: {
  taskIds: string[];
  resolvedGrids: PlanEntry[];
  rejected?: Array<{ scope: string; reason: string; limit: number; active: number }>;
}) {
  const body: Record<string, unknown> = {
    task_type: "render_plan",
    message: "渲染已启动",
    scope: "location__deadbeef0000",
    resolved_grids: opts.resolvedGrids,
    task_ids: opts.taskIds,
  };
  if (opts.rejected !== undefined) body.rejected = opts.rejected;
  return HttpResponse.json({ ok: true, data: body });
}

function task(id: string, status: Task["status"]): Task {
  return {
    task_id: id,
    task_type: "selected_regen",
    username: "u",
    project: PROJECT,
    project_id: PROJECT,
    episode: EPISODE,
    status,
    progress: 0,
  };
}

beforeEach(() => {
  recorded = { plan: [], execute: [] };
  planResponses = [];
  executeResponses = [];
  toast.error.mockClear();
  toast.success.mockClear();
  toast.warning.mockClear();
  server.use(
    http.post("*/render/plan", async ({ request }) => {
      recorded.plan.push((await request.json()) as Record<string, unknown>);
      const next = planResponses.shift();
      return next ? next() : okPlan("h1", "f1", FULL_PLAN);
    }),
    http.post("*/render/execute", async ({ request }) => {
      recorded.execute.push((await request.json()) as Record<string, unknown>);
      const next = executeResponses.shift();
      return next
        ? next()
        : okExecute({ taskIds: ["t0", "t1", "t2", "t3"], resolvedGrids: FULL_PLAN });
    }),
    http.get("*/render-settings", () =>
      HttpResponse.json({
        ok: true,
        data: { render_image_selection: "", options: {}, sketch_aspect_padding: false },
      }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const onDispatched = vi.fn();
  const onOpenChange = vi.fn();
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  }
  render(
    <RenderPlanDialog
      open
      onOpenChange={onOpenChange}
      project={PROJECT}
      episode={EPISODE}
      beatIndices={ALL_BEATS}
      aspectMode="9:16"
      onDispatched={onDispatched}
    />,
    { wrapper: Wrapper },
  );
  return { qc, onDispatched, onOpenChange };
}

async function confirm() {
  const btn = await screen.findByRole("button", { name: /episode\.renderPlan\.confirm/ });
  await userEvent.click(btn);
}

/**
 * 模拟「页面上既有的 `useTasks` 轮询把新一轮任务状态写进缓存」。对话框是这份
 * 缓存的**只读订阅者**（`queryFn: skipToken`），所以直接 `setQueryData` 就是
 * 生产里发生的事，且比等 2s 轮询确定得多。
 */
async function pushTasks(qc: QueryClient, rows: Task[]) {
  await act(async () => {
    qc.setQueryData(queryKeys.tasks(PROJECT), { ok: true, data: rows });
  });
}

describe("render plan dialog — 尽力投递 / 只重投被拒的那部分", () => {
  it("`rejected` 缺席时行为与今天逐字一致（全投、关窗、无横幅）", async () => {
    executeResponses = [
      () => okExecute({ taskIds: ["t0", "t1", "t2", "t3"], resolvedGrids: FULL_PLAN }),
    ];
    const { onDispatched, onOpenChange } = renderDialog();
    await confirm();

    await waitFor(() => expect(onDispatched).toHaveBeenCalledWith(["t0", "t1", "t2", "t3"]));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText(/已投/)).toBeNull();
    expect(recorded.execute).toHaveLength(1);
  });

  it("`rejected: []` 与缺席同形（不许把空数组当部分投递）", async () => {
    executeResponses = [
      () =>
        okExecute({
          taskIds: ["t0", "t1", "t2", "t3"],
          resolvedGrids: FULL_PLAN,
          rejected: [],
        }),
    ];
    const { onDispatched, onOpenChange } = renderDialog();
    await confirm();

    await waitFor(() => expect(onDispatched).toHaveBeenCalledWith(["t0", "t1", "t2", "t3"]));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText(/已投/)).toBeNull();
    expect(recorded.execute).toHaveLength(1);
  });

  it("部分投递时给出「已投 2 / 被拒 2」并且不关窗", async () => {
    executeResponses = [
      () =>
        okExecute({
          taskIds: ["t0", "t1"],
          resolvedGrids: FULL_PLAN,
          rejected: [
            { scope: "s2", reason: "channel", limit: 12, active: 12 },
            { scope: "s3", reason: "channel", limit: 12, active: 12 },
          ],
        }),
    ];
    const { onDispatched, onOpenChange } = renderDialog();
    await confirm();

    expect(await screen.findByText(/已投 2 \/ 被拒 2/)).toBeTruthy();
    expect(onDispatched).toHaveBeenCalledWith(["t0", "t1"]);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("在途下降后自动重投一轮：/render/plan 的 beat_indices 恰为被拒并集，/render/execute 带 custom_plan 与逐字 plan", async () => {
    executeResponses = [
      () =>
        okExecute({
          taskIds: ["t0", "t1"],
          resolvedGrids: FULL_PLAN,
          rejected: [
            { scope: "s2", reason: "channel", limit: 12, active: 12 },
            { scope: "s3", reason: "channel", limit: 12, active: 12 },
          ],
        }),
      () => okExecute({ taskIds: ["t4", "t5"], resolvedGrids: [G2, G3], rejected: [] }),
    ];
    planResponses = [
      () => okPlan("h1", "f1", FULL_PLAN),
      () => okPlan("h2", "f2", [G2, G3]),
    ];
    const { qc, onDispatched } = renderDialog();
    await confirm();
    await screen.findByText(/已投 2 \/ 被拒 2/);

    await pushTasks(qc, [task("t0", "running"), task("t1", "running")]);
    expect(recorded.execute).toHaveLength(1);

    await pushTasks(qc, [task("t0", "completed"), task("t1", "completed")]);

    await waitFor(() => expect(recorded.execute).toHaveLength(2));
    expect(recorded.plan).toHaveLength(2);
    expect(recorded.plan[1].beat_indices).toEqual([5, 6, 7, 8]);
    const exec2 = recorded.execute[1];
    expect(exec2.custom_plan).toBe(true);
    expect(exec2.plan).toEqual([G2, G3]);
    expect(exec2.beat_indices).toEqual([5, 6, 7, 8]);
    expect(exec2.input_fingerprint).toBe("f2");
    expect(onDispatched).toHaveBeenCalledWith(["t4", "t5"]);
  });

  it("绝不整批重放：重投里不含任何已成功条目的 beat", async () => {
    executeResponses = [
      () =>
        okExecute({
          taskIds: ["t0", "t1"],
          resolvedGrids: FULL_PLAN,
          rejected: [
            { scope: "s2", reason: "platform", limit: 50, active: 50 },
            { scope: "s3", reason: "platform", limit: 50, active: 50 },
          ],
        }),
      () => okExecute({ taskIds: ["t4", "t5"], resolvedGrids: [G2, G3] }),
    ];
    planResponses = [
      () => okPlan("h1", "f1", FULL_PLAN),
      () => okPlan("h2", "f2", [G2, G3]),
    ];
    const { qc } = renderDialog();
    await confirm();
    await screen.findByText(/已投 2 \/ 被拒 2/);
    await pushTasks(qc, [task("t0", "completed"), task("t1", "completed")]);
    await waitFor(() => expect(recorded.execute).toHaveLength(2));

    const exec2 = recorded.execute[1];
    const beats = exec2.beat_indices as number[];
    for (const succeeded of [...G0.beat_numbers, ...G1.beat_numbers]) {
      expect(beats).not.toContain(succeeded);
    }
    expect((exec2.plan as PlanEntry[]).length).toBe(2);
  });

  it("第二次仍被拒 → 没有第三次自动重投，改成「继续」按钮", async () => {
    const rejectedTwo = [
      { scope: "s2", reason: "channel", limit: 12, active: 12 },
      { scope: "s3", reason: "channel", limit: 12, active: 12 },
    ];
    executeResponses = [
      () => okExecute({ taskIds: ["t0", "t1"], resolvedGrids: FULL_PLAN, rejected: rejectedTwo }),
      () =>
        okExecute({
          taskIds: [],
          resolvedGrids: [G2, G3],
          rejected: rejectedTwo,
        }),
    ];
    planResponses = [
      () => okPlan("h1", "f1", FULL_PLAN),
      () => okPlan("h2", "f2", [G2, G3]),
    ];
    const { qc } = renderDialog();
    await confirm();
    await screen.findByText(/已投 2 \/ 被拒 2/);
    await pushTasks(qc, [task("t0", "completed"), task("t1", "completed")]);
    await waitFor(() => expect(recorded.execute).toHaveLength(2));

    expect(await screen.findByRole("button", { name: "继续" })).toBeTruthy();

    // 再喂一轮「在途下降」，不许出现第三次自动重投。
    await pushTasks(qc, [task("t0", "completed"), task("t1", "completed")]);
    await new Promise((r) => setTimeout(r, 50));
    expect(recorded.execute).toHaveLength(2);
  });

  it("点「继续」发出的是同样的两条请求形状", async () => {
    const rejectedTwo = [
      { scope: "s2", reason: "user", limit: 32, active: 32 },
      { scope: "s3", reason: "user", limit: 32, active: 32 },
    ];
    executeResponses = [
      () => okExecute({ taskIds: ["t0", "t1"], resolvedGrids: FULL_PLAN, rejected: rejectedTwo }),
      () => okExecute({ taskIds: [], resolvedGrids: [G2, G3], rejected: rejectedTwo }),
      () => okExecute({ taskIds: ["t6", "t7"], resolvedGrids: [G2, G3], rejected: [] }),
    ];
    planResponses = [
      () => okPlan("h1", "f1", FULL_PLAN),
      () => okPlan("h2", "f2", [G2, G3]),
      () => okPlan("h3", "f3", [G2, G3]),
    ];
    const { qc } = renderDialog();
    await confirm();
    await screen.findByText(/已投 2 \/ 被拒 2/);
    await pushTasks(qc, [task("t0", "completed"), task("t1", "completed")]);
    await waitFor(() => expect(recorded.execute).toHaveLength(2));

    await userEvent.click(await screen.findByRole("button", { name: "继续" }));
    await waitFor(() => expect(recorded.execute).toHaveLength(3));

    expect(recorded.plan[2].beat_indices).toEqual([5, 6, 7, 8]);
    const exec3 = recorded.execute[2];
    expect(exec3.custom_plan).toBe(true);
    expect(exec3.plan).toEqual([G2, G3]);
    expect(exec3.beat_indices).toEqual([5, 6, 7, 8]);
    expect(exec3.input_fingerprint).toBe("f3");
  });

  it("三种 reason 给三条不同文案，而不是一条通用报错", async () => {
    const texts: string[] = [];
    for (const reason of ["channel", "platform", "user"]) {
      recorded = { plan: [], execute: [] };
      executeResponses = [
        () =>
          okExecute({
            taskIds: ["t0", "t1"],
            resolvedGrids: FULL_PLAN,
            rejected: [
              { scope: "s2", reason, limit: 12, active: 12 },
              { scope: "s3", reason, limit: 12, active: 12 },
            ],
          }),
      ];
      renderDialog();
      await confirm();
      const banner = await screen.findByRole("status");
      texts.push(banner.textContent ?? "");
      cleanup();
    }
    expect(new Set(texts).size).toBe(3);
    expect(texts[0]).toMatch(/渠道/);
    expect(texts[1]).toMatch(/平台/);
    expect(texts[2]).toMatch(/你的/);
  });

  it("429（一个都没投出去）仍走既有 429 路径，不当部分投递", async () => {
    executeResponses = [
      () =>
        HttpResponse.json(
          {
            ok: false,
            error: "channel_task_limit_exceeded",
            data: { limit_scope: "channel", queue_kind: "default", limit: 12, active: 12 },
          },
          { status: 429 },
        ),
    ];
    const { onDispatched } = renderDialog();
    await confirm();

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(onDispatched).not.toHaveBeenCalled();
    expect(screen.queryByText(/已投/)).toBeNull();
    expect(screen.queryByRole("button", { name: "继续" })).toBeNull();
  });
});
