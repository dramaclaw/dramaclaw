// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Link } from "@tanstack/react-router";
import { useRef, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { loginCommunityWorks, type LoginCommunityWork } from "@/lib/login-community";
import styles from "./login.module.css";

function CommunityCard({ work }: { work: LoginCommunityWork }) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const style = { "--work-gradient": work.gradient } as CSSProperties;

  const handleMouseEnter = () => {
    const video = videoRef.current;
    if (!video) return;
    void video.play();
  };

  const handleMouseLeave = () => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.currentTime = 0;
  };

  return (
    <Link
      className={styles.communityCard}
      style={style}
      to="/watch/$work"
      params={{ work: work.id }}
      aria-label={t("auth.community.openWork", { title: work.title })}
    >
      <div
        className={styles.communityCover}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div className={styles.communityPoster} aria-hidden="true" />
        {work.cover ? (
          <img
            className={styles.communityImage}
            src={work.cover}
            alt=""
            loading="lazy"
            aria-hidden="true"
          />
        ) : null}
        {work.preview ? (
          <video
            ref={videoRef}
            className={styles.communityVideo}
            // Lazy-loaded so the clip only downloads on hover; the OSS cover is
            // what shows while idle. `preload="none"` avoids fetching the full
            // video up front.
            src={work.preview}
            muted
            loop
            playsInline
            preload="none"
            aria-hidden="true"
          />
        ) : null}
        <div className={styles.communityCoverShade} aria-hidden="true" />
      </div>
      <h2 className={styles.communityTitle}>{work.title}</h2>
      {work.description ? (
        <p className={styles.communityDescription}>{work.description}</p>
      ) : null}
    </Link>
  );
}

export function CommunityShowcase() {
  const { t } = useTranslation();

  return (
    <section className={styles.communitySection} aria-label={t("auth.community.label")}>
      <h2 className={styles.communityHeading}>{t("auth.community.heading")}</h2>
      <div className={styles.communityGrid}>
        {loginCommunityWorks.map((work) => (
          <CommunityCard key={work.id} work={work} />
        ))}
      </div>
    </section>
  );
}
