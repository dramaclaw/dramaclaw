// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { StrictMode } from "react";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { routeTree } from "./routeTree.gen";
import { ThemeProvider } from "./components/theme-provider";
import { loadClusterConfig } from "@/lib/cluster-config";
import { loadRuntimeConfig } from "@/lib/runtime-config";
import { initDevBackendWatch } from "@/lib/dev-backend-watch";
import { setApiQueryClient } from "@/lib/api";
import { getOrCreateReactRoot } from "@/lib/react-root";
import {
  installChunkLoadRecovery,
  useChunkLoadRecoveryRequired,
} from "@/lib/chunk-load-recovery";
import { installVersionUpdateWatch } from "@/lib/version-update-watch";
import { installDomReconciliationGuard } from "@/lib/dom-reconciliation-guard";
import { AppUpdateRequired } from "@/components/app-update-required";
import { AppUpdateAvailable } from "@/components/app-update-available";
import "@fontsource-variable/inter";
import "dramaclaw-spec-render/style.css";
import "./i18n";
import "./index.css";

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

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function ThemedToaster() {
  return (
    <Toaster
      position="top-center"
      theme="dark"
      closeButton={false}
      duration={2200}
      visibleToasts={1}
      offset={24}
      toastOptions={{
        style: {
          "--width": "auto",
          minWidth: 0,
        } as React.CSSProperties,
        className:
          "!py-2 !px-4 !text-sm !min-h-0 !bg-white/[0.06] !border !border-white/10 !rounded-sm !shadow-none !text-white/80",
      }}
    />
  );
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
          <ThemedToaster />
        </ThemeProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void bootstrap();
