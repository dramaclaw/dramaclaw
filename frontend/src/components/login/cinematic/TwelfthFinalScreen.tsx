import type { CSSProperties } from "react";
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
        <h2>把一句设定推进成可看的宇宙</h2>
        <p>输入角色冲突或世界观 让 DramaClaw 拆成镜头节点并持续延展</p>
        <div className={styles.actions}>
          <button type="button" className={styles.primary} onClick={onStart}>
            开启无限创作
          </button>
          <div className={styles.business}>
            <button type="button" className={styles.secondary}>
              快速申请账号
            </button>
            <div
              className={styles.businessPopover}
              role="dialog"
              aria-label="商务联系"
            >
              <div className={styles.businessPanel}>
                <img
                  src={businessWechatQrUrl}
                  alt="商务微信二维码"
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
