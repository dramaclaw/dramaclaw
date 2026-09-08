// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { type PlayablePikoResidentId } from "./piko-residents";
import { RESIDENT_WORLD_SCALE } from "./runtime/resident-actor";
import type { PikoViewportFit } from "./runtime/viewport-fit";
import type { Point } from "./runtime/character-movement";
import { playPikoUiSound } from "./piko-audio";
import popupStyles from "./piko-popup.module.css";
import iconStyles from "./piko-icon-button.module.css";

export type PikoInteractionTarget = {
  id: string; nickname: string; bio: string; residentId: PlayablePikoResidentId;
};

/** Local resident interaction; no network request is sent by the chat preview. */
export function PikoResidentInteraction({ target, position, fit, onBusyChange, onHover }: {
  target: PikoInteractionTarget; position: Point; fit: PikoViewportFit;
  onBusyChange: (busy: boolean) => void; onHover: (hovered: boolean) => void;
}) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<"profile" | null>(null);
  const [requestNotice, setRequestNotice] = useState(0);
  useEffect(() => {
    if (!requestNotice) return;
    const timer = window.setTimeout(() => setRequestNotice(0), 4000);
    return () => window.clearTimeout(timer);
  }, [requestNotice]);
  const busy = menuOpen || panel !== null;
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => () => { onBusyChange(false); onHover(false); }, [onBusyChange, onHover]);
  const triggerId = `piko-resident-${target.id}`;
  const scale = fit.scale * RESIDENT_WORLD_SCALE;
  return <>
    <DropdownMenu open={menuOpen} onOpenChange={open => {
      setMenuOpen(open);
      if (open) { onBusyChange(true); playPikoUiSound("open"); }
    }}>
      <DropdownMenuTrigger id={triggerId} aria-label={t("pikoWorld.residentActions", { nickname: target.nickname })}
        onPointerEnter={() => onHover(true)} onPointerLeave={() => onHover(false)}
        className="absolute cursor-pointer bg-transparent focus-visible:outline-2 focus-visible:outline-ring"
        style={{ left: fit.x + position.x * fit.scale - 16 * scale,
          top: fit.y + position.y * fit.scale - 56 * scale, width: 32 * scale, height: 56 * scale }} />
      <DropdownMenuContent side="right" align="start" sideOffset={8}
        finalFocus={panel ? false : undefined}
        className={`${popupStyles.surface} w-32 min-w-0 max-w-[calc(100vw-1rem)] p-1`}>
        <DropdownMenuItem className={popupStyles.item} onClick={() => { setMenuOpen(false); setPanel("profile"); playPikoUiSound("open"); }}>{t("pikoWorld.viewResidentInfo")}</DropdownMenuItem>
        <DropdownMenuItem className={popupStyles.item} onClick={() => { setMenuOpen(false); setRequestNotice(previous => previous + 1); playPikoUiSound("open"); }}>{t("pikoWorld.chatWithResident")}</DropdownMenuItem>
        <DropdownMenuItem className={popupStyles.item} onClick={() => playPikoUiSound("close")}>{t("common.close")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <div role="status" aria-live="polite" className="pointer-events-none absolute inset-x-4 bottom-6 z-30 flex justify-center">
      {requestNotice > 0 && <p className={`${popupStyles.surface} m-0 px-4 py-2 text-center text-sm`}>{t("pikoWorld.chatRequestSent")}</p>}
    </div>
    <Dialog open={panel !== null} onOpenChange={open => { if (!open) setPanel(null); }}>
      <DialogContent showCloseButton={false} finalFocus={() => document.getElementById(triggerId)}
        overlayClassName="!bg-black/25 !backdrop-blur-none"
        className={`${popupStyles.surface} w-[min(22rem,calc(100vw-6rem))] max-w-[calc(100%-6rem)] gap-0 overflow-visible p-0 sm:max-w-[22rem]`}>
        <div className="max-h-[calc(100dvh-7rem)] overflow-y-auto px-6 py-6">
          <DialogTitle className="break-words pr-5 text-lg font-semibold leading-7">{target.nickname}</DialogTitle>
          <DialogDescription className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-amber-950/80">{target.bio || t("pikoWorld.emptyResidentBio")}</DialogDescription>
        </div>
        <DialogClose render={<button type="button" aria-label={t("common.close")} onClick={() => playPikoUiSound("close")}
          className={`${popupStyles.close} ${iconStyles.button}`} />}>
          <img src="/piko/world/ui/piko-world-close-icon-v1.png" alt="" draggable={false} />
        </DialogClose>
      </DialogContent>
    </Dialog>
  </>;
}
