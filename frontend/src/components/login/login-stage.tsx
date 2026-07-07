// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CommunityShowcase } from "./community-showcase";
import LightRays from "./light-rays";
import SplitText from "@/components/react-bits/split-text";
import { useGithubStars } from "@/hooks/use-github-stars";
import { PRODUCT_MANUAL_URL } from "@/lib/product-manual";
import styles from "./login.module.css";

// 登录页右上角 GitHub 链接目标。如需指向具体仓库/主页，改这里即可。
const GITHUB_URL = "https://github.com/dramaclaw/dramaclaw";
// 从 GITHUB_URL 推导出 owner/repo，用于拉取 star 数。
const GITHUB_REPO = "dramaclaw/dramaclaw";

function formatStars(count: number): string {
  if (count < 1000) return String(count);
  // 146.5k 形式：保留一位小数，整千去掉 .0。
  return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

// lucide-react 当前版本已移除品牌图标（无 Github 导出），用官方 GitHub mark 内联 SVG。
function GithubMark() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 2.9-.39c.98 0 1.97.13 2.9.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z" />
    </svg>
  );
}

export function Brand({ className }: { className?: string }) {
  return (
    <div className={className ?? styles.brand} aria-label="DramaClaw">
      <img
        className={styles.brandLogo}
        src="/brand/dramaclaw-wordmark.png"
        alt=""
        aria-hidden="true"
      />
    </div>
  );
}

/**
 * Stage contents — render inside an element already styled with `styles.stage`.
 */
export function LoginStageContent({
  onStart,
}: {
  onStart: () => void;
}) {
  const { t } = useTranslation();
  const stars = useGithubStars(GITHUB_REPO);

  return (
    <>
      <div className={styles.stageLightRays} aria-hidden="true">
        <LightRays
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
      </div>

      <div className={styles.stageInner}>
        <div className={styles.stageTopBar}>
          <Brand />
          <div className={styles.stageActions}>
            <div className={styles.businessWechat}>
              <button
                type="button"
                className={styles.businessWechatTrigger}
                aria-label={t("auth.businessWechat.open")}
              >
                <MessageCircle aria-hidden="true" />
                {t("auth.businessWechat.label")}
              </button>
              <div
                className={styles.businessWechatPopover}
                role="dialog"
                aria-label={t("auth.businessWechat.qrAlt")}
              >
                <div className={styles.businessWechatPanel}>
                  <img
                    src="https://nfg-web.oss-cn-chengdu.aliyuncs.com/dramaclaw/contact/wechat.png"
                    alt={t("auth.businessWechat.qrAlt")}
                    draggable={false}
                  />
                  <div className={styles.businessWechatText}>
                    <p className={styles.businessWechatTitle}>
                      {t("auth.businessWechat.title")}
                    </p>
                    <p className={styles.businessWechatSubtitle}>
                      {t("auth.businessWechat.subtitle")}
                    </p>
                    <p className={styles.businessWechatNote}>
                      {t("auth.businessWechat.note")}
                    </p>
                  </div>
                </div>
              </div>
            </div>
            <a
              className={styles.githubLink}
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              title="GitHub"
              aria-label="GitHub"
            >
              <GithubMark />
              {stars !== null && (
                <>
                  <span className={styles.githubStarLabel}>
                    {t("auth.github.star")}
                  </span>
                  <span className={styles.githubStars}>{formatStars(stars)}</span>
                </>
              )}
            </a>
          </div>
        </div>

        <div className={styles.hero}>
          <SplitText
            tag="h1"
            text={t("auth.stage.headlines.createUniverse")}
            className={styles.heroTitle}
            delay={70}
            duration={0.8}
            ease="power3.out"
            splitType="chars"
            from={{ opacity: 0, y: 36 }}
            to={{ opacity: 1, y: 0 }}
            threshold={0.1}
            rootMargin="-100px"
            textAlign="center"
          />
          <p className={styles.heroSubtitle}>
            <span className={styles.heroSubtitlePrefix}>
              {t("auth.stage.subtitlePrefix")}
            </span>
            <span className={styles.heroSubtitleBrand}>
              {t("auth.stage.subtitleBrand")}
            </span>
            <span className={styles.heroSubtitleSuffix}>
              {t("auth.stage.subtitleSuffix")}
            </span>
          </p>
          <div className={styles.heroActions}>
            <button
              type="button"
              className={styles.heroPrimary}
              onClick={onStart}
            >
              {t("auth.stage.start")}
            </button>
            <a
              className={styles.heroSecondary}
              href={PRODUCT_MANUAL_URL}
              target="_blank"
              rel="noopener noreferrer"
              title={t("auth.openManual")}
              aria-label={t("auth.openManual")}
            >
              {t("auth.learnMore")}
            </a>
          </div>
        </div>

        <CommunityShowcase />
      </div>
    </>
  );
}
