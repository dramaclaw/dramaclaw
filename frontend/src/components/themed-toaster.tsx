// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CSSProperties } from "react";
import { useRouterState } from "@tanstack/react-router";
import { Toaster } from "sonner";

import { projectSectionFromPath } from "@/components/layout/project-navigation-routes";

const APP_HEADER_HEIGHT = 48;
const XIAJI_SUBNAV_ROW_HEIGHT = 42;
const TOAST_SAFE_GAP = 12;

export function ThemedToaster() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const projectSection = projectSectionFromPath(pathname);
  const isAppRoute = pathname === "/" || pathname.startsWith("/projects/");
  const hasXiajiSubnav = projectSection !== null && projectSection !== "freezone";
  const topOffset = isAppRoute
    ? APP_HEADER_HEIGHT + (hasXiajiSubnav ? XIAJI_SUBNAV_ROW_HEIGHT : 0) + TOAST_SAFE_GAP
    : 24;

  return (
    <Toaster
      position="top-center"
      theme="dark"
      closeButton={false}
      duration={2200}
      visibleToasts={1}
      offset={topOffset}
      toastOptions={{
        style: {
          "--width": "auto",
          minWidth: 0,
        } as CSSProperties,
        className:
          "!min-h-0 !rounded-sm !border !border-white/10 !bg-white/[0.06] !px-4 !py-2 !text-sm !text-white/80 !shadow-none",
      }}
    />
  );
}
