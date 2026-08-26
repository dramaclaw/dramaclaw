// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { MessageSquareQuote } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CommunityShowcase } from "./community-showcase";
import LightRays from "./light-rays";
import { GithubMark } from "@/components/platform-marks";
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
  const [businessOpen, setBusinessOpen] = useState(false);

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
            <div
              className={styles.businessWechat}
              onPointerEnter={() => setBusinessOpen(true)}
              onPointerLeave={() => setBusinessOpen(false)}
              onFocusCapture={() => setBusinessOpen(true)}
              onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setBusinessOpen(false);
                }
              }}
            >
              <button
                type="button"
                className={styles.businessWechatTrigger}
                aria-label={t("auth.businessWechat.open")}
                aria-haspopup="dialog"
                aria-expanded={businessOpen}
              >
                <MessageSquareQuote aria-hidden="true" />
                {t("auth.businessWechat.shortLabel")}
              </button>
              <div
                className={styles.businessWechatPopover}
                role="dialog"
                aria-label={t("auth.businessWechat.qrAlt")}
                aria-hidden={!businessOpen}
                inert={!businessOpen}
              >
                <div className={styles.businessWechatPanel}>
                  <img
                    src="https://nfg-web-assets.cdnfg.com/dramaclaw/contact/wechat.png"
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
              <span className={styles.githubStarLabel}>
                {t("auth.github.star")}
              </span>
              <span className={styles.githubStars} aria-live="polite">
                {stars === null ? "—" : formatStars(stars)}
              </span>
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
