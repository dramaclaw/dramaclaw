import { useEffect, useState } from "react";
import { ChevronDown, MessageCircle, Mouse } from "lucide-react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Brand } from "@/components/login/login-stage";
import Aurora from "@/components/react-bits/aurora";
import SplitText from "@/components/react-bits/split-text";
import { PRODUCT_MANUAL_URL } from "@/lib/product-manual";
import styles from "@/components/login/login.module.css";
import layout from "./hero-layout.module.css";
import { businessWechatQrUrl } from "./media";

const GITHUB_URL = "https://github.com/dramaclaw/dramaclaw";
const GITHUB_REPO = "dramaclaw/dramaclaw";
const FALLBACK_GITHUB_STARS = 574;

let cachedStars: number | null = null;

function formatStars(count: number): string {
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

function useGithubStars(repo: string): number {
  const [stars, setStars] = useState(cachedStars ?? FALLBACK_GITHUB_STARS);

  useEffect(() => {
    if (cachedStars !== null) return;
    let active = true;
    fetch(`https://api.github.com/repos/${repo}`, {
      headers: { Accept: "application/vnd.github+json" },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const count = data?.stargazers_count;
        if (active && typeof count === "number") {
          cachedStars = count;
          setStars(count);
        }
      })
      .catch(() => {
        /* Star 数仅作展示，失败时保留兜底值。 */
      });
    return () => {
      active = false;
    };
  }, [repo]);

  return stars;
}

function GithubMark() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.28-.01-1.02-.02-2-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 2.9-.39c.98 0 1.97.13 2.9.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14 0 1.55-.01 2.8-.01 3.18 0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z" />
    </svg>
  );
}

export function LoginCinematicHeader({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  const { t } = useTranslation();
  const stars = useGithubStars(GITHUB_REPO);

  return (
    <div
      className={`${styles.stageTopBar} ${className ?? ""}`}
      style={style}
    >
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
                src={businessWechatQrUrl}
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
          <span className={styles.githubStars}>{formatStars(stars)}</span>
        </a>
      </div>
    </div>
  );
}

export function LoginCinematicHero({
  heroExitProgress,
  onStart,
}: {
  heroExitProgress: number;
  onStart: () => void;
}) {
  const { t } = useTranslation();
  const scrollCueExitStyle =
    heroExitProgress > 0.002
      ? ({
          opacity: Math.max(0, 1 - heroExitProgress * 7),
          filter: `blur(${heroExitProgress * 8}px)`,
        } satisfies CSSProperties)
      : undefined;
  const headerStyle =
    heroExitProgress > 0.002
      ? ({
          "--stage-header-opacity": Math.max(0, 1 - heroExitProgress * 3.2),
          "--stage-header-offset": `${heroExitProgress * -18}px`,
          "--stage-header-blur": `${heroExitProgress * 8}px`,
          pointerEvents: heroExitProgress < 0.22 ? "auto" : "none",
        } as CSSProperties)
      : undefined;

  return (
    <>
      <Aurora
        className={layout.heroAurora}
        colorStops={["#06B6D4", "#A855F7", "#5227FF"]}
        speed={0.5}
      />

      <div className={`${styles.stageInner} ${layout.stageInner}`}>
        <LoginCinematicHeader style={headerStyle} />

        <div className={`${styles.hero} ${layout.hero}`}>
          <SplitText
            tag="h1"
            text={t("auth.stage.headlines.createUniverse")}
            className={`${styles.heroTitle} ${layout.heroTitle}`}
            delay={70}
            duration={0.8}
            ease="power3.out"
            splitType="chars"
            from={{ opacity: 0, y: 36 }}
            to={{ opacity: 1, y: 0 }}
            threshold={0.1}
            rootMargin="-100px"
            textAlign="center"
            initiallyHidden
          />
          <p className={`${styles.heroSubtitle} ${layout.heroSubtitle}`}>
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
          <div className={`${styles.heroActions} ${layout.heroActions}`}>
            <button
              type="button"
              className={`${styles.heroPrimary} ${layout.heroPrimary}`}
              onClick={onStart}
            >
              让灵感发生
            </button>
            <a
              className={`${styles.heroSecondary} ${layout.heroSecondary}`}
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

        <div
          className={layout.scrollCue}
          style={scrollCueExitStyle}
          aria-hidden="true"
        >
          <div className={layout.scrollCueInner}>
            <Mouse className={layout.scrollMouseIcon} />
            <span>SCROLL</span>
            <ChevronDown className={layout.scrollArrowIcon} />
          </div>
        </div>
      </div>
    </>
  );
}
