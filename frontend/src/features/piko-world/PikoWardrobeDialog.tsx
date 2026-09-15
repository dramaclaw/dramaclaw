// SPDX-License-Identifier: Elastic-2.0
import { useTranslation } from "react-i18next";
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { PIKO_PLAYER_ART, type PikoPlayerGender } from "./piko-player";
import { PikoThreeSlicePanelSkin } from "./PikoThreeSlicePanelSkin";
import popupStyles from "./piko-popup.module.css";
import iconStyles from "./piko-icon-button.module.css";
import styles from "./piko-wardrobe.module.css";

export function PikoWardrobeDialog({ open, onOpenChange, gender, nickname }: {
  open: boolean; onOpenChange: (open: boolean) => void; gender: PikoPlayerGender; nickname: string;
}) {
  const { t } = useTranslation();
  const art = PIKO_PLAYER_ART[gender];
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent showCloseButton={false} overlayClassName="!bg-black/25 !backdrop-blur-none" className={`dark ${styles.dialog}`} finalFocus={() => document.getElementById("piko-world-settings")}>
      <PikoThreeSlicePanelSkin blendSeams
        topSrc="/piko/world/ui/wardrobe/wardrobe-top-v1.png"
        middleSrc="/piko/world/ui/wardrobe/wardrobe-middle-v1.png"
        bottomSrc="/piko/world/ui/wardrobe/wardrobe-bottom-v1.png" />
      <div className={styles.content}>
      <DialogTitle className={styles.title}>{t("pikoWorld.wardrobe.title")}</DialogTitle>
      <DialogDescription className={styles.description}>{t("pikoWorld.wardrobe.description")}</DialogDescription>
      <div className={styles.layout}>
        <section aria-label={t("pikoWorld.wardrobe.clothes")}>
          <div className={styles.slots}>
            <div className={styles.current}>{t("pikoWorld.wardrobe.base")}</div>
            {Array.from({ length: 5 }, (_, i) => <div key={i} className={styles.slot} aria-hidden="true" />)}
          </div>
        </section>
        <div className={styles.character}>
          <span className={styles.nickname}>{nickname}</span>
          <div className={styles.characterArt} style={{ height: `${200 * (art.baseline - art.top) / 1476}px` }}>
            <img style={{ height: `${200 * art.height / 1476}px`, top: `${-200 * art.top / 1476}px` }} src={art.src} alt={t(`pikoWorld.onboarding.${gender}`)} draggable={false} />
          </div>
        </div>
        <section aria-label={t("pikoWorld.wardrobe.accessories")}>
          <div className={styles.slots}>{Array.from({ length: 6 }, (_, i) => <div key={i} className={styles.slot} aria-hidden="true" />)}</div>

        </section>
      </div>
      <footer className="mt-5 flex translate-y-4 justify-center">
        <button type="button" className={`${iconStyles.button} rounded-md border border-amber-950/25 bg-amber-200/85 px-5 py-2 text-sm font-semibold`} onClick={() => onOpenChange(false)}>{t("pikoWorld.wardrobe.confirm")}</button>
      </footer>
      </div>
      <DialogClose render={<button type="button" className={`${popupStyles.close} ${styles.close} ${iconStyles.button}`} aria-label={t("common.close")} />}>
        <img src="/piko/world/ui/piko-world-close-icon-v1.png" alt="" draggable={false} />
      </DialogClose>
    </DialogContent>
  </Dialog>;
}
