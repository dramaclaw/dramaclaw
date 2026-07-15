// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { StrictMode } from "react";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { routeTree } from "./routeTree.gen";
import { ThemeProvider } from "./components/theme-provider";
import { loadClusterConfig } from "@/lib/cluster-config";
import { loadRuntimeConfig } from "@/lib/runtime-config";
import { initDevBackendWatch } from "@/lib/dev-backend-watch";
import { setApiQueryClient } from "@/lib/api";
import { setAppRouter } from "@/lib/app-router";
import { getOrCreateReactRoot } from "@/lib/react-root";
import {
  installChunkLoadRecovery,
  useChunkLoadRecoveryRequired,
} from "@/lib/chunk-load-recovery";
import { installVersionUpdateWatch } from "@/lib/version-update-watch";
import { installDomReconciliationGuard } from "@/lib/dom-reconciliation-guard";
import { AppUpdateRequired } from "@/components/app-update-required";
import { AppUpdateAvailable } from "@/components/app-update-available";
import { config as zodConfig } from "zod/v4/core";
import "@fontsource-variable/inter";
import "dramaclaw-spec-render/style.css";
import "./i18n";
import "./index.css";

// Our CSP has no 'unsafe-eval', so zod's JIT probe (`new Function("")`)
// throws and gets reported as a securitypolicyviolation in DevTools even
// though zod swallows it. jitless skips the probe; zod always uses the
// non-JIT parser under this CSP anyway, so behavior is unchanged.
zodConfig({ jitless: true });

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      // 30s staleTime stops every remount / navigation from refetching;
      // hooks that need freshness (tasks, SSE-driven stages) either set
      // their own refetchInterval or invalidate explicitly on completion.
      staleTime: 30_000,
    },
  },
});

const router = createRouter({
  routeTree,
  // Prefetch route chunks on link hover/focus so navigation is instant
  // once the user commits.
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
  // No defaultViewTransition. A global view-transition on every navigation
  // fires for search-param updates too (e.g. ?beat=3), which means every
  // beat click in the workbench triggers a full-document snapshot +
  // crossfade — a visible full-screen flicker for a change that only
  // touches the right-hand action panel. Pro tools (Linear, Figma, Notion)
  // do instant nav; match them. If we ever want a transition on a specific
  // <Link>, opt in per-link with viewTransition={true}.
});

// Register the singleton so plain (non-hook) modules — url-params,
// openPresetProjection — route navigations through the router instead of
// mutating window.history directly (which races with tanstack's throttled
// history queue). See @/lib/app-router.
setAppRouter(router);

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// Give the api module a handle to the QueryClient so its 400 no_region
// handler can fan out a full cache purge via resetRegionState().
setApiQueryClient(queryClient);
installChunkLoadRecovery();
// 抵御浏览器/webview 翻译插件改写 DOM 导致的 React removeChild 崩溃(整页「页面加载失败」)。
// 必须在任何 React 渲染前打上补丁。见 dom-reconciliation-guard.ts。
installDomReconciliationGuard();

function AppRouterShell() {
  const updateRequired = useChunkLoadRecoveryRequired();
  return (
    <>
      <RouterProvider router={router} />
      {updateRequired ? <AppUpdateRequired /> : <AppUpdateAvailable />}
    </>
  );
}

async function bootstrap() {
  await Promise.all([loadClusterConfig(), loadRuntimeConfig()]);
  initDevBackendWatch();
  installVersionUpdateWatch();
  const root = getOrCreateReactRoot(document.getElementById("root")!);
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <AppRouterShell />
        </ThemeProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void bootstrap();
