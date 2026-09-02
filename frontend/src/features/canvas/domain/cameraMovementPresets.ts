// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Camera-movement presets. Fallback list used when
// `/freezone/video/camera-templates` is loading or unavailable. The runtime
// source of truth is the backend endpoint, fetched via
// `useFreezoneVideoCameraTemplates`. Mirrors libtv's 23-entry 运镜 catalog;
// each entry ships with a short .mp4 preview at `public/video/camera-presets/`.

import type { FreezoneVideoCameraTemplate } from "@/api/ops";
import type { TFn } from "@/lib/i18n-types";

export type CameraMovementPreset = FreezoneVideoCameraTemplate;

// 这张表是后端 `/freezone/video/camera-templates` 返回结构的本地兜底副本：
// label 要和后端返回的中文标签逐字对上(下面的反查表按 label/promptFragment
// 匹配本地 mp4)，promptFragment 又是拼进提示词、由模型读的内容。两者都不能
// 翻译；界面显示的文案走 cameraMovementPresetLabel() 按 id 查词条。
// i18n-exempt-start
export const CAMERA_MOVEMENT_PRESETS: ReadonlyArray<CameraMovementPreset> = [
  { id: 'fixed', label: '固定镜头', videoUrl: '/video/camera-presets/fixed.mp4', promptFragment: '固定镜头' },
  { id: 'follow', label: '跟随拍摄', videoUrl: '/video/camera-presets/follow.mp4', promptFragment: '跟随拍摄' },
  { id: 'spiral-up', label: '盘旋抬升', videoUrl: '/video/camera-presets/spiral-up.mp4', promptFragment: '镜头盘旋抬升' },
  { id: 'spiral-down', label: '盘旋下降', videoUrl: '/video/camera-presets/spiral-down.mp4', promptFragment: '镜头盘旋下降' },
  { id: 'tilt-up', label: '镜头上摇', videoUrl: '/video/camera-presets/tilt-up.mp4', promptFragment: '镜头上摇' },
  { id: 'tilt-down', label: '镜头下摇', videoUrl: '/video/camera-presets/tilt-down.mp4', promptFragment: '镜头下摇' },
  { id: 'pan-left', label: '镜头左摇', videoUrl: '/video/camera-presets/pan-left.mp4', promptFragment: '镜头左摇' },
  { id: 'pan-right', label: '镜头右摇', videoUrl: '/video/camera-presets/pan-right.mp4', promptFragment: '镜头右摇' },
  { id: 'crane-up', label: '镜头上升', videoUrl: '/video/camera-presets/crane-up.mp4', promptFragment: '镜头上升' },
  { id: 'crane-down', label: '镜头下降', videoUrl: '/video/camera-presets/crane-down.mp4', promptFragment: '镜头下降' },
  { id: 'truck-left', label: '镜头左移', videoUrl: '/video/camera-presets/truck-left.mp4', promptFragment: '镜头左移' },
  { id: 'truck-right', label: '镜头右移', videoUrl: '/video/camera-presets/truck-right.mp4', promptFragment: '镜头右移' },
  { id: 'dolly-in', label: '镜头前推', videoUrl: '/video/camera-presets/dolly-in.mp4', promptFragment: '镜头前推' },
  { id: 'dolly-out', label: '镜头后移', videoUrl: '/video/camera-presets/dolly-out.mp4', promptFragment: '镜头后移' },
  { id: 'zoom-in', label: '变焦推进', videoUrl: '/video/camera-presets/zoom-in.mp4', promptFragment: '变焦推进' },
  { id: 'zoom-out', label: '变焦拉远', videoUrl: '/video/camera-presets/zoom-out.mp4', promptFragment: '变焦拉远' },
  { id: 'dolly-zoom', label: '柯克变焦', videoUrl: '/video/camera-presets/dolly-zoom.mp4', promptFragment: '柯克变焦（dolly zoom）' },
  { id: 'orbit', label: '环绕拍摄', videoUrl: '/video/camera-presets/orbit.mp4', promptFragment: '镜头环绕拍摄' },
  { id: 'roll', label: '滚筒旋转', videoUrl: '/video/camera-presets/roll.mp4', promptFragment: '镜头滚筒旋转' },
  { id: 'fpv', label: '第一视角', videoUrl: '/video/camera-presets/fpv.mp4', promptFragment: '第一视角拍摄' },
  { id: 'drone', label: '无人机', videoUrl: '/video/camera-presets/drone.mp4', promptFragment: '无人机航拍' },
  { id: 'aerial', label: '高空航拍', videoUrl: '/video/camera-presets/aerial.mp4', promptFragment: '高空航拍' },
  { id: 'handheld', label: '手持拍摄', videoUrl: '/video/camera-presets/handheld.mp4', promptFragment: '手持拍摄' },
];
// i18n-exempt-end

/**
 * Display label for a camera preset. Locale entry keyed by preset id; the
 * backend-supplied `label` stays the fallback for templates we don't ship.
 */
export function cameraMovementPresetLabel(preset: CameraMovementPreset, t: TFn): string {
  return t(`canvas.cameraMovement.presets.${preset.id}`, { defaultValue: preset.label });
}

export function findCameraMovementPreset(
  templates: ReadonlyArray<CameraMovementPreset>,
  id: string | null | undefined,
): CameraMovementPreset | null {
  if (!id) return null;
  return templates.find((preset) => preset.id === id) ?? null;
}

// Reverse lookups built from the bundled 23-entry catalog so backend templates
// without a `videoUrl` can borrow the matching local mp4 (`public/video/
// camera-presets/<id>.mp4`). The backend likely returns Chinese labels /
// promptFragments verbatim — match those first; id fallback covers the case
// where backend ids happen to align with our kebab-case ones.
const LOCAL_VIDEO_URL_BY_ID = new Map<string, string>();
const LOCAL_VIDEO_URL_BY_LABEL = new Map<string, string>();
const LOCAL_VIDEO_URL_BY_FRAGMENT = new Map<string, string>();
for (const preset of CAMERA_MOVEMENT_PRESETS) {
  if (!preset.videoUrl) continue;
  LOCAL_VIDEO_URL_BY_ID.set(preset.id, preset.videoUrl);
  LOCAL_VIDEO_URL_BY_LABEL.set(preset.label.trim(), preset.videoUrl);
  LOCAL_VIDEO_URL_BY_FRAGMENT.set(preset.promptFragment.trim(), preset.videoUrl);
}

/**
 * Resolve a preview video URL for a camera preset. Priority:
 *   1. The template's own `videoUrl` (backend-supplied).
 *   2. Local mp4 matched by exact Chinese label.
 *   3. Local mp4 matched by exact promptFragment.
 *   4. Local mp4 matched by id.
 * Returns null if nothing matches (caller should skip rendering <video>).
 */
export function resolveCameraPresetVideoUrl(
  preset: CameraMovementPreset,
): string | null {
  if (preset.videoUrl) return preset.videoUrl;
  const label = preset.label.trim();
  const fragment = preset.promptFragment.trim();
  return (
    LOCAL_VIDEO_URL_BY_LABEL.get(label) ??
    LOCAL_VIDEO_URL_BY_FRAGMENT.get(fragment) ??
    LOCAL_VIDEO_URL_BY_ID.get(preset.id) ??
    null
  );
}
