import { useState, type CSSProperties } from "react";
import { Plus } from "lucide-react";
import loginStyles from "@/components/login/login.module.css";
import SideRays from "@/components/react-bits/side-rays";
import styles from "./eleventh-faq-screen.module.css";

const faqs = [
  {
    question: "DramaClaw 最终会生成什么？",
    answer:
      "它不是只给一张图或一段孤立素材，而是把设定拆成角色、冲突、镜头和可继续推进的片段，让故事从第一步就能被观看和判断。",
  },
  {
    question: "必须先写完整剧本吗？",
    answer:
      "不需要。你可以从一句方向开始，系统会先建立可推进的结构，再让你决定保留、重写、延展或推翻。",
  },
  {
    question: "生成后还能继续控制方向吗？",
    answer:
      "可以。每一次生成都不是终点，而是新的节点；你可以锁定角色、替换冲突、调整镜头，继续把片段推向下一场。",
  },
  {
    question: "它更适合个人还是团队？",
    answer:
      "两者都适合。个人可以用它快速验证想法，团队可以用它把概念讨论提前变成可看的样片和镜头依据。",
  },
  {
    question: "能不能接入现有制作流程？",
    answer:
      "可以作为前期创意、概念预演和片段验证工具使用。正式制作前，先用它筛掉没有张力的分支。",
  },
  {
    question: "商务合作怎么联系？",
    answer:
      "点击下方联系商务，右侧会弹出商务二维码。适合团队授权、定制流程、内容合作或私有化部署沟通。",
  },
  {
    question: "生成结果可以继续扩写吗？",
    answer:
      "可以。每个片段都可以继续向后延展，也可以回到上一节点重选方向，避免故事被一次生成锁死。",
  },
  {
    question: "能否保留固定角色和世界观？",
    answer:
      "可以把角色、气质和世界规则作为持续约束，让后续镜头在同一条叙事轨道里推进。",
  },
  {
    question: "适合做预告片还是正片？",
    answer:
      "更适合前期预演、概念短片、预告片和连续片段验证。正片制作前，可以先用它确定方向和镜头结构。",
  },
  {
    question: "能不能多人协作评审？",
    answer:
      "可以把生成节点作为讨论对象，团队围绕角色、冲突、镜头和分支做更具体的判断。",
  },
  {
    question: "如果生成方向不满意怎么办？",
    answer:
      "可以重写、推翻或回到上一节点，不需要从零开始重做整条故事线。",
  },
  {
    question: "后续会支持更多格式吗？",
    answer:
      "会围绕片段、预告、作品墙和生产线继续扩展，重点是保持故事可以持续向前推进。",
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
                  src="/contact/business-wechat-qr.png"
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
