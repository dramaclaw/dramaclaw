import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import styles from "./tenth-testimonials-screen.module.css";

const QUOTE_IDS = [
  "shortFilmDirector",
  "aiCreator",
  "screenwriter",
  "animationTeam",
  "indieProducer",
  "visualDirector",
  "storyPlanner",
  "creativeStudio",
  "directorAssistant",
];

const rows = [
  QUOTE_IDS.slice(0, 6),
  QUOTE_IDS.slice(3).concat(QUOTE_IDS.slice(0, 3)),
  QUOTE_IDS.slice(6).concat(QUOTE_IDS.slice(0, 6)),
];

export function TenthTestimonialsScreen({
  exitProgress = 0,
  progress,
}: {
  exitProgress?: number;
  progress: number;
}) {
  const { t } = useTranslation();

  if (exitProgress >= 0.99) return null;

  if (progress <= 0.01) return null;

  const visible = Math.max(0, progress * (1 - exitProgress));
  const style = {
    "--tenth-opacity": visible,
    "--tenth-offset": `${(1 - progress) * 34 - exitProgress * 28}px`,
    "--tenth-blur": `${exitProgress * 8}px`,
  } as CSSProperties;

  return (
    <section className={styles.layer} style={style}>
      <div className={styles.header}>
        <p>FIELD NOTES 10</p>
        <h2>{t("loginCinematic.testimonials.heading")}</h2>
        <span>{t("loginCinematic.testimonials.subheading")}</span>
      </div>

      <div className={styles.wall} aria-label="Creator feedback">
        {rows.map((row, rowIndex) => (
          <div
            className={`${styles.row} ${rowIndex === 1 ? styles.rowReverse : ""}`}
            key={rowIndex}
          >
            {[...row, ...row].map((quoteId, index) => (
              <article className={styles.card} key={`${quoteId}-${rowIndex}-${index}`}>
                <div className={styles.cardTop}>
                  <span>{t(`loginCinematic.testimonials.quotes.${quoteId}.name`)}</span>
                  <em>{t(`loginCinematic.testimonials.quotes.${quoteId}.tag`)}</em>
                </div>
                <p>{t(`loginCinematic.testimonials.quotes.${quoteId}.text`)}</p>
              </article>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
