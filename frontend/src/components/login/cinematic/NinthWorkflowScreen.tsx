import type { CSSProperties } from "react";
import DarkVeil from "@/components/react-bits/dark-veil";
import styles from "./ninth-workflow-screen.module.css";
import { cinematicVideos } from "./media";
import { COMMUNITY_WATCH_WORK } from "./watch-link";

const workflow = [
  {
    id: "01",
    label: "INPUT",
    title: "一句设定",
    body: "失联城市重新发光，幸存者同时听见同一个倒计时。",
  },
  {
    id: "02",
    label: "STRUCTURE",
    title: "拆成结构",
    body: "角色、冲突、场景和叙事限制被拆开，进入可继续推进的节点。",
  },
  {
    id: "03",
    label: "CAMERA",
    title: "形成镜头",
    body: "镜头顺序、场景气质和节奏被锁定，片段开始具备观看方向。",
  },
  {
    id: "04",
    label: "OUTPUT",
    title: "片段生成",
    body: "一段可以继续扩写、重剪或进入作品墙的故事片段完成。",
  },
];

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

export function NinthWorkflowScreen({
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

  const style = {
    "--ninth-opacity": progress * (1 - exitProgress),
    "--ninth-offset": `${(1 - progress) * 34 - exitProgress * 28}px`,
    "--ninth-blur": `${exitProgress * 7}px`,
    "--path-progress": clamp(sequenceProgress * 1.08),
    "--preview-progress": clamp((sequenceProgress - 0.64) / 0.36),
  } as CSSProperties;

  return (
    <section className={styles.layer} style={style}>
      <div className={styles.darkVeilBackdrop} aria-hidden="true">
        <DarkVeil
          speed={1}
          hueShift={50}
          noiseIntensity={0}
          scanlineFrequency={0.5}
          scanlineIntensity={0}
          warpAmount={0}
        />
      </div>

      <div className={styles.header}>
        <p>WORKFLOW 09</p>
        <h2>
          一句设定，直接进入
          <br />
          镜头
        </h2>
        <span>
          不必先写完整剧本。给出一个方向，DramaClaw 会把它拆成角色、冲突、场景和可推进的镜头链路。
        </span>
      </div>

      <div className={styles.path} aria-hidden="true">
        <span />
      </div>

      <div className={styles.workflow} aria-label="DramaClaw workflow from prompt to clip">
        {workflow.map((item, index) => {
          const itemProgress = clamp((sequenceProgress - index * 0.18) / 0.34);
          const isOutput = index === workflow.length - 1;
          const isActive = itemProgress > 0.45;

          return (
            <article
              className={`${styles.step} ${isActive ? styles.stepActive : ""} ${
                isOutput ? styles.stepOutput : ""
              }`}
              key={item.label}
              style={{ "--node-progress": itemProgress } as CSSProperties}
            >
              {isOutput ? (
                <div className={styles.preview}>
                  <div className={styles.previewFrame}>
                    <video src={cinematicVideos.pk} muted loop playsInline autoPlay preload="metadata" />
                    <div className={styles.previewScrim} />
                    <div className={styles.previewTitle}>
                      <strong>鲁班秘术</strong>
                    </div>
                    <a
                      className={styles.watchButton}
                      href={`/watch/${COMMUNITY_WATCH_WORK}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="立即观看社区作品"
                    >
                      <span>立即观看</span>
                    </a>
                  </div>
                </div>
              ) : null}
              <div className={styles.node}>
                <span>{item.id}</span>
              </div>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          );
        })}
      </div>
    </section>
  );
}
