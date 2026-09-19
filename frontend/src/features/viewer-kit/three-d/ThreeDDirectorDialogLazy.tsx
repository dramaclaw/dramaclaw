// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * 「3D 导演」弹窗的按需加载入口。
 *
 * 这个弹窗背后是 playcanvas（预打包后 5.2MB，实测单独解析编译约 990ms 主线程）。
 * 它被画布里 5 个模块静态引用 —— ThreeDWorldNode / UploadNode / SkillNode /
 * ImageGenNode / CanvasHistoryAssetsModal —— 所以只要打开画布，引擎就必然进入模块
 * 图，哪怕这张画布一个 3D 节点都没有、用户一次都不会点开它。
 *
 * 这里把弹窗本体挪到独立 chunk，并把 Suspense 收在模块内部：调用方仍然写
 * `<ThreeDDirectorDialog ... />`，不必各自套一层。弹窗都是条件渲染的，挂起的只有
 * 弹窗这棵子树，节点本体不受影响。
 *
 * fallback 取 null 而不是骨架：弹窗是全屏覆盖层，先画一个空壳再换成真内容比晚
 * 一点整体出现更闪。需要消掉这段等待就提前调 [[preloadThreeDDirectorDialog]]。
 */
import { Suspense, lazy, type ComponentProps } from 'react';

import type { ThreeDDirectorDialog as ThreeDDirectorDialogComponent } from './ThreeDDirectorDialog';

export type { ThreeDDirectorCaptureMeta } from './ThreeDDirectorDialog';

type ThreeDDirectorDialogProps = ComponentProps<typeof ThreeDDirectorDialogComponent>;

const loadDialog = () =>
  import('./ThreeDDirectorDialog').then((m) => ({ default: m.ThreeDDirectorDialog }));

const LazyThreeDDirectorDialog = lazy(loadDialog);

let preloaded = false;

/** 提前拉起弹窗 chunk（例如画布里已经有 3D 节点时），点开即用。 */
export function preloadThreeDDirectorDialog(): void {
  if (preloaded) return;
  preloaded = true;
  // 预热失败不影响功能：真正打开时 lazy() 会自己重试。
  void loadDialog().catch(() => undefined);
}

export function ThreeDDirectorDialog(props: ThreeDDirectorDialogProps) {
  return (
    <Suspense fallback={null}>
      <LazyThreeDDirectorDialog {...props} />
    </Suspense>
  );
}
