import { useState, type CSSProperties } from "react";
import { Plus } from "lucide-react";
import loginStyles from "@/components/login/login.module.css";
import SideRays from "@/components/react-bits/side-rays";
import styles from "./eleventh-faq-screen.module.css";
import { businessWechatQrUrl } from "./media";

const faqs = [
  {
    question: "DramaClaw 和普通 AI 视频生成工具有什么区别？",
    answer:
      "普通工具通常围绕一次提示词、一个片段或一张图工作。DramaClaw 面向的是完整项目：从文本导入、资产沉淀、剧集规划、镜头制作到合成导出，形成可追踪、可协作、可复用的生产闭环。",
  },
  {
    question: "第一次使用应该从哪里开始？",
    answer:
      "建议先走主线工作流：虾料导入文本，虾塘确认角色/场景/道具/声线，虾镜规划剧集并生成脚本和镜头，最后进入合成页导出成片。第一次目标不是做完美，而是先跑通一集。",
  },
  {
    question: "虾镜和虾画分别适合做什么？",
    answer:
      "虾镜是主生产线，适合批量、稳定、按剧集推进；虾画是导演工作台，适合关键镜头精修、多版本探索、资产定稿和复杂视频处理。正式项目通常是普通镜头走虾镜，难镜头进虾画。",
  },
  {
    question: "虾画里的结果会自动覆盖主线资产吗？",
    answer:
      "不会。虾画里的生成或上传内容默认是候选结果。只有明确点击写回，并选择角色、场景、道具、Beat 草图、首帧或视频等目标槽位后，结果才会进入正式项目主线。",
  },
  {
    question: "为什么要先整理角色、场景、道具和声线？",
    answer:
      "AI 视频创作最容易返工的原因，往往不是最后一步视频生成，而是前面的角色不稳定、场景不清楚、道具缺参考、声线没统一。虾塘把这些内容先变成资产，可以显著减少后续镜头阶段的混乱。",
  },
  {
    question: "DramaClaw 适合哪些内容类型？",
    answer:
      "适合 AI 短剧、漫剧、小说推文、解说剧、广告宣传、教育培训视频，以及需要长期维护 IP 角色和系列内容的团队项目。个人创作者可以用它跑通流程，团队可以用它协作生产。",
  },
  {
    question: "团队协作时应该怎么分工？",
    answer:
      "建议按环节分工：负责人管理项目、成本和质检；编剧处理文本和脚本；美术维护角色、场景和道具；分镜/导演负责镜头表现；视频操作处理首帧、视频和合成。权限上可按查看者、编辑者、管理员和所有者分配。",
  },
  {
    question: "生成效果不稳定时应该先检查什么？",
    answer:
      "先检查问题出在哪个环节：文本是否清楚，角色身份是否正确，场景和道具是否有参考，草图是否讲清楚镜头，首帧是否稳定，音频是否匹配。不要一开始就反复生成视频，先把上游资产和镜头描述修正好。",
  },
  {
    question: "什么是 “Make Your DC Universe.”？",
    answer:
      "DC 不只是 DramaClaw 的缩写，也代表每个创作者自己的内容宇宙。DramaClaw 希望帮助创作者从一个故事开始，逐步建立角色、世界观、场景资产和系列化内容生产能力。",
  },
  {
    question: "登录后我会进入哪里？",
    answer:
      "登录后会进入项目管理中心。你可以打开已有项目，也可以新建项目开始新的剧集。每个项目都是独立空间，包含文本、资产、剧集、镜头、视频、任务和合成结果。",
  },
];

export function EleventhFaqScreen({
  exitProgress = 0,
  progress,
}: {
  exitProgress?: number;
  progress: number;
}) {
  const [openIndex, setOpenIndex] = useState(-1);

  if (exitProgress >= 0.99) return null;
  if (progress <= 0.01) return null;

  const style = {
    "--faq-opacity": progress * (1 - exitProgress),
    "--faq-offset": `${(1 - progress) * 34 - exitProgress * 28}px`,
    "--faq-blur": `${exitProgress * 7}px`,
  } as CSSProperties;

  return (
    <section className={styles.layer} style={style}>
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
      <div className={styles.inner}>
        <header className={styles.header}>
          <h2>问题，直接回答</h2>
          <span>关于生成、控制、协作和商务接入，这里只保留真正会影响判断的问题。</span>
        </header>

        <div className={styles.list}>
          {faqs.map((item, index) => {
            const isOpen = openIndex === index;
            return (
              <article
                className={`${styles.item} ${isOpen ? styles.itemOpen : ""}`}
                key={item.question}
              >
                <button
                  type="button"
                  className={styles.question}
                  aria-expanded={isOpen}
                  onClick={() => {
                    setOpenIndex(isOpen ? -1 : index);
                  }}
                >
                  <span>{item.question}</span>
                  <Plus aria-hidden="true" />
                </button>
                <div className={styles.answer} aria-hidden={!isOpen}>
                  <div className={styles.answerInner}>
                    <p>{item.answer}</p>
                  </div>
                </div>
              </article>
            );
          })}
        </div>

        <div className={styles.footer}>
          <p>还有具体合作问题？</p>
          <div className={`${loginStyles.businessWechat} ${styles.contactHover}`}>
            <button
              type="button"
              className={`${loginStyles.businessWechatTrigger} ${styles.contactButton}`}
              aria-label="打开商务联系"
            >
              联系商务
            </button>
            <div
              className={`${loginStyles.businessWechatPopover} ${styles.contactPopover}`}
              role="dialog"
              aria-label="商务联系"
            >
              <div className={`${loginStyles.businessWechatPanel} ${styles.contactPanel}`}>
                <img
                  className={styles.contactQr}
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
