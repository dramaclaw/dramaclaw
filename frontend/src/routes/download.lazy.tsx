// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createLazyFileRoute } from "@tanstack/react-router";
import { DownloadPage } from "@/components/download/DownloadPage";

/**
 * 桌面客户端下载页。与 /login 一样挂在根路由下(不进 _app),
 * 因此不需要登录也能打开 —— 这是一张对外的落地页。
 *
 * 走 lazy route:这一页(页面 + 手绘预览 SVG + 独立那套 CSS)只有访问 /download
 * 的人用得上,静态 import 会把它整个焊进主 chunk,登录页和项目页的用户白付一份
 * 下载与解析成本。
 */
export const Route = createLazyFileRoute("/download")({
  component: DownloadPage,
});
