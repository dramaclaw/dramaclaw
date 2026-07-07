// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createLazyFileRoute, useRouterState } from "@tanstack/react-router";
import { ReactFlowProvider } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";

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

function FreezoneProjectRoute() {
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
          <div className="mb-2 text-base font-medium text-text">项目不存在</div>
          <div className="mb-6 text-sm text-text-muted">
            当前账号下找不到项目 <code className="rounded bg-bg-dark px-1 py-0.5">{project}</code>。
          </div>
          <button
            type="button"
            onClick={() => writeUrl({ project: null, canvas: null })}
            className="rounded-lg bg-accent/90 px-4 py-2 text-sm text-white transition hover:bg-accent"
          >
            返回项目
          </button>
        </div>
      </div>
    );
  }

  const canvasId = canvasIdForFreezoneEntry({
    explicitCanvasId: canvasParam ?? readLastCanvas(matchedProject.id),
    username,
  });

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
          onClose={() => setGlobalError(null)}
        />
      </div>
    </ReactFlowProvider>
  );
}

export const Route = createLazyFileRoute("/_app/projects/$project/freezone")({
  component: FreezoneProjectRoute,
});
