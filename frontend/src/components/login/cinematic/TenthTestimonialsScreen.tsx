import type { CSSProperties } from "react";
import styles from "./tenth-testimonials-screen.module.css";

const quotes = [
  {
    name: "短片导演",
    tag: "概念预演",
    text: "不再从空白时间线开始。先看冲突和镜头，再决定哪条分支值得进入制作。",
  },
  {
    name: "AI 视频创作者",
    tag: "连续片段",
    text: "最有用的不是生成一张图，而是把一个片段继续往前推。",
  },
  {
    name: "编剧",
    tag: "角色测试",
    text: "角色、冲突和场景被拆开后，我能更快判断故事有没有继续写的价值。",
  },
  {
    name: "动画团队",
    tag: "节奏验证",
    text: "我们先用它做概念预演，看节奏和镜头，再决定是否进入正式制作。",
  },
  {
    name: "独立制片",
    tag: "预告生成",
    text: "它把想法压成可以被观看的片段，讨论不再停在文字设定里。",
  },
  {
    name: "视觉导演",
    tag: "世界观扩展",
    text: "同一个世界可以不断长出分支，失控感被保留，但方向仍然可控。",
  },
  {
    name: "故事策划",
    tag: "分支选择",
    text: "我用它快速排除无效分支，把时间留给真正有张力的那条线。",
  },
  {
    name: "创意工作室",
    tag: "提案样片",
    text: "从一句设定到可看的片段，足够支撑一次更具体的创意讨论。",
  },
  {
    name: "导演助理",
    tag: "镜头梳理",
    text: "它让镜头不再散落。每次生成，都能回到一条可继续推进的轨道上。",
  },
];

const rows = [
  quotes.slice(0, 6),
  quotes.slice(3).concat(quotes.slice(0, 3)),
  quotes.slice(6).concat(quotes.slice(0, 6)),
];

export function TenthTestimonialsScreen({
  exitProgress = 0,
  progress,
}: {
  exitProgress?: number;
  progress: number;
}) {
  if (exitProgress >= 0.99) return null;

  if (progress <= 0.01) return null;

  const visible = Math.max(0, progress * (1 - exitProgress));
  const style = {
    "--tenth-opacity": visible,
    "--tenth-offset": `${(1 - progress) * 34 - exitProgress * 28}px`,
    "--tenth-blur": `${exitProgress * 8}px`,
  } as CSSProperties;

  return (
    <section className={styles.layer} style={style}>
      <div className={styles.header}>
        <p>FIELD NOTES 10</p>
        <h2>不再从空白开始</h2>
        <span>概念短片、角色测试、连续片段，正在从一句设定直接进入生产线。</span>
      </div>

      <div className={styles.wall} aria-label="Creator feedback">
        {rows.map((row, rowIndex) => (
          <div
            className={`${styles.row} ${rowIndex === 1 ? styles.rowReverse : ""}`}
            key={rowIndex}
          >
            {[...row, ...row].map((quote, index) => (
              <article className={styles.card} key={`${quote.name}-${rowIndex}-${index}`}>
                <div className={styles.cardTop}>
                  <span>{quote.name}</span>
                  <em>{quote.tag}</em>
                </div>
                <p>{quote.text}</p>
              </article>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
