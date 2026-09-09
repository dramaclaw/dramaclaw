// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import SideRays from "@/components/react-bits/side-rays";

export function CinematicSideRays({ className }: { className?: string }) {
  return (
    <SideRays
      className={className}
      speed={2.5}
      rayColor1="#eab308"
      rayColor2="#96c8ff"
      intensity={2}
      spread={2}
      origin="top-right"
      tilt={0}
      saturation={1.5}
      blend={0.75}
      falloff={1.6}
      opacity={1}
    />
  );
}
