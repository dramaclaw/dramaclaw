// SPDX-License-Identifier: Elastic-2.0
import type { PikoViewportFit } from "./runtime/viewport-fit";
import { PIKO_MAYOR_POSITION } from "./runtime/mayor-idle";
import styles from "./piko-mayor.module.css";
import { useTranslation } from "react-i18next";

export function PikoMayor({ fit, showName, onInteract, onHover }: { fit: PikoViewportFit; showName: boolean; onInteract?:()=>void; onHover?:(hovered:boolean)=>void }) {
  const { t } = useTranslation();
  return (
    <div className={styles.anchor} data-testid="piko-mayor"
      style={{ transform: `translate(${fit.x + PIKO_MAYOR_POSITION.x * fit.scale}px, ${fit.y + PIKO_MAYOR_POSITION.y * fit.scale}px) scale(${fit.scale})` }}>
      {onInteract && <button type="button" aria-label={t("pikoWorld.talkToMayor")} onClick={onInteract}
        onPointerEnter={()=>onHover?.(true)} onPointerLeave={()=>onHover?.(false)}
        className="pointer-events-auto absolute -left-10 -top-24 h-24 w-20 cursor-pointer bg-transparent focus-visible:outline-2 focus-visible:outline-ring" />}
      {showName && (
        <span className={styles.name} data-testid="piko-mayor-name">
          {t("pikoWorld.chatMockMayorName")}
        </span>
      )}
    </div>
  );
}
