import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import styles from "./eighth-control-screen.module.css";

const decisions = ["KEEP", "REWRITE", "EXTEND", "REJECT"];

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

export function EighthControlScreen({
  progress,
  sequenceProgress,
  exitProgress = 0,
}: {
  progress: number;
  sequenceProgress: number;
  exitProgress?: number;
}) {
  const { t } = useTranslation();

  if (exitProgress >= 0.99) return null;

  if (progress <= 0.01) return null;

  const activeIndex = Math.min(
    decisions.length - 1,
    Math.floor(clamp(sequenceProgress) * decisions.length),
  );
  const style = {
    "--eighth-opacity": progress * (1 - exitProgress),
    "--eighth-offset": `${(1 - progress) * 34 - exitProgress * 28}px`,
    "--eighth-blur": `${exitProgress * 7}px`,
    "--rail-progress": clamp(sequenceProgress * 1.1),
    "--panel-progress": clamp((sequenceProgress - 0.12) / 0.58),
  } as CSSProperties;

  return (
    <section className={styles.layer} style={style}>
      <div className={styles.header}>
        <p>CONTROL 08</p>
        <h2>{t("loginCinematic.eighth.heading")}</h2>
        <span>{t("loginCinematic.eighth.lead")}</span>
      </div>

      <div className={styles.rail} aria-hidden="true">
        <span />
      </div>

      <div className={styles.console} aria-label="DramaClaw direction control">
        <div className={styles.consoleHeader}>
          <span>ACTIVE NODE</span>
          <strong>SCENE DIRECTION</strong>
          <em>READY</em>
        </div>

        <div className={styles.consoleBody}>
          <div className={styles.statement}>
            <small>CURRENT OUTPUT</small>
            <strong>{t("loginCinematic.eighth.statementTitle")}</strong>
            <p>{t("loginCinematic.eighth.statementBody")}</p>
          </div>

          <div className={styles.decisionGrid}>
            {decisions.map((decisionId, index) => {
              const itemProgress = clamp((sequenceProgress - index * 0.16) / 0.32);
              const isActive = index <= activeIndex;

              return (
                <article
                  className={`${styles.decision} ${isActive ? styles.decisionActive : ""}`}
                  key={decisionId}
                  style={{ "--item-progress": itemProgress } as CSSProperties}
                >
                  <div>
                    <span>{decisionId}</span>
                    <h3>{t(`loginCinematic.eighth.decisions.${decisionId}.title`)}</h3>
                  </div>
                  <p>{t(`loginCinematic.eighth.decisions.${decisionId}.body`)}</p>
                </article>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
