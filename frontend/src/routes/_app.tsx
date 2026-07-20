// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  createFileRoute,
  Outlet,
  redirect,
  useNavigate,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Header } from "@/components/layout/header";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { useAppStore } from "@/stores/app-store";
import { useAuthStore } from "@/stores/auth-store";
import { ensureAuthenticatedForAppRoute } from "@/lib/auth-mode";
import { useAllProjectSummaries } from "@/lib/queries/projects";
import { canonicalProjectRouteParam } from "@/lib/project-route";
import { useRegionStore } from "@/stores/region-store";
import { clusterConfig } from "@/lib/cluster-config";
import { getRegionCookie } from "@/lib/region-cookie";
import { authRequired } from "@/lib/runtime-config";
import { initRegionTabSync } from "@/lib/region-tab-sync";
import { initObservability } from "@/lib/observability";
import { TaskCenterProvider } from "@/task-center/provider";
import { TaskStatusBar } from "@/components/task-center/status-bar";
import { TaskPanel } from "@/components/task-center/panel";
import { MyBuddyCompanion } from "@/features/companion/MyBuddyCompanion";
import { AccessoryUnlockPrompt } from "@/features/rewards/AccessoryUnlockPrompt";
import { VersionUpdateDialog } from "@/features/version-update/VersionUpdateDialog";
import { PikoInspirationStation } from "@/features/piko-mini-game/PikoInspirationStation";

export function shouldRedirectMissingUsernameToLogin(): boolean {
  return authRequired();
}

function AppLayout() {
  const navigate = useNavigate();
  // `username` stands in for the old `apiKey` gate — the SPA is cookie-backed,
  // JS can no longer read the credential, so the login marker is username.
  const username = useAuthStore((s) => s.username);
  const validateSession = useAuthStore((s) => s.validateSession);
  const refreshAvatar = useAuthStore((s) => s.refreshAvatar);
  const [validated, setValidated] = useState(false);
  const [pikoStationOpen, setPikoStationOpen] = useState(false);
  const validatedUsernameRef = useRef<string | null>(null);
  const params = useParams({ strict: false }) as { project?: string };
  const routeProject = params.project ?? null;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const projectSummaries = useAllProjectSummaries();
  const canonicalProject = routeProject
    ? canonicalProjectRouteParam(routeProject, projectSummaries.data)
    : null;
  const reducedMotion = useReducedMotion();
  const routeTransitionKey = (() => {
    const match = pathname.match(/^\/projects\/([^/]+)(?:\/([^/]+))?/);
    if (!match) return pathname;
    return `/projects/${match[1]}/${match[2] ?? ""}`;
  })();
  const isAssistantPage = /^\/projects\/[^/]+\/assistant$/.test(pathname);

  // Keep viewport-relative panel sizes (AI assistant width, task panel height)
  // within the current window. Runs once on mount to fix persisted values that
  // were sized on a larger screen, then re-clamps on every window resize.
  useEffect(() => {
    const clamp = useAppStore.getState().clampDimensionsToViewport;
    clamp();
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(clamp);
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  // Avatar is an EE-only feature served by its own endpoint (not /auth/me), so
  // refresh it independently whenever we're logged in — including after a page
  // reload that rehydrates `username` from localStorage. Deliberately NOT routed
  // through getCurrentUser: its 15s cache would skip the fetch and leave the
  // avatar null. login() also fires this once; the extra GET is negligible.
  useEffect(() => {
    if (username) void refreshAvatar();
  }, [username, refreshAvatar]);

  useEffect(() => {
    useRegionStore.getState().sanitizeAgainstConfig();
    if (clusterConfig.mode === "multi-region") {
      initObservability();
      const teardown = initRegionTabSync();
      return teardown;
    }
  }, []);

  useEffect(() => {
    if (!username) {
      if (shouldRedirectMissingUsernameToLogin()) {
        validatedUsernameRef.current = null;
        setValidated(false);
        navigate({ to: "/login" });
        return;
      }
      let cancelled = false;
      setValidated(false);
      validateSession().then((ok) => {
        if (cancelled) return;
        if (!ok) {
          validatedUsernameRef.current = null;
          navigate({ to: "/login" });
          return;
        }
        validatedUsernameRef.current = useAuthStore.getState().username;
        setValidated(true);
      });
      return () => {
        cancelled = true;
      };
    }
    if (validatedUsernameRef.current === username) {
      setValidated(true);
      return;
    }
    let cancelled = false;
    setValidated(false);
    validateSession().then((ok) => {
      if (cancelled) return;
      if (!ok) {
        validatedUsernameRef.current = null;
        navigate({ to: "/login" });
      } else {
        validatedUsernameRef.current = username;
        setValidated(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [username, navigate, validateSession]);

  useEffect(() => {
    if (routeProject && !projectSummaries.isLoading && canonicalProject === null) {
      navigate({ to: "/", replace: true });
    }
  }, [canonicalProject, navigate, projectSummaries.isLoading, routeProject]);

  if (routeProject && projectSummaries.isLoading) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!username || !validated) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <TaskCenterProvider projectId={canonicalProject}>
      <div className="flex h-dvh flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
            <Header />
            <MyBuddyCompanion />
            <AccessoryUnlockPrompt />
            <VersionUpdateDialog />
            <PikoInspirationStation
              open={pikoStationOpen}
              onClose={() => setPikoStationOpen(false)}
            />
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <main
                id="main-content"
                tabIndex={-1}
                className={
                  isAssistantPage
                    ? "min-w-0 flex-1 overflow-y-auto px-6 pb-0 pt-6 focus:outline-none [scrollbar-gutter:stable]"
                    : "min-w-0 flex-1 overflow-y-auto p-6 focus:outline-none [scrollbar-gutter:stable]"
                }
              >
                <motion.div
                  key={routeTransitionKey}
                  className="h-full min-w-0"
                  initial={false}
                  animate={{ opacity: 1 }}
                  transition={{
                    duration: reducedMotion ? 0 : 0.28,
                    ease: "easeOut",
                  }}
                >
                  <Outlet />
                </motion.div>
              </main>
            </div>
            <TaskPanel />
            <TaskStatusBar onOpenPikoStation={() => setPikoStationOpen(true)} />
          </div>
        </div>
      </div>
    </TaskCenterProvider>
  );
}

export const Route = createFileRoute("/_app")({
  beforeLoad: async () => {
    if (clusterConfig.mode === "multi-region" && !getRegionCookie()) {
      throw redirect({ to: "/login", replace: true });
    }
    if (!(await ensureAuthenticatedForAppRoute())) {
      throw redirect({ to: "/login", replace: true });
    }
  },
  component: AppLayout,
});
