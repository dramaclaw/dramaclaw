// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { PrevizScene } from '../domain/scene';

/** 录哪一路：导演视角，还是当前轨道那台机位看到的画面。 */
export type PrevizRecordMode = 'global' | 'track';

export interface PrevizRecordTarget {
  mode: PrevizRecordMode;
  /** `track` 时是要录的那台机位；`global` 恒为 null。 */
  cameraId: string | null;
  /** 机位序号，1 起，用来给节点起名；`global` 恒为 null。 */
  index: number | null;
}

/**
 * 解出这次录制到底录谁。
 *
 * 「当前轨道」优先认**选中的对象**：时间轴上高亮的那条轨道就是它，用户点了哪条就录哪条。
 * 选中的不是机位（选着人物在调走位是常态）时退回右下角正在监看的那台——那是屏幕上
 * 唯一一路已经在放的镜头画面，录它不会让人意外。两者都不是机位就交出 null，由调用方
 * 提示「先选一台机位」，而不是默默录成导演视角。
 *
 * 序号按机位在场景里的排列取，不按时间轴轨道取：同一台机位在「还没画轨迹」和「画完
 * 轨迹」两种状态下必须是同一个号，否则先录后画会得到两个号不同、内容同源的节点。
 */
export function resolveRecordTarget(
  scene: PrevizScene,
  mode: PrevizRecordMode,
  selectedObjectId: string | null,
  activeCameraId: string | null,
): PrevizRecordTarget | null {
  if (mode === 'global') return { mode, cameraId: null, index: null };

  const cameras = scene.objects.filter((object) => object.kind === 'camera');
  const cameraId =
    cameras.find((camera) => camera.id === selectedObjectId)?.id ??
    cameras.find((camera) => camera.id === activeCameraId)?.id ??
    null;
  if (!cameraId) return null;

  return {
    mode,
    cameraId,
    index: cameras.findIndex((camera) => camera.id === cameraId) + 1,
  };
}
