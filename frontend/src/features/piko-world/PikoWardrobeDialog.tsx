// SPDX-License-Identifier: Elastic-2.0
import { useTranslation } from "react-i18next";
import { useRef, useState } from "react";
import { PLAYER_ACCESSORIES, accessoryDefinition, accessoryPose, accessorySrc, type PlayerAccessorySelection } from "./piko-player-accessories";
import { Ban } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { PIKO_PLAYER_ART, type PikoPlayerGender } from "./piko-player";
import { PikoThreeSlicePanelSkin } from "./PikoThreeSlicePanelSkin";
import popupStyles from "./piko-popup.module.css";
import iconStyles from "./piko-icon-button.module.css";
import styles from "./piko-wardrobe.module.css";

export function PikoWardrobeDialog({ open, onOpenChange, gender, nickname, accessory = null, onSave }: {
  open: boolean; onOpenChange: (open: boolean) => void; gender: PikoPlayerGender; nickname: string; accessory?: PlayerAccessorySelection; onSave?: (id: PlayerAccessorySelection) => boolean;
}) {
  const { t } = useTranslation();
  const art = PIKO_PLAYER_ART[gender];
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState(accessory);
  const [wasOpen, setWasOpen] = useState(open);
  const [error, setError] = useState(false);
  // Reset only on opening so a saved selection never overwrites an active draft.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) { setDraft(accessory); setError(false); }
  }
  const item = accessoryDefinition(draft);
  const pose = item ? accessoryPose(item.id, "south") : null;
  const portraitScale = 200 / 1476;
  const visibleHeight = (art.baseline - art.top) * portraitScale;
  const previewScale = visibleHeight / 56;
  const confirm = () => {
    if (onSave && !onSave(draft)) { setError(true); return; }
    onOpenChange(false);
  };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent showCloseButton={false} initialFocus={() => confirmRef.current} overlayClassName="!bg-black/25 !backdrop-blur-none" className={`dark ${styles.dialog}`} finalFocus={() => document.getElementById("piko-world-wardrobe")}>
      <PikoThreeSlicePanelSkin blendSeams
        topSrc="/piko/world/ui/wardrobe/wardrobe-top-v1.png"
        middleSrc="/piko/world/ui/wardrobe/wardrobe-middle-v1.png"
        bottomSrc="/piko/world/ui/wardrobe/wardrobe-bottom-v1.png" />
      <div className={styles.content}>
      <DialogTitle className={styles.title}>{t("pikoWorld.wardrobe.title")}</DialogTitle>
      <DialogDescription className="sr-only">{t("pikoWorld.wardrobe.description")}</DialogDescription>
      <div className={styles.layout}>
        <section aria-label={t("pikoWorld.wardrobe.clothes")}>
          <div className={styles.slots}>
            <div className={styles.current} title={t("pikoWorld.wardrobe.base")}>
              <img className={styles.outfitIcon} src={`/piko/world/ui/wardrobe/base-outfit-${gender}-v2.png`} alt={t("pikoWorld.wardrobe.base")} draggable={false} />
            </div>
            {Array.from({ length: 5 }, (_, i) => <button key={i} type="button" disabled className={`${styles.slot} ${styles.unavailable}`} aria-label={t("pikoWorld.wardrobe.unavailable")} title={t("pikoWorld.wardrobe.unavailable")}><Ban size={14} strokeWidth={1.5} aria-hidden="true" /></button>)}
          </div>
        </section>
        <div className={styles.character}>
          <span className={styles.nickname}>{nickname}</span>
          <div className={styles.characterArt} style={{ height: visibleHeight }}>
            <img className={styles.portrait} style={{ height: art.height * portraitScale, top: -art.top * portraitScale }} src={art.src} alt={t(`pikoWorld.onboarding.${gender}`)} draggable={false} />
            {item && pose && <span className={styles.wornAccessory} style={{ left: `calc(50% + ${pose.x * previewScale}px)`, top: pose.y * previewScale, width: pose.width * previewScale, height: pose.height * previewScale }}>
              <img src={accessorySrc(item)} alt="" draggable={false} style={{ width: `${128 / item.crop[2] * 100}%`, left: `${-item.crop[0] / item.crop[2] * 100}%`, top: `${-item.crop[1] / item.crop[3] * 100}%` }} />
            </span>}
          </div>
        </div>
        <section aria-label={t("pikoWorld.wardrobe.accessories")}>
          <div className={styles.slots}>{PLAYER_ACCESSORIES.map(option => <button key={option.id} type="button" className={`${styles.slot} ${styles.accessorySlot}`} aria-label={t(`myBuddy.debug.accessories.${option.name}`)} title={t(`myBuddy.debug.accessories.${option.name}`)} aria-pressed={draft === option.id} onClick={() => { setDraft(draft === option.id ? null : option.id); setError(false); }}>
            <img src={accessorySrc(option)} alt="" draggable={false} />
          </button>)}</div>

        </section>
      </div>
      {error && <p role="alert" className={styles.saveError}>{t("pikoWorld.wardrobe.saveError")}</p>}
      <footer className="mt-5 flex translate-y-4 justify-center">
        <button ref={confirmRef} type="button" className={`${iconStyles.button} rounded-md border border-amber-950/25 bg-amber-200/85 px-5 py-2 text-sm font-semibold`} onClick={confirm}>{t("pikoWorld.wardrobe.confirm")}</button>
      </footer>
      </div>
      <DialogClose render={<button type="button" className={`${popupStyles.close} ${styles.close} ${iconStyles.button}`} aria-label={t("common.close")} />}>
        <img src="/piko/world/ui/piko-world-close-icon-v1.png" alt="" draggable={false} />
      </DialogClose>
    </DialogContent>
  </Dialog>;
}
