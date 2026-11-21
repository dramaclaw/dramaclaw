// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { lazy, Suspense, useState, type ComponentProps } from "react";

import type { ThreeDDirectorDialog } from "./ThreeDDirectorDialog";

/**
 * 导演台弹窗的按需加载版本，props 与 ThreeDDirectorDialog 完全一致。
 *
 * 导演台连带 three.js 有六百多 KB。画布上的图片生成、上传、技能、3D 世界节点和
 * 历史素材弹窗都挂着它，静态 import 会让这块代码跟着画布首屏一起下载、和画布
 * 自己的代码抢带宽。这里在第一次 open 之前什么都不渲染、不下载；打开过之后
 * 一直保持挂载，关闭动画和弹窗内部状态与直接使用原组件时一致（弹窗内容本身只在
 * 打开时挂载，关着的时候没有副作用）。
 */
const ThreeDDirectorDialogImpl = lazy(() =>
  import("./ThreeDDirectorDialog").then((module) => ({
    default: module.ThreeDDirectorDialog,
  })),
);

export function LazyThreeDDirectorDialog(
  props: ComponentProps<typeof ThreeDDirectorDialog>,
) {
  const [everOpened, setEverOpened] = useState(props.open);
  if (props.open && !everOpened) setEverOpened(true);
  if (!everOpened) return null;
  return (
    <Suspense fallback={null}>
      <ThreeDDirectorDialogImpl {...props} />
    </Suspense>
  );
}
