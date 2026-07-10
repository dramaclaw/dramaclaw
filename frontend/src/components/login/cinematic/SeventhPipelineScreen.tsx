import type { CSSProperties } from "react";
import DarkVeil from "@/components/react-bits/dark-veil";
import styles from "./seventh-pipeline-screen.module.css";

const steps = [
  {
    id: "01",
    title: "设定输入",
    body: "一句开场被拆成角色、场景和叙事约束。",
  },
  {
    id: "02",
    title: "角色拆解",
    body: "身份、动机和关系先被锁住，后续生成不再漂移。",
  },
  {
    id: "03",
    title: "冲突生成",
    body: "把事件推到必须选择的位置，让故事自己升温。",
  },
  {
    id: "04",
    title: "镜头规划",
    body: "视角、节奏和画面方向进入同一条可控轨道。",
  },
  {
    id: "05",
    title: "片段成型",
    body: "单张灵感继续向前，长出场景、预告和连续片段。",
  },
  {
    id: "06",
    title: "作品扩展",
    body: "每个结果都能回到生产线，继续生成新的分支。",
  },
];

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
        <h2>让短剧生成从抽卡走向流程</h2>
        <span>
          DramaClaw 把 AI 视频创作中的不确定性拆解到文本、资产、镜头和任务流程中
        </span>
      </div>

      <div className={styles.pipeline} aria-label="DramaClaw production pipeline">
        <div className={styles.track} aria-hidden="true" />
        <div className={styles.trackFill} aria-hidden="true" />
        {steps.map((step, index) => {
          const nodeProgress = clamp((sequenceProgress - index * 0.135) / 0.18);
          const isActive = index <= activeIndex;

          return (
            <article
              className={`${styles.step} ${isActive ? styles.stepActive : ""}`}
              key={step.id}
              style={{ "--node-progress": nodeProgress } as CSSProperties}
            >
              <div className={styles.node}>
                <span>{step.id}</span>
              </div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </article>
          );
        })}
      </div>
    </section>
  );
}
