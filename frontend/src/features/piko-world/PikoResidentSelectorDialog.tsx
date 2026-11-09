// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { playPikoUiSound } from "./piko-audio";
import popupStyles from "./piko-popup.module.css";
import iconStyles from "./piko-icon-button.module.css";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { PIKO_RESIDENT_OPTIONS, isPlayablePikoResident, type PikoResidentId } from "./piko-residents";
import { PikoThreeSlicePanelSkin } from "./PikoThreeSlicePanelSkin";

const CLOSE_CONTROL_SRC = "/piko/world/ui/piko-world-close-icon-v1.png";
const PANEL_TOP_SRC =
  "/piko/world/ui/resident-selector/piko-world-resident-selector-panel-top-v1.png";
const PANEL_MIDDLE_SRC =
  "/piko/world/ui/resident-selector/piko-world-resident-selector-panel-middle-v1.png";
const PANEL_BOTTOM_SRC =
  "/piko/world/ui/resident-selector/piko-world-resident-selector-panel-bottom-v1.png";

type PikoResidentSelectorDialogProps = {
  open: boolean;
  selectedResidentId: PikoResidentId;
  onOpenChange: (open: boolean) => void;
  onConfirm: (residentId: PikoResidentId) => void;
};

export function PikoResidentSelectorDialog({
  open,
  selectedResidentId,
  onOpenChange,
  onConfirm,
}: PikoResidentSelectorDialogProps) {
  const { t } = useTranslation();
  const [draftResidentId, setDraftResidentId] = useState(selectedResidentId);

  useEffect(() => {
    if (open) setDraftResidentId(selectedResidentId);
  }, [open, selectedResidentId]);

  const handleGridKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const direction = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -5,
      ArrowDown: 5,
    }[event.key];
    if (!direction) return;
    event.preventDefault();
    const currentIndex = PIKO_RESIDENT_OPTIONS.findIndex(
      (resident) => resident.id === draftResidentId,
    );
    const nextIndex = Math.min(
      PIKO_RESIDENT_OPTIONS.length - 1,
      Math.max(0, currentIndex + direction),
    );
    let candidateIndex = nextIndex;
    const step = direction > 0 ? 1 : -1;
    while (candidateIndex >= 0 && candidateIndex < PIKO_RESIDENT_OPTIONS.length && !isPlayablePikoResident(PIKO_RESIDENT_OPTIONS[candidateIndex].id)) candidateIndex += step;
    const nextResident = PIKO_RESIDENT_OPTIONS[candidateIndex];
    if (!nextResident) return;
    if (nextResident.id !== draftResidentId) playPikoUiSound("open");
    setDraftResidentId(nextResident.id);
    event.currentTarget
      .querySelector<HTMLButtonElement>(`[data-resident-id="${nextResident.id}"]`)
      ?.focus();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        id="piko-world-resident-selector"
        showCloseButton={false}
        overlayClassName="bg-black/25 backdrop-blur-none duration-[var(--duration-slow)] data-open:fade-in-0 data-closed:fade-out-0"
        className="dark h-[min(34rem,calc(100dvh-7rem))] w-[min(45rem,calc(100vw-6rem))] max-w-[calc(100%-6rem)] gap-0 overflow-visible border-0 bg-transparent p-0 shadow-none ring-0 duration-[var(--duration-slow)] ease-[var(--ease-out-quint)] sm:max-w-[45rem] data-open:fade-in-0 data-open:zoom-in-95 data-closed:fade-out-0 data-closed:zoom-out-95"
      >
        <PikoThreeSlicePanelSkin
          topSrc={PANEL_TOP_SRC}
          middleSrc={PANEL_MIDDLE_SRC}
          bottomSrc={PANEL_BOTTOM_SRC}
        />

        <div className="relative z-10 flex h-full min-h-0 flex-col px-14 pb-16 pt-24 text-primary-foreground">
          <header className="shrink-0 text-center">
            <DialogTitle className="text-base font-semibold leading-5">
              {t("pikoWorld.residentSelectorTitle")}
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs leading-4 text-primary-foreground/55">
              {t("pikoWorld.residentSelectorDescription")}
            </DialogDescription>
          </header>

          <div
            className="mx-auto mt-3 grid min-h-0 w-[92%] flex-1 grid-cols-5 grid-rows-2 gap-x-0 gap-y-3"
            role="radiogroup"
            aria-label={t("pikoWorld.residentSelectorTitle")}
            onKeyDown={handleGridKeyDown}
          >
            {PIKO_RESIDENT_OPTIONS.map((resident, index) => {
              const playable = isPlayablePikoResident(resident.id);
              const selected = resident.id === draftResidentId;
              const label = playable ? t(`pikoWorld.playableResident_${resident.id}`) : t("pikoWorld.residentOptionLabel", { number: index + 1 });
              return (
                <button
                  key={resident.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={!playable}
                  title={!playable ? t("pikoWorld.residentComingSoon") : undefined}
                  aria-label={label}
                  tabIndex={selected ? 0 : -1}
                  data-resident-id={resident.id}
                  className="group/resident relative flex min-h-0 flex-col items-center px-1 pb-1 focus-visible:outline-none disabled:opacity-35 disabled:cursor-not-allowed"
                  onClick={() => { if (resident.id !== draftResidentId) playPikoUiSound("open"); setDraftResidentId(resident.id); }}
                >
                  {selected && (
                    <>
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute bottom-[1.05rem] left-1/2 h-3 w-14 -translate-x-1/2 rounded-[100%] border border-amber-700/45 bg-[radial-gradient(ellipse_at_center,rgba(255,240,174,0.95)_0%,rgba(224,164,53,0.68)_42%,rgba(173,103,24,0.08)_72%,transparent_78%)] shadow-[0_0_14px_rgba(202,137,34,0.62)]"
                      />
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute bottom-[1.52rem] left-1/2 h-1 w-8 -translate-x-1/2 rounded-full bg-amber-100/80 blur-[0.5px]"
                      />
                    </>
                  )}
                  <img
                    src={resident.src}
                    alt=""
                    className={cn(
                      "relative z-10 min-h-0 w-full flex-1 object-contain object-bottom transition-[filter,transform] duration-[var(--duration-fast)] ease-[var(--ease-out-quint)] group-hover/resident:-translate-y-0.5 group-hover/resident:brightness-110 group-focus-visible/resident:brightness-110 group-focus-visible/resident:drop-shadow-[0_0_8px_rgba(180,115,36,0.45)]",
                      selected &&
                        "brightness-110 saturate-110 drop-shadow-[0_0_2px_rgba(255,249,216,0.9)] drop-shadow-[0_0_11px_rgba(191,124,27,0.56)]",
                    )}
                    draggable={false}
                  />
                  <span
                    className={cn(
                      "relative z-10 mt-0.5 shrink-0 text-[10px] font-medium leading-3 text-primary-foreground/55 transition-colors duration-[var(--duration-fast)] group-hover/resident:text-primary-foreground/75",
                      selected && "font-semibold text-amber-950",
                    )}
                  >
                    {label}
                  </span>
                </button>
              );
            })}
          </div>

          <footer className="mt-3 flex shrink-0 translate-y-2 justify-center">
            <button
              type="button"
              className={`${iconStyles.button} h-9 rounded-[10px] border border-amber-950/25 bg-amber-200/85 px-4 text-xs font-semibold text-amber-950`}
              onClick={() => {
                if (!isPlayablePikoResident(draftResidentId)) return;
                onConfirm(draftResidentId);
                onOpenChange(false);
              }}
            >
              {t("pikoWorld.residentSelectorConfirm")}
            </button>
          </footer>
        </div>

        <DialogClose
          render={
            <button
              type="button"
              className={`${popupStyles.close} ${iconStyles.button}`}
              aria-label={t("pikoWorld.residentSelectorClose")}
            />
          }
        >
          <img src={CLOSE_CONTROL_SRC} alt="" className="size-8 object-contain" draggable={false} />
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
