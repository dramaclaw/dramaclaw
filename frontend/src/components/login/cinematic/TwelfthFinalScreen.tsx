import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import LightRays from "@/components/login/light-rays";
import { LoginCinematicHeader } from "./LoginCinematicHero";
import { businessWechatQrUrl } from "./media";
import styles from "./twelfth-final-screen.module.css";

export function TwelfthFinalScreen({
  onStart,
  progress,
}: {
  onStart: () => void;
  progress: number;
}) {
  const { t } = useTranslation();

  if (progress <= 0.01) return null;

  const style = {
    "--final-opacity": progress,
    "--final-offset": `${(1 - progress) * 34}px`,
  } as CSSProperties;

  return (
    <section className={styles.layer} style={style}>
      <LightRays
        className={styles.background}
        raysOrigin="top-center"
        raysColor="#ffffff"
        raysSpeed={1}
        lightSpread={0.5}
        rayLength={3}
        pulsating={false}
        fadeDistance={1}
        saturation={1}
        followMouse={false}
        mouseInfluence={0.1}
        noiseAmount={0}
        distortion={0}
      />
      <LoginCinematicHeader className={styles.header} />
      <div className={styles.content}>
        <img
          className={styles.mark}
          src="/login-cinematic/final-mark.png"
          alt=""
          draggable={false}
          aria-hidden="true"
        />
        <h2>{t("loginCinematic.twelfth.heading")}</h2>
        <p>{t("loginCinematic.twelfth.lead")}</p>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} onClick={onStart}>
            {t("loginCinematic.twelfth.primaryCta")}
          </button>
          <div className={styles.business}>
            <button type="button" className={styles.secondary}>
              {t("loginCinematic.twelfth.secondaryCta")}
            </button>
            <div
              className={styles.businessPopover}
              role="dialog"
              aria-label={t("loginCinematic.faq.contactLabel")}
            >
              <div className={styles.businessPanel}>
                <img
                  src={businessWechatQrUrl}
                  alt={t("loginCinematic.faq.qrAlt")}
                  draggable={false}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
