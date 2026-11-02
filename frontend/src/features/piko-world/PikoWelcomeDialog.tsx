// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import iconStyles from "./piko-icon-button.module.css";
import styles from "./piko-welcome-dialog.module.css";
import { playPikoUiSound } from "./piko-audio";

export function PikoWelcomeDialog({open,onOpenChange,onComplete}: {
  open:boolean; onOpenChange:(open:boolean)=>void; onComplete?:()=>void;
}) {
  const { t } = useTranslation();
  const [page,setPage] = useState(0);
  const voice = useRef<HTMLAudioElement | null>(null);
  const stopVoice = () => { if (voice.current) { voice.current.pause(); voice.current.currentTime = 0; } };
  useEffect(() => {
    if (!open) return;
    const audio = new Audio('/piko/world/audio/mayor-welcome-v1.wav');
    voice.current = audio;
    void audio.play().catch(() => {});
    return () => { audio.pause(); audio.removeAttribute('src'); audio.load(); voice.current = null; };
  }, [open]);
  return <Dialog open={open} onOpenChange={value=>{if(!value){stopVoice();setPage(0);playPikoUiSound("close");}onOpenChange(value);}}>
    <DialogContent className={styles.dialog} overlayClassName="!backdrop-blur-none !bg-black/45"
      showCloseButton={false} finalFocus={()=>document.getElementById("piko-map-control")}>
      <img className={styles.mayor} src="/piko/world/dialogue/mayor-welcome-v3.png" alt="" draggable={false} />
      <div className={styles.panel}>
        <img className={styles.art} src="/piko/world/dialogue/panel-v2-transparent.png" alt="" draggable={false} />
        <DialogTitle className={styles.name}>{t("pikoWorld.welcomeTitle")}</DialogTitle>
      <DialogDescription className={styles.text} aria-live="polite" tabIndex={0}>
        {t(`pikoWorld.welcomePage${page+1}`)}
      </DialogDescription>
      <div className={styles.footer}>
        <button type="button" className={styles.next} onClick={()=>{playPikoUiSound(page<1?"open":"close");if(page<1)setPage(page+1);else{stopVoice();setPage(0);onComplete?.();onOpenChange(false);}}}>
          {t(page<1?"pikoWorld.welcomeNext":"pikoWorld.welcomeDone")}
          <span aria-hidden="true"> ▸</span>
        </button>
      </div>
      </div>
      <DialogClose render={<button type="button" className={`${styles.close} ${iconStyles.button}`} aria-label={t("common.close")} />}>
        <img src="/piko/world/ui/piko-world-close-icon-v1.png" alt="" draggable={false} />
      </DialogClose>
    </DialogContent>
  </Dialog>;
}
