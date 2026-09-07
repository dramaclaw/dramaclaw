// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * 给一个只有图标的控件挂一条悬停文字提示。
 *
 * 预演台的视口四周全是纯图标按钮：不给提示的话，「那个方块加个标签的图标」到底是什么
 * 功能只能靠点一下试出来——而这里好些按钮点下去就改场景或改取景。提示走设计系统的
 * Tooltip 而不是原生 `title`：原生的要等浏览器那一秒延迟才弹，位置由浏览器定（贴着
 * 边角的控件常被弹到画面外或压住旁边那颗），也没法跟着控件簇统一方向。
 *
 * 触发器是外面这层 <span> 而不是控件本身：控件 `disabled` 时浏览器不再往它派发 hover
 * 事件，而「为什么这颗是灰的」恰恰只写在提示里。
 *
 * 上层要有一个 `TooltipProvider`：少了它每颗按钮各算各的延迟，鼠标从一颗扫到相邻那颗
 * 还要再等一次。
 */
export function PrevizHoverTip({
  label,
  side = "top",
  children,
}: {
  label: string;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  );
}
