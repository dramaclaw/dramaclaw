// SPDX-License-Identifier: Elastic-2.0
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import styles from "./piko-welcome-dialog.module.css";
import { playPikoUiSound } from "./piko-audio";

export function PikoWelcomeDialog({open,onOpenChange,onComplete}: {
  open:boolean; onOpenChange:(open:boolean)=>void; onComplete:()=>void;
}) {
  const { t } = useTranslation();
  const [page,setPage] = useState(0);
  return <Dialog open={open} onOpenChange={value=>{if(!value){setPage(0);playPikoUiSound("close");}onOpenChange(value);}}>
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
        <button type="button" className={styles.next} onClick={()=>{playPikoUiSound(page<2?"open":"close");if(page<2)setPage(page+1);else{setPage(0);onComplete();onOpenChange(false);}}}>
          {t(page<2?"pikoWorld.welcomeNext":"pikoWorld.welcomeDone")}
          <span aria-hidden="true"> ▸</span>
        </button>
      </div>
      </div>
      <DialogClose render={<button type="button" className={styles.close} aria-label={t("common.close")} />}>
        <img src="/piko/world/ui/piko-world-close-icon-v1.png" alt="" draggable={false} />
      </DialogClose>
    </DialogContent>
  </Dialog>;
}
