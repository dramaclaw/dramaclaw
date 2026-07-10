import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import styles from "./scroll-video-scene.module.css";
import { COMMUNITY_WATCH_WORK } from "./watch-link";

export function ScrollVideoScene({
  align = "left",
  copyProgress,
  copyExitProgress = 0,
  isActive,
  kicker,
  layerBackdropOpacity = 0,
  subtitle,
  title,
  videoExitProgress = 0,
  videoOpacity,
  videoUrl,
}: {
  align?: "left" | "right";
  copyProgress: number;
  copyExitProgress?: number;
  isActive: boolean;
  kicker: string;
  layerBackdropOpacity?: number;
  subtitle: string;
  title: string;
  videoExitProgress?: number;
  videoOpacity: number;
  videoUrl: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wasActiveRef = useRef(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (isActive) {
      if (!wasActiveRef.current) {
        video.currentTime = 0;
      }
      void video.play().catch(() => {
        /* 静默失败：浏览器可能在极端情况下拒绝自动播放。 */
      });
    } else {
      video.pause();
    }

    wasActiveRef.current = isActive;
  }, [isActive]);

  if (copyExitProgress >= 0.99 && videoExitProgress >= 0.99) return null;

  const renderedVideoOpacity = Math.max(0, videoOpacity * (1 - videoExitProgress));
  const sceneStyle = {
    "--copy-blur": `${copyExitProgress * 6}px`,
    "--copy-opacity": Math.max(0, copyProgress * (1 - copyExitProgress)),
    "--copy-offset": `${(1 - copyProgress) * 26 - copyExitProgress * 24}px`,
    "--layer-backdrop-opacity": layerBackdropOpacity,
    "--video-blur": `${videoExitProgress * 7}px`,
    "--video-exit-scale": 1 + videoExitProgress * 0.035,
    "--video-filter-brightness": 0.88 - videoExitProgress * 0.28,
    "--video-filter-saturate": 0.94 - videoExitProgress * 0.22,
    "--video-opacity": renderedVideoOpacity,
    pointerEvents: renderedVideoOpacity > 0.16 ? "auto" : "none",
  } as CSSProperties;

  return (
    <div className={styles.layer} style={sceneStyle}>
      <video
        ref={videoRef}
        className={styles.video}
        src={videoUrl}
        muted
        loop
        playsInline
        preload="auto"
      />
      <div
        className={`${styles.scrim} ${align === "right" ? styles.scrimRight : ""}`}
        aria-hidden="true"
      />
      <a
        className={styles.watchButton}
        href={`/watch/${COMMUNITY_WATCH_WORK}`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="立即观看社区作品"
      >
        <span>立即观看</span>
      </a>
      <div className={`${styles.copy} ${align === "right" ? styles.copyRight : ""}`}>
        <p className={styles.kicker}>{kicker}</p>
        <h2 className={styles.title}>{title}</h2>
        <p className={styles.subtitle}>{subtitle}</p>
      </div>
    </div>
  );
}
