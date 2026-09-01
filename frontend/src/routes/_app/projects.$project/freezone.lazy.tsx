// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createLazyFileRoute } from "@tanstack/react-router";

/**
 * 这条路由本身不再渲染画布。画布由 FreezoneCanvasHost 挂在 _app.tsx 的路由动画
 * 容器之外，好让顶栏在「虾画 / 虾集」之间切换时不把它整棵卸载重建；这里只保留
 * 路由本身，作为「当前在虾画」的地址标记 —— 宿主正是靠 pathname 判断显示与激活。
 */
function FreezoneProjectRoute() {
  return null;
}

export const Route = createLazyFileRoute("/_app/projects/$project/freezone")({
  component: FreezoneProjectRoute,
});
