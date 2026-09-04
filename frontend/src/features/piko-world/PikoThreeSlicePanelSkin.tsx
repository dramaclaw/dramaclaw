// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

type PikoThreeSlicePanelSkinProps = {
  topSrc: string;
  middleSrc: string;
  bottomSrc: string;
};

export function PikoThreeSlicePanelSkin({
  topSrc,
  middleSrc,
  bottomSrc,
}: PikoThreeSlicePanelSkinProps) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-[1] flex flex-col drop-shadow-2xl drop-shadow-black/50"
    >
      <img src={topSrc} alt="" className="block h-auto w-full shrink-0" draggable={false} />
      <img
        src={middleSrc}
        alt=""
        className="block h-px min-h-0 w-full flex-1"
        draggable={false}
      />
      <img
        src={bottomSrc}
        alt=""
        className="block h-auto w-full shrink-0"
        draggable={false}
      />
    </div>
  );
}
