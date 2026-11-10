// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/** Width over height of a "w:h" ratio; anything unparsable or non-positive reads as 1. */
export function parseAspectRatio(value: string): number {
  const [width, height] = value.split(':').map((item) => Number(item));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 1;
  }

  return width / height;
}

// 从一组候选比例（"w:h" 字符串）里挑数值上最接近 targetRatio 的那个。用比值的
// 对数距离，横/竖比例对称（2.33 与其倒数 0.43 到 1 的距离一致）。候选为空时回退 '1:1'。
export function pickClosestAspectRatio(
  targetRatio: number,
  supportedAspectRatios: string[],
): string {
  const supported = supportedAspectRatios.length > 0 ? supportedAspectRatios : ['1:1'];
  let bestValue = supported[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const aspectRatio of supported) {
    const ratio = parseAspectRatio(aspectRatio);
    const distance = Math.abs(Math.log(ratio / targetRatio));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestValue = aspectRatio;
    }
  }

  return bestValue;
}

// Snap any ratio string (incl. raw pixel ratios) to the numerically closest
// allowed value. Non-ratio inputs ("auto" / "" / garbage) resolve to `fallback`.
export function snapToAllowedAspectRatio(
  value: string,
  allowed: readonly string[],
  fallback: string,
): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed.includes(':')) return fallback;
  const candidates = allowed.length > 0 ? [...allowed] : [fallback];
  return pickClosestAspectRatio(parseAspectRatio(trimmed), candidates);
}
