// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createLazyFileRoute, useRouterState } from "@tanstack/react-router";
import { ReactFlowProvider } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SupertaleProjectSummary } from "@/api/projects";
import { GlobalErrorDialog } from "@/components/GlobalErrorDialog";
import {
  subscribeOpenGlobalErrorDialog,
  type GlobalErrorDialogDetail,
} from "@/features/app/errorDialogEvents";
import { FreezoneShell } from "@/features/freezone/FreezoneShell";
import {
  canvasIdForFreezoneEntry,
  personalCanvasIdForUsername,
} from "@/features/freezone/projections";
import { useAllProjectSummaries } from "@/lib/queries/projects";
import { useFreezoneCanvases } from "@/lib/queries/freezone";
import { readLastCanvas, writeUrl } from "@/lib/url-params";
import { useAuthStore } from "@/stores/auth-store";

function FreezoneProjectRoute() {
  const { t } = useTranslation();
  const { project } = Route.useParams();
  const username = useAuthStore((state) => state.username);
  const { data: projects, isLoading } = useAllProjectSummaries();
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

  // 没有 ?canvas= 时要按「本项目实际有哪些画布」挑落点，而不是闭着眼用个人画布
  // id（它只由用户名推出、跨项目相同，在没建过的项目里指向不存在的画布）。
  // 查询键与 CanvasesTab 共用，react-query 会去重。
  const needsCanvasList = Boolean(matchedProject);
  const { data: projectCanvases, isLoading: canvasesLoading } = useFreezoneCanvases(
    matchedProject?.id,
    needsCanvasList,
  );

  if (isLoading || !projects) {
    return (
      <div className="-m-6 flex h-[calc(100%+3rem)] items-center justify-center bg-bg-dark text-text-muted">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-accent border-t-transparent" />
      </div>
    );
  }

  if (!matchedProject) {
    return (
      <div className="-m-6 flex h-[calc(100%+3rem)] items-center justify-center bg-bg-dark">
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

  // 列表还在路上就先等：先用错的 id 挂载、拿到列表再换，会让画布白挂载一次
  // （整套 hydrate + 节点重挂）。深链同样要等——不先知道这张画布在不在本项目，
  // 就只能把「不存在」渲染成一张白板，那正是要修掉的问题。
  if (needsCanvasList && canvasesLoading) {
    return (
      <div className="-m-6 flex h-[calc(100%+3rem)] items-center justify-center bg-bg-dark text-text-muted">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-accent border-t-transparent" />
      </div>
    );
  }

  // 「上次打开的画布」要和本项目的画布列表核对：跨项目残留 / 已删除的 id 不能再
  // 生效，否则一次错误落点会被 FreezoneShell 记回 localStorage，从此每次都错。
  const remembered = readLastCanvas(matchedProject.id);
  const rememberedExists =
    remembered != null &&
    (projectCanvases == null || projectCanvases.some((canvas) => canvas.id === remembered));

  const canvasId = canvasIdForFreezoneEntry({
    explicitCanvasId: canvasParam ?? (rememberedExists ? remembered : null),
    username,
    availableCanvases: projectCanvases,
  });

  // 深链指向本项目没有的画布：直说，别渲染一张会让人以为数据丢了的白板。
  // 个人画布例外——它是按需创建的，首次打开时本来就还没落盘。
  const personalCanvasId = personalCanvasIdForUsername(username?.trim() || "user");
  const canvasMissing =
    Boolean(canvasParam) &&
    canvasId !== personalCanvasId &&
    canvasId !== "default" &&
    projectCanvases != null &&
    !projectCanvases.some((canvas) => canvas.id === canvasId);

  if (canvasMissing) {
    return (
      <div className="-m-6 flex h-[calc(100%+3rem)] items-center justify-center bg-bg-dark">
        <div className="max-w-md rounded-2xl border border-border-default bg-surface px-6 py-8 text-center">
          <div className="mb-2 text-base font-medium text-text">{t("canvas.notFound")}</div>
          <div className="mb-6 text-sm text-text-muted">
            {t("canvas.notFoundDescriptionPrefix")}{" "}
            <code className="rounded bg-bg-dark px-1 py-0.5">{canvasId}</code>
            {t("canvas.notFoundDescriptionSuffix")}
          </div>
          <button
            type="button"
            onClick={() => writeUrl({ canvas: null }, { replace: true })}
            className="rounded-lg bg-accent/90 px-4 py-2 text-sm text-white transition hover:bg-accent"
          >
            {t("canvas.backToProjectCanvas")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <div className="-m-6 h-[calc(100%+3rem)] w-[calc(100%+3rem)] bg-bg-dark">
        <FreezoneShell project={matchedProject} canvasId={canvasId} />
        <GlobalErrorDialog
          isOpen={Boolean(globalError)}
          title={globalError?.title ?? ""}
          message={globalError?.message ?? ""}
          details={globalError?.details}
          copyText={globalError?.copyText}
          variant={globalError?.variant}
          onClose={() => setGlobalError(null)}
        />
      </div>
    </ReactFlowProvider>
  );
}

export const Route = createLazyFileRoute("/_app/projects/$project/freezone")({
  component: FreezoneProjectRoute,
});
