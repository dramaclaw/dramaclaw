// SPDX-License-Identifier: Elastic-2.0
import inputStyles from "./piko-input.module.css";
import popupStyles from "./piko-popup.module.css";
import iconStyles from "./piko-icon-button.module.css";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { PikoThreeSlicePanelSkin } from "./PikoThreeSlicePanelSkin";
import { isValidPikoProfile, normalizePikoProfile, PIKO_BIO_MAX, PIKO_NICKNAME_MAX, type PikoProfile } from "./piko-profile";

export function PikoProfileDialog({ open, profile, onOpenChange, onSave }: {
  open: boolean;
  profile: PikoProfile;
  onOpenChange: (open: boolean) => void;
  onSave: (profile: PikoProfile) => boolean;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(profile);
  const [saveFailed, setSaveFailed] = useState(false);
  useEffect(() => {
    if (open) { setDraft(profile); setSaveFailed(false); }
  }, [open, profile]);
  const valid = isValidPikoProfile(normalizePikoProfile(draft));
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent showCloseButton={false}
      overlayClassName="!bg-black/25 !backdrop-blur-none"
      finalFocus={() => document.getElementById("piko-world-settings")}
      className="dark w-[min(32rem,calc(100vw-6rem))] max-w-[calc(100%-6rem)] gap-0 overflow-visible border-0 bg-transparent p-0 shadow-none ring-0 sm:max-w-lg">
      <PikoThreeSlicePanelSkin
        blendSeams
        topSrc="/piko/world/ui/profile-edit/piko-world-profile-edit-panel-top-v2.png"
        middleSrc="/piko/world/ui/profile-edit/piko-world-profile-edit-panel-middle-v2.png"
        bottomSrc="/piko/world/ui/profile-edit/piko-world-profile-edit-panel-bottom-v2.png" />
      <form className="relative z-10 max-h-[calc(100dvh-7rem)] overflow-y-auto px-[12%] pb-[22%] pt-[21%] text-primary-foreground"
        onSubmit={event => {
          event.preventDefault();
          if (!valid) return;
          if (onSave(normalizePikoProfile(draft))) onOpenChange(false);
          else setSaveFailed(true);
        }}>
        <DialogTitle className="text-center text-base font-semibold">{t("pikoWorld.editProfile")}</DialogTitle>
        <DialogDescription className="mt-2 text-center text-xs text-primary-foreground/70">{t("pikoWorld.profileDescription")}</DialogDescription>
        <label className="mt-5 block text-sm font-medium" htmlFor="piko-nickname">{t("pikoWorld.nickname")}</label>
        <input id="piko-nickname" value={draft.nickname} maxLength={PIKO_NICKNAME_MAX} required autoComplete="off"
          onChange={event => setDraft({ ...draft, nickname: event.target.value })}
          className={`${inputStyles.input} mt-2`} />
        <label className="mt-4 block text-sm font-medium" htmlFor="piko-bio">{t("pikoWorld.bio")}</label>
        <textarea id="piko-bio" value={draft.bio} maxLength={PIKO_BIO_MAX} rows={3}
          onChange={event => setDraft({ ...draft, bio: event.target.value })}
          className={`${inputStyles.input} mt-2 resize-none`} />
        {saveFailed && <p role="alert" className="mt-2 text-sm">{t("pikoWorld.profileSaveFailed")}</p>}
        <footer className="mt-5 flex translate-y-4 justify-center">
          <button type="submit" disabled={!valid}
            className={`${iconStyles.button} rounded-md border border-amber-950/25 bg-amber-200/85 px-5 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40`}>
            {t("pikoWorld.saveProfile")}
          </button>
        </footer>
      </form>
      <DialogClose render={<button type="button" aria-label={t("common.close")}
        className={`${popupStyles.close} ${iconStyles.button}`} />}>
        <img src="/piko/world/ui/piko-world-close-icon-v1.png" alt="" draggable={false} />
      </DialogClose>
    </DialogContent>
  </Dialog>;
}
