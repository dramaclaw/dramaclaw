import type { CSSProperties } from "react";
import styles from "./sixth-showcase-screen.module.css";
import { cinematicVideoLibrary } from "./media";
import { COMMUNITY_WATCH_WORK } from "./watch-link";

const works = cinematicVideoLibrary;

function FilmShowcase({ sequenceProgress }: { sequenceProgress: number }) {
  const translate = -sequenceProgress * 155;

  return (
    <div className={styles.filmStage}>
      <div className={styles.filmRail} style={{ "--film-shift": `${translate}vw` } as CSSProperties}>
        {works.map((work) => (
          <article className={styles.filmCard} key={work.id}>
            <div className={styles.filmMedia}>
              <video src={work.video} muted loop playsInline autoPlay preload="metadata" />
              <div className={styles.cardScrim} />
            </div>
            <div className={styles.filmMeta}>
              <span>{work.type}</span>
              <span>{work.stat}</span>
            </div>
            <div className={styles.filmCopy}>
              <h3>{work.title}</h3>
              <p>{work.logline}</p>
            </div>
            <a
              className={styles.watchButton}
              href={`/watch/${COMMUNITY_WATCH_WORK}`}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="立即观看社区作品"
            >
              <span>立即观看</span>
            </a>
          </article>
        ))}
      </div>
    </div>
  );
}

export function SixthShowcaseScreen({
  exitProgress = 0,
  progress,
  sequenceProgress,
}: {
  exitProgress?: number;
  progress: number;
  sequenceProgress: number;
}) {
  if (exitProgress >= 0.99) return null;
  if (progress <= 0.01) return null;

  const style = {
    "--sixth-opacity": progress * (1 - exitProgress),
    "--sixth-offset": `${(1 - progress) * 42 - exitProgress * 24}px`,
    "--sixth-blur": `${exitProgress * 8}px`,
    pointerEvents: progress > 0.5 && exitProgress < 0.12 ? "auto" : "none",
  } as CSSProperties;

  return (
    <section className={styles.layer} style={style}>
      <div className={styles.header}>
        <p>SHOWCASE 06</p>
        <h2>让每一帧继续失控</h2>
        <span>滚轮推开时间线，角色、冲突和镜头被逐格接管，直到片段长成新的世界。</span>
      </div>

      <FilmShowcase sequenceProgress={sequenceProgress} />
    </section>
  );
}
