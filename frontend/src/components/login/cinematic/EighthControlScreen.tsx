import type { CSSProperties } from "react";
import styles from "./eighth-control-screen.module.css";

const decisions = [
  {
    id: "KEEP",
    title: "保留",
    body: "锁定当前角色、镜头或片段，让它成为后续生成的基准。",
  },
  {
    id: "REWRITE",
    title: "重写",
    body: "只替换冲突、对白或镜头方向，不推翻已经成立的世界。",
  },
  {
    id: "EXTEND",
    title: "延展",
    body: "从当前片段继续向前，生成下一场、预告或完整分支。",
  },
  {
    id: "REJECT",
    title: "推翻",
    body: "回到上一个节点，换一条叙事路径，让故事重新进入生产线。",
  },
];

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

export function EighthControlScreen({
  progress,
  sequenceProgress,
  exitProgress = 0,
}: {
  progress: number;
  sequenceProgress: number;
  exitProgress?: number;
}) {
  if (exitProgress >= 0.99) return null;

  if (progress <= 0.01) return null;

  const activeIndex = Math.min(
    decisions.length - 1,
    Math.floor(clamp(sequenceProgress) * decisions.length),
  );
  const style = {
    "--eighth-opacity": progress * (1 - exitProgress),
    "--eighth-offset": `${(1 - progress) * 34 - exitProgress * 28}px`,
    "--eighth-blur": `${exitProgress * 7}px`,
    "--rail-progress": clamp(sequenceProgress * 1.1),
    "--panel-progress": clamp((sequenceProgress - 0.12) / 0.58),
  } as CSSProperties;

  return (
    <section className={styles.layer} style={style}>
      <div className={styles.header}>
        <p>CONTROL 08</p>
        <h2>只为创作完整的作品企划</h2>
        <span>
          DramaClaw 关注的是一部剧如何持续生产：文本入项，角色一致性，场景复用，镜头推进，团队协作交付。
        </span>
      </div>

      <div className={styles.rail} aria-hidden="true">
        <span />
      </div>

      <div className={styles.console} aria-label="DramaClaw direction control">
        <div className={styles.consoleHeader}>
          <span>ACTIVE NODE</span>
          <strong>SCENE DIRECTION</strong>
          <em>READY</em>
        </div>

        <div className={styles.consoleBody}>
          <div className={styles.statement}>
            <small>CURRENT OUTPUT</small>
            <strong>夜航协议 · 镜头序列 08</strong>
            <p>一艘未登记运输舰拖着整座城市的秘密进入夜层。</p>
          </div>

          <div className={styles.decisionGrid}>
            {decisions.map((decision, index) => {
              const itemProgress = clamp((sequenceProgress - index * 0.16) / 0.32);
              const isActive = index <= activeIndex;

              return (
                <article
                  className={`${styles.decision} ${isActive ? styles.decisionActive : ""}`}
                  key={decision.id}
                  style={{ "--item-progress": itemProgress } as CSSProperties}
                >
                  <div>
                    <span>{decision.id}</span>
                    <h3>{decision.title}</h3>
                  </div>
                  <p>{decision.body}</p>
                </article>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
