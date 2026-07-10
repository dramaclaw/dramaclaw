import type { CSSProperties } from "react";
import SideRays from "@/components/react-bits/side-rays";
import styles from "./fourth-screen.module.css";

const copySets = [
  {
    kicker: "SYSTEM 01",
    title: ["故事进入", "生产状态"],
    lead: "从一句设定开始，人物、冲突、场景和镜头被拆成可继续推进的创作资产。",
  },
  {
    kicker: "SYSTEM 02",
    title: ["世界观保持", "同一种冷光"],
    lead: "角色不会散，镜头不会跑偏。每一次生成，都回到同一个叙事方向。",
  },
  {
    kicker: "SYSTEM 03",
    title: ["灵感被推进", "成影像"],
    lead: "不是停在一张图，而是继续长出分镜、片段、预告和可以发布的作品。",
  },
];

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
        <SideRays
          className={styles.rays}
          speed={2.5}
          rayColor1="#eab308"
          rayColor2="#96c8ff"
          intensity={2}
          spread={2}
          origin="top-right"
          tilt={0}
          saturation={1.5}
          blend={0.75}
          falloff={1.6}
          opacity={1}
        />
      ) : null}
      <div className={styles.inner}>
        <div className={styles.copyArea}>
          {copySets.map((copy, index) => {
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
                  {copy.title.map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                </h2>
                <p className={styles.lead}>{copy.lead}</p>
              </div>
            );
          })}
        </div>

        <div className={styles.grid} aria-label="DramaClaw creator workflow">
          <article className={`${styles.item} ${activeIndex === 0 ? styles.itemActive : ""}`}>
            <span className={styles.number}>01</span>
            <h3>故事拆解</h3>
            <p>把想法切成角色、冲突、场景和镜头，不让故事停在一句话。</p>
          </article>
          <article className={`${styles.item} ${activeIndex === 1 ? styles.itemActive : ""}`}>
            <span className={styles.number}>02</span>
            <h3>视觉锁定</h3>
            <p>让角色、场景和镜头维持同一种气质，减少随机生成的失控感。</p>
          </article>
          <article className={`${styles.item} ${activeIndex === 2 ? styles.itemActive : ""}`}>
            <span className={styles.number}>03</span>
            <h3>影像推进</h3>
            <p>从单张灵感继续向前，生成片段、预告和更完整的作品形态。</p>
          </article>
        </div>
      </div>
    </section>
  );
}
