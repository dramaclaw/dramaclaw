// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CSSProperties } from "react";
import { useRouterState } from "@tanstack/react-router";
import { Toaster } from "sonner";

import { projectSectionFromPath } from "@/components/layout/project-navigation-routes";
import { APP_HEADER_HEIGHT, PROJECT_SUBMENU_ROW_HEIGHT, PROJECT_SUBMENU_OVERLAY_HEIGHT } from "@/components/layout/layout-metrics";
const TOAST_SAFE_GAP = 12;

export function ThemedToaster() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const projectSection = projectSectionFromPath(pathname);
  const isAppRoute = pathname === "/" || pathname.startsWith("/projects/");
  const hasXiajiSubnav = projectSection !== null && projectSection !== "freezone";
  const subnavHeight = hasXiajiSubnav ? PROJECT_SUBMENU_ROW_HEIGHT
    : projectSection === "freezone" ? PROJECT_SUBMENU_OVERLAY_HEIGHT : 0;
  const topOffset = isAppRoute
    ? APP_HEADER_HEIGHT + subnavHeight + TOAST_SAFE_GAP
    : 24;

  return (
    <Toaster
      position="top-left"
      theme="dark"
      closeButton={false}
      duration={2200}
      visibleToasts={1}
      offset={{ top: topOffset, left: 20, right: 20 }}
      toastOptions={{
        style: {
          "--width": "auto",
          minWidth: 0,
          maxWidth: "min(356px, calc(100vw - 40px))",
        } as CSSProperties,
        className:
          "!min-h-0 !rounded-sm !border !border-white/10 !bg-zinc-900/90 !px-4 !py-2 !text-sm !text-white/90 !shadow-none !backdrop-blur-xl",
        // sonner 在 toast 根节点上标 data-type；属性选择器优先级更高，能压过上面的通用底色。
        classNames: {
          // 多行正文（例如白模落地后的检查意见）按行显示，别挤成一行。
          description: "whitespace-pre-line",
          error:
            "data-[type=error]:!border-red-500/40 data-[type=error]:!bg-red-950/90 data-[type=error]:!text-red-100 [&[data-type=error]_[data-icon]]:!text-red-400",
        },
      }}
    />
  );
}
