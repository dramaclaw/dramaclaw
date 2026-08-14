// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createFileRoute } from "@tanstack/react-router";
import { DownloadPage } from "@/components/download/DownloadPage";

/**
 * 桌面客户端下载页。与 /login 一样挂在根路由下(不进 _app),
 * 因此不需要登录也能打开 —— 这是一张对外的落地页。
 */
export const Route = createFileRoute("/download")({
  component: DownloadPage,
});
