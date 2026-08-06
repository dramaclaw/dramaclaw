// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * 媒体模型能力的统一解析入口。
 *
 * 每个模型支持哪些分辨率 / 画面比例 / 画质，都由后台「媒体模型」配置下发，
 * 经 `/freezone/image|video/models` 进入前端。画布上的所有生成 / 编辑面板都
 * 必须从这里读，不允许各自维护一份常量 —— 否则后台改了配置前端不跟随。
 *
 * 这里的 FALLBACK_* 常量只在目录接口拉取失败、模型条目没有声明该项能力时兜底，
 * 不是模型能力的事实来源。
 */

/** 目录条目里与「能力」相关的字段，image 与 video 条目都满足这个形状。 */
export interface MediaModelCapabilities {
  resolutionOptions?: string[] | null;
  ratioOptions?: string[] | null;
  qualityOptions?: string[] | null;
}

/** 目录未声明分辨率时的兜底档位。 */
export const FALLBACK_IMAGE_SIZE_OPTIONS: readonly string[] = ['1K', '2K', '4K'];

/** 目录未声明画面比例时的兜底档位。 */
export const FALLBACK_IMAGE_ASPECT_OPTIONS: readonly string[] = [
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '21:9',
];

/** 目录未声明分辨率时的视频兜底档位。 */
export const FALLBACK_VIDEO_RESOLUTION_OPTIONS: readonly string[] = [
  '480p',
  '720p',
  '1080p',
];

/**
 * 目录未声明画面比例时的视频兜底档位。
 *
 * 首项 `auto` 表示跟随首帧 / 参考图，是前端语义而非某个模型的能力；目录一旦
 * 声明了 ratioOptions 就完全以目录为准，不再注入 auto。
 */
export const FALLBACK_VIDEO_ASPECT_OPTIONS: readonly string[] = [
  'auto',
  '16:9',
  '4:3',
  '1:1',
  '3:4',
  '9:16',
  '21:9',
];

function normalizeOptions(values: string[] | null | undefined): string[] {
  return (values ?? []).map((item) => item.trim()).filter(Boolean);
}

/** 选中模型支持的分辨率档位；目录没配就用兜底。 */
export function resolveModelSizeOptions(
  model: MediaModelCapabilities | null | undefined,
  fallback: readonly string[] = FALLBACK_IMAGE_SIZE_OPTIONS,
): string[] {
  const configured = normalizeOptions(model?.resolutionOptions);
  return configured.length > 0 ? configured : [...fallback];
}

/** 选中模型支持的画面比例；目录没配就用兜底。 */
export function resolveModelAspectOptions(
  model: MediaModelCapabilities | null | undefined,
  fallback: readonly string[] = FALLBACK_IMAGE_ASPECT_OPTIONS,
): string[] {
  const configured = normalizeOptions(model?.ratioOptions);
  return configured.length > 0 ? configured : [...fallback];
}

/**
 * 选中模型支持的画质档位。
 *
 * 与分辨率 / 比例不同，画质**没有兜底**：目录没声明就代表这个模型不接受
 * quality 参数，此时下发 quality 会被网关拒掉。
 */
export function resolveModelQualityOptions(
  model: MediaModelCapabilities | null | undefined,
): string[] {
  return normalizeOptions(model?.qualityOptions);
}

/**
 * 该模型是否接受画质参数。
 *
 * 判据是目录里有没有配 `qualityOptions`，不是模型名长什么样 —— 后台新增一个
 * 支持画质的模型时，前端不需要跟着改代码。
 */
export function modelSupportsQuality(
  model: MediaModelCapabilities | null | undefined,
): boolean {
  return resolveModelQualityOptions(model).length > 0;
}

/**
 * 把已选值收敛到当前模型允许的取值范围内。
 *
 * 换模型后旧的选择可能已经不在新模型的档位里，此时退回首个可用档位，
 * 避免把模型不支持的值提交给后端。
 */
export function pickAllowedOption(
  current: string | null | undefined,
  options: readonly string[],
  fallback?: string,
): string {
  const normalized = String(current ?? '').trim();
  if (normalized && options.includes(normalized)) return normalized;
  const caseInsensitive = normalized
    ? options.find((option) => option.toLowerCase() === normalized.toLowerCase())
    : undefined;
  return caseInsensitive ?? options[0] ?? fallback ?? '';
}
