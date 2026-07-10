import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import styles from "./fifth-screen-video.module.css";
import { cinematicVideos } from "./media";

export function FifthScreenVideo({
  exitProgress = 0,
  isActive,
  textProgress,
  videoDimProgress,
  videoOpacity,
}: {
  exitProgress?: number;
  isActive: boolean;
  textProgress: number;
  videoDimProgress: number;
  videoOpacity: number;
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

  if (exitProgress >= 0.99) return null;

  const sceneStyle = {
    "--fifth-copy-blur": "0px",
    "--fifth-copy-opacity": Math.min(1, textProgress * 3) * (1 - exitProgress),
    "--fifth-copy-offset": `${(1 - textProgress) * 46 + exitProgress * -8}vh`,
    "--fifth-video-brightness": 0.9 - videoDimProgress * 0.26,
    "--fifth-video-opacity": videoOpacity * (1 - exitProgress),
    "--fifth-video-saturate": 0.92 - videoDimProgress * 0.2,
  } as CSSProperties;

  return (
    <section className={styles.layer} style={sceneStyle}>
      <video
        ref={videoRef}
        className={styles.video}
        src={cinematicVideos.cs}
        muted
        loop
        playsInline
        preload="auto"
      />
      <div className={styles.scrim} aria-hidden="true" />
      <div className={styles.copy}>
        <h2>把万千灵感沉淀为资产</h2>
        <p className={styles.body}>
          DramaClaw 把它们整理成项目资产库，
          让后续镜头生成可以持续引用、统一维护、必要时回滚版本。
        </p>
      </div>
    </section>
  );
}
