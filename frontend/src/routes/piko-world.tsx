// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createFileRoute, redirect } from "@tanstack/react-router";

import { ensureAuthenticatedForAppRoute } from "@/lib/auth-mode";
import { clusterConfig } from "@/lib/cluster-config";
import { getRegionCookie } from "@/lib/region-cookie";
import { isCeRuntime } from "@/lib/runtime-config";

export const Route = createFileRoute("/piko-world")({
  beforeLoad: async () => {
    if (isCeRuntime()) {
      throw redirect({ to: "/", replace: true });
    }
    if (clusterConfig.mode === "multi-region" && !getRegionCookie()) {
      throw redirect({ to: "/login", replace: true });
    }
    if (!(await ensureAuthenticatedForAppRoute())) {
      throw redirect({ to: "/login", replace: true });
    }
  },
});
