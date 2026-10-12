// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
export interface PikoSize {
  width: number;
  height: number;
}

export interface PikoViewportFit {
  scale: number;
  x: number;
  y: number;
}

export function containWorldInViewport(viewport: PikoSize, world: PikoSize): PikoViewportFit {
  const scale = Math.min(viewport.width / world.width, viewport.height / world.height);
  return {
    scale,
    x: Math.round((viewport.width - world.width * scale) / 2),
    y: Math.round((viewport.height - world.height * scale) / 2),
  };
}
