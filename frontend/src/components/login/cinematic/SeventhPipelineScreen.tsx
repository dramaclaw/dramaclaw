import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import DarkVeil from "@/components/react-bits/dark-veil";
import styles from "./seventh-pipeline-screen.module.css";

const steps = ["01", "02", "03", "04", "05", "06"];

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

export function SeventhPipelineScreen({
  progress,
  sequenceProgress,
  exitProgress = 0,
  shouldMount = false,
}: {
  progress: number;
  sequenceProgress: number;
  exitProgress?: number;
  shouldMount?: boolean;
}) {
  if (exitProgress >= 0.99) return null;
  if (!shouldMount && progress <= 0.01) return null;

  const { t } = useTranslation();
  const activeIndex = Math.min(steps.length - 1, Math.floor(sequenceProgress * steps.length));
  const style = {
    "--seventh-opacity": progress * (1 - exitProgress),
    "--seventh-offset": `${(1 - progress) * 38 - exitProgress * 26}px`,
    "--seventh-blur": `${exitProgress * 7}px`,
    "--pipeline-scale": clamp(sequenceProgress),
  } as CSSProperties;

  return (
    <section className={styles.layer} style={style}>
      <div className={styles.darkVeilBackdrop} aria-hidden="true">
        <DarkVeil
          speed={1}
          hueShift={40}
          noiseIntensity={0}
          scanlineFrequency={0.5}
          scanlineIntensity={0}
          warpAmount={0}
        />
      </div>

      <div className={styles.header}>
        <p>PIPELINE 07</p>
        <h2>{t("loginCinematic.seventh.heading")}</h2>
        <span>
          {t("loginCinematic.seventh.lead")}
        </span>
      </div>

      <div className={styles.pipeline} aria-label="DramaClaw production pipeline">
        <div className={styles.track} aria-hidden="true" />
        <div className={styles.trackFill} aria-hidden="true" />
        {steps.map((stepId, index) => {
          const nodeProgress = clamp((sequenceProgress - index * 0.135) / 0.18);
          const isActive = index <= activeIndex;

          return (
            <article
              className={`${styles.step} ${isActive ? styles.stepActive : ""}`}
              key={stepId}
              style={{ "--node-progress": nodeProgress } as CSSProperties}
            >
              <div className={styles.node}>
                <span>{stepId}</span>
              </div>
              <h3>{t(`loginCinematic.seventh.steps.${stepId}.title`)}</h3>
              <p>{t(`loginCinematic.seventh.steps.${stepId}.body`)}</p>
            </article>
          );
        })}
      </div>
    </section>
  );
}
