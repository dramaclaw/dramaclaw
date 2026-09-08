// SPDX-License-Identifier: Elastic-2.0
import type { PikoViewportFit } from "./runtime/viewport-fit";
import { PIKO_MAYOR_POSITION } from "./runtime/mayor-idle";
import styles from "./piko-mayor.module.css";
import { useTranslation } from "react-i18next";

// Fixed silhouette, independent of the browser's font and text-stroke rendering.
const QUESTION_OUTLINE = "M5 9C5 4.5 8.6 2 14 2C19.5 2 23 5 23 9.5C23 13 21 15 18 17C16.7 17.9 16.5 18.7 16.5 21H11C11 17 11.8 15.4 14.7 13.4C16.5 12.1 17.5 11.2 17.5 9.5C17.5 7.8 16.2 7 14 7C11.8 7 10.5 7.9 10.5 9.8Z M16.8 26.4A2.8 2.8 0 1 1 11.2 26.4A2.8 2.8 0 1 1 16.8 26.4Z";

export function PikoMayor({ fit, showHint, onInteract, onHover }: { fit: PikoViewportFit; showHint: boolean; onInteract?:()=>void; onHover?:(hovered:boolean)=>void }) {
  const { t } = useTranslation();
  return (
    <div className={styles.anchor} data-testid="piko-mayor"
      style={{ transform: `translate(${fit.x + PIKO_MAYOR_POSITION.x * fit.scale}px, ${fit.y + PIKO_MAYOR_POSITION.y * fit.scale}px) scale(${fit.scale})` }}>
      {onInteract && <button type="button" aria-label={t("pikoWorld.talkToMayor")} onClick={onInteract}
        onPointerEnter={()=>onHover?.(true)} onPointerLeave={()=>onHover?.(false)}
        className="pointer-events-auto absolute -left-10 -top-24 h-24 w-20 cursor-pointer bg-transparent focus-visible:outline-2 focus-visible:outline-ring" />}
      {showHint && (
        <span className={styles.hint} data-testid="piko-mayor-hint" aria-hidden="true">
          <svg viewBox="0 0 28 32" width="28" height="32" focusable="false" className={styles.hintGraphic}>
            <path d={QUESTION_OUTLINE} className={styles.hintGlow} />
            <path d={QUESTION_OUTLINE} className={styles.hintOutline} strokeWidth="1.3" strokeLinejoin="round" />
          </svg>
        </span>
      )}
    </div>
  );
}
