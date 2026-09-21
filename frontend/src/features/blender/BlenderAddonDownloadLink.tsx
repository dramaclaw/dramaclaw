// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Download } from "lucide-react";
import { useTranslation } from "react-i18next";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * 插件 zip 的下载地址。
 *
 * 固定走后端 `GET /blender/addon`，不直接链 OSS：后端从 OSS（开发机上是本地
 * `blender/dist/`）取原包，把当前环境的服务地址写进包里，用户装完不用手填。相对路径
 * 即可：生产由 nginx 把 `/api/` 反代到后端，开发由 vite 的 `/api/v1` 代理转发，两条路
 * `st_session` cookie 都随导航请求带上。
 *
 * 取包失败时后端返回 502，浏览器只给一次失败下载，不做错误态。
 */
export const BLENDER_ADDON_DOWNLOAD_URL = "/api/v1/blender/addon";

export function BlenderAddonDownloadLink({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <a
      href={BLENDER_ADDON_DOWNLOAD_URL}
      download
      className={cn(
        buttonVariants({ variant: "outline" }),
        "h-9 rounded-full bg-transparent px-4 text-xs text-muted-foreground shadow-none dark:bg-transparent",
        className,
      )}
    >
      <Download className="size-3.5" aria-hidden="true" />
      {t("project.blenderAddon")}
    </a>
  );
}
