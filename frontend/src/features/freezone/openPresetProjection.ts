// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  buildProjectionFromPreset,
  type FreezonePresetCanvasRequest,
} from "@/api/canvas";
import { useAuthStore } from "@/stores/auth-store";
import { getAppRouter } from "@/lib/app-router";
import { writeUrl } from "@/lib/url-params";
import {
  consumeQueuedLocalFreezoneProjections,
  queueLocalFreezoneProjection,
} from "@/features/freezone/canvasSyncRuntime";
import {
  normalizePresetProjectionRequest,
  personalCanvasIdForUsername,
  projectionMetadataWithRequest,
  projectionKeyForPresetRequest,
} from "@/features/freezone/projections";
import type { CanvasEdge, CanvasNode } from "@/stores/canvasStore";

export async function openPresetProjectionInMyCanvas(
  projectId: string,
  request: Omit<FreezonePresetCanvasRequest, "canvas_id" | "overwrite_existing" | "base_revision">,
): Promise<string> {
  // Read the pathname from the router when available: tanstack throttles its
  // navigations onto a microtask, so window.location lags a pending navigation
  // (e.g. the user clicking away to /ingest while this request is in-flight).
  // Reading window.location here would miss that and wrongly pull the SPA back
  // to Freezone below.
  const router = getAppRouter();
  const startPathname =
    router?.state.location.pathname ??
    (typeof window !== "undefined" ? window.location.pathname : null);
  const username = useAuthStore.getState().username?.trim();
  if (!username) {
    throw new Error("Missing current user");
  }
  const canvasId = personalCanvasIdForUsername(username);
  const normalizedRequest = normalizePresetProjectionRequest(request);
  const projectionKey = projectionKeyForPresetRequest(normalizedRequest);

  const projection = await buildProjectionFromPreset(projectId, {
    ...normalizedRequest,
    projection_key: projectionKey,
    base_revision: 0,
  });
  queueLocalFreezoneProjection(projectId, canvasId, {
    projectionKey,
    nodes: (projection.nodes ?? []) as CanvasNode[],
    edges: (projection.edges ?? []) as CanvasEdge[],
    metadata: projectionMetadataWithRequest(
      projection.metadata ?? null,
      projectionKey,
      normalizedRequest,
      projection.facts_signature,
    ),
  });
  consumeQueuedLocalFreezoneProjections(projectId, canvasId);

  const freezonePath = `/projects/${encodeURIComponent(projectId)}/freezone`;
  // Same source as startPathname: use the router's location so an in-flight
  // navigation (queued but not yet flushed to window.location) is respected.
  const currentPathname =
    router?.state.location.pathname ??
    (typeof window !== "undefined" ? window.location.pathname : null);
  if (currentPathname !== startPathname) {
    // The user navigated elsewhere while the projection request was in-flight.
    // Do not pull the SPA back to Freezone after their explicit navigation.
    return canvasId;
  }
  if (currentPathname !== freezonePath) {
    if (router) {
      router.navigate({
        to: "/projects/$project/freezone",
        params: { project: projectId },
        search: { canvas: canvasId },
        resetScroll: false,
      });
    } else if (typeof window !== "undefined") {
      window.history.pushState(
        {},
        "",
        `${freezonePath}?canvas=${encodeURIComponent(canvasId)}`,
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  } else {
    writeUrl({ canvas: canvasId });
  }
  return canvasId;
}
