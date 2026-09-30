// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useRouterState } from "@tanstack/react-router";
import { ReactFlowProvider } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SupertaleProjectSummary } from "@/api/projects";
import { GlobalErrorDialog } from "@/components/GlobalErrorDialog";
import {
  subscribeOpenGlobalErrorDialog,
  type GlobalErrorDialogDetail,
} from "@/features/app/errorDialogEvents";
import { FreezoneShell } from "@/features/freezone/FreezoneShell";
import { canvasIdForFreezoneEntry } from "@/features/freezone/projections";
import { useAllProjectSummaries } from "@/lib/queries/projects";
import { readLastCanvas, writeUrl } from "@/lib/url-params";
import { useAuthStore } from "@/stores/auth-store";

type FreezoneCanvasRootProps = {
  /** `/projects/$project` 路由参数。经 canonicalProjectRouteParam 保证是项目 id。 */
  project: string;
  /** 画布是否是当前正在看的页面；false 表示被 FreezoneCanvasHost 保活在后台。 */
  active: boolean;
};

/**
 * 虾画路由的实际内容。从 routes/_app/projects.$project/freezone.lazy.tsx 搬出来，
 * 是因为它现在的宿主不是那条路由，而是 FreezoneCanvasHost —— 只有挂在路由之外，
 * 才能在切到虾集时不被卸载。
 */
export default function FreezoneCanvasRoot({
  project,
  active,
}: FreezoneCanvasRootProps) {
  const { t } = useTranslation();
  const username = useAuthStore((state) => state.username);
  const { data: projects, isLoading: projectsLoading } = useAllProjectSummaries();
  const [globalError, setGlobalError] = useState<GlobalErrorDialogDetail | null>(null);

  // Read `?canvas` from the router's location so it stays consistent with an
  // in-flight navigation (tanstack throttles history onto a microtask, so
  // window.location — and any raw readUrl() — lags a queued canvas switch).
  // This subscription also re-renders the route when the canvas param changes,
  // replacing the old raw popstate listener.
  const canvasParam = useRouterState({
    select: (s) => {
      const canvas = (s.location.search as { canvas?: unknown }).canvas;
      return typeof canvas === "string" && canvas.length > 0 ? canvas : null;
    },
  });

  useEffect(() => subscribeOpenGlobalErrorDialog(setGlobalError), []);

  const freezoneProjects = useMemo<SupertaleProjectSummary[]>(
    () =>
      (projects ?? []).map((item) => ({
        id: item.id,
        name: item.name,
        display_name: item.name,
        updated_at: item.updatedAt,
        episode_count: item.episodeCount,
      })),
    [projects],
  );
  const matchedProject = useMemo(
    () =>
      freezoneProjects.find((item) => item.id === project) ??
      freezoneProjects.find((item) => item.name === project) ??
      null,
    [freezoneProjects, project],
  );

  // 保活期间地址栏是虾集的，`?canvas=` 已经没了。照常算的话 canvasId 会掉回
  // 默认值，FreezoneShell 会当成「切换了画布」重新 hydrate 一遍 —— 正是保活要
  // 省掉的开销，还会把用户当前打开的画布换掉。所以只在激活时更新，其余时候
  // 把上一次的值钉住。
  const liveCanvasId = matchedProject
    ? canvasIdForFreezoneEntry({
        explicitCanvasId: canvasParam ?? readLastCanvas(matchedProject.id),
        username,
      })
    : null;
  const pinnedCanvasIdRef = useRef(liveCanvasId);
  if (active && liveCanvasId) {
    pinnedCanvasIdRef.current = liveCanvasId;
  }
  const canvasId = active ? liveCanvasId : pinnedCanvasIdRef.current;

  // 项目列表还没到手就先转圈。少了这一支，请求失败（projects 是 undefined 但
  // 已经不在 pending）会直接掉进下面的「项目未找到」，把一次网络错误说成这个
  // 项目不存在。
  if (projectsLoading || !projects) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-dark text-text-muted">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-accent border-t-transparent" />
      </div>
    );
  }

  if (!matchedProject || !canvasId) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-dark">
        <div className="max-w-md rounded-2xl border border-border-default bg-surface px-6 py-8 text-center">
          <div className="mb-2 text-base font-medium text-text">{t("project.notFound")}</div>
          <div className="mb-6 text-sm text-text-muted">
            {t("project.notFoundDescriptionPrefix")} <code className="rounded bg-bg-dark px-1 py-0.5">{project}</code>{t("project.notFoundDescriptionSuffix")}
          </div>
          <button
            type="button"
            onClick={() => writeUrl({ project: null, canvas: null })}
            className="rounded-lg bg-accent/90 px-4 py-2 text-sm text-white transition hover:bg-accent"
          >
            {t("project.backToProjects")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <div className="h-full w-full bg-bg-dark">
        <FreezoneShell project={matchedProject} canvasId={canvasId} active={active} />
        <GlobalErrorDialog
          isOpen={Boolean(globalError)}
          title={globalError?.title ?? ""}
          message={globalError?.message ?? ""}
          details={globalError?.details}
          copyText={globalError?.copyText}
          onClose={() => setGlobalError(null)}
        />
      </div>
    </ReactFlowProvider>
  );
}
