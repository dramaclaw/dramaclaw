import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { CinematicSideRays } from "./CinematicSideRays";
import styles from "./fourth-screen.module.css";

const COPY_SETS = [
  { id: "s1", kicker: "SYSTEM 01" },
  { id: "s2", kicker: "SYSTEM 02" },
  { id: "s3", kicker: "SYSTEM 03" },
];

const GRID_CARDS = ["breakdown", "lock", "advance"];

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

const segment = (position: number, start: number, duration: number) =>
  clamp((position - start) / duration);

export function FourthScreen({
  exitProgress = 0,
  progress,
  sequenceProgress,
}: {
  exitProgress?: number;
  progress: number;
  sequenceProgress: number;
}) {
  const { t } = useTranslation();

  if (exitProgress >= 0.99) return null;

  const activeIndex = Math.min(2, Math.floor(sequenceProgress * 3));
  const raysActive = progress > 0.02 && exitProgress < 0.98;
  const sceneStyle = {
    "--fourth-blur": `${(1 - progress) * 10 + exitProgress * 8}px`,
    "--fourth-offset": `${(1 - progress) * 34 - exitProgress * 28}px`,
    "--fourth-opacity": Math.max(0, progress * (1 - exitProgress)),
  } as CSSProperties;

  return (
    <section className={styles.layer} style={sceneStyle}>
      {raysActive ? (
        <CinematicSideRays className={styles.rays} />
      ) : null}
      <div className={styles.inner}>
        <div className={styles.copyArea}>
          {COPY_SETS.map((copy, index) => {
            const enter = segment(sequenceProgress, index / 3 - 0.04, 0.16);
            const exit = segment(sequenceProgress, (index + 0.78) / 3, 0.14);
            const copyOpacity = Math.max(0, enter * (1 - exit));
            const copyStyle = {
              "--copy-block-blur": `${(1 - copyOpacity) * 7}px`,
              "--copy-block-opacity": copyOpacity,
              "--copy-block-offset": `${(1 - enter) * 22 - exit * 18}px`,
            } as CSSProperties;

            return (
              <div className={styles.copyBlock} key={copy.kicker} style={copyStyle}>
                <p className={styles.kicker}>{copy.kicker}</p>
                <h2 className={styles.title}>
                  <span>{t(`loginCinematic.fourth.sets.${copy.id}.titleTop`)}</span>
                  <span>{t(`loginCinematic.fourth.sets.${copy.id}.titleBottom`)}</span>
                </h2>
                <p className={styles.lead}>{t(`loginCinematic.fourth.sets.${copy.id}.lead`)}</p>
              </div>
            );
          })}
        </div>

        <div className={styles.grid} aria-label="DramaClaw creator workflow">
          {GRID_CARDS.map((cardId, index) => (
            <article
              className={`${styles.item} ${activeIndex === index ? styles.itemActive : ""}`}
              key={cardId}
            >
              <span className={styles.number}>{`0${index + 1}`}</span>
              <h3>{t(`loginCinematic.fourth.cards.${cardId}.title`)}</h3>
              <p>{t(`loginCinematic.fourth.cards.${cardId}.body`)}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
