import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import DarkVeil from "@/components/react-bits/dark-veil";
import styles from "./ninth-workflow-screen.module.css";
import { cinematicVideos } from "./media";
import { COMMUNITY_WATCH_WORK } from "./watch-link";

const workflow = [
  { id: "01", label: "INPUT" },
  { id: "02", label: "STRUCTURE" },
  { id: "03", label: "CAMERA" },
  { id: "04", label: "OUTPUT" },
];

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

export function NinthWorkflowScreen({
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

  const style = {
    "--ninth-opacity": progress * (1 - exitProgress),
    "--ninth-offset": `${(1 - progress) * 34 - exitProgress * 28}px`,
    "--ninth-blur": `${exitProgress * 7}px`,
    "--path-progress": clamp(sequenceProgress * 1.08),
    "--preview-progress": clamp((sequenceProgress - 0.64) / 0.36),
  } as CSSProperties;

  return (
    <section className={styles.layer} style={style}>
      <div className={styles.darkVeilBackdrop} aria-hidden="true">
        <DarkVeil
          speed={1}
          hueShift={50}
          noiseIntensity={0}
          scanlineFrequency={0.5}
          scanlineIntensity={0}
          warpAmount={0}
        />
      </div>

      <div className={styles.header}>
        <p>WORKFLOW 09</p>
        <h2>
          {t("loginCinematic.ninth.headingTop")}
          <br />
          {t("loginCinematic.ninth.headingAccent")}
        </h2>
        <span>{t("loginCinematic.ninth.lead")}</span>
      </div>

      <div className={styles.path} aria-hidden="true">
        <span />
      </div>

      <div className={styles.workflow} aria-label="DramaClaw workflow from prompt to clip">
        {workflow.map((item, index) => {
          const itemProgress = clamp((sequenceProgress - index * 0.18) / 0.34);
          const isOutput = index === workflow.length - 1;
          const isActive = itemProgress > 0.45;

          return (
            <article
              className={`${styles.step} ${isActive ? styles.stepActive : ""} ${
                isOutput ? styles.stepOutput : ""
              }`}
              key={item.label}
              style={{ "--node-progress": itemProgress } as CSSProperties}
            >
              {isOutput ? (
                <div className={styles.preview}>
                  <div className={styles.previewFrame}>
                    <video src={cinematicVideos.pk} muted loop playsInline autoPlay preload="metadata" />
                    <div className={styles.previewScrim} />
                    <div className={styles.previewTitle}>
                      <strong>{t("loginCinematic.ninth.featuredWork")}</strong>
                    </div>
                    <a
                      className={styles.watchButton}
                      href={`/watch/${COMMUNITY_WATCH_WORK}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={t("loginCinematic.watchCommunity")}
                    >
                      <span>{t("loginCinematic.watchNow")}</span>
                    </a>
                  </div>
                </div>
              ) : null}
              <div className={styles.node}>
                <span>{item.id}</span>
              </div>
              <h3>{t(`loginCinematic.ninth.steps.${item.id}.title`)}</h3>
              <p>{t(`loginCinematic.ninth.steps.${item.id}.body`)}</p>
            </article>
          );
        })}
      </div>
    </section>
  );
}
