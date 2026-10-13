// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

type PikoThreeSlicePanelSkinProps = {
  topSrc: string;
  middleSrc: string;
  bottomSrc: string;
  blendSeams?: boolean;
};

export function PikoThreeSlicePanelSkin({
  topSrc,
  middleSrc,
  bottomSrc,
  blendSeams = false,
}: PikoThreeSlicePanelSkinProps) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-[1] flex flex-col drop-shadow-2xl drop-shadow-black/50"
    >
      <img src={topSrc} alt="" className="relative z-[1] block h-auto w-full shrink-0" draggable={false}
        style={blendSeams ? { maskImage: "linear-gradient(to bottom, black calc(100% - 8px), transparent)" } : undefined} />
      <img
        src={middleSrc}
        alt=""
        className="block h-px min-h-0 w-full flex-1"
        style={blendSeams ? { marginTop: -8, marginBottom: -8 } : undefined}
        draggable={false}
      />
      <img
        src={bottomSrc}
        alt=""
        className="relative z-[1] block h-auto w-full shrink-0"
        style={blendSeams ? { maskImage: "linear-gradient(to bottom, transparent, black 8px)" } : undefined}
        draggable={false}
      />
    </div>
  );
}
