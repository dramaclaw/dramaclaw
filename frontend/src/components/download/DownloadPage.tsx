// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState, type ReactElement } from "react";
import { Download, FolderDown, MonitorPlay, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import clsx from "clsx";
import "@fontsource-variable/geist/wght.css";
import { AppleMark, GithubMark, WindowsMark } from "@/components/platform-marks";
import { useDesktopRelease } from "@/hooks/use-desktop-release";
import { useGithubStars } from "@/hooks/use-github-stars";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { detectDesktopPlatform, type DesktopPlatform } from "@/lib/desktop-download";
import { DownloadCanvasPreview } from "./DownloadCanvasPreview";
import styles from "./download.module.css";

const GITHUB_URL = "https://github.com/dramaclaw/dramaclaw";
const GITHUB_REPO = "dramaclaw/dramaclaw";
const RELEASES_URL = "https://github.com/dramaclaw/dramaclaw/releases";
const RELEASES_LATEST_URL = `${RELEASES_URL}/latest`;
const FALLBACK_GITHUB_STARS = 574;

/** 校准条在进入视口时推到的落点。纯观感取值,不代表任何进度。 */
const STRIP_FILL = "38%";

const PLATFORM_MARKS: Record<DesktopPlatform, () => ReactElement> = {
  mac: AppleMark,
  windows: WindowsMark,
};

const CAPABILITIES = [
  { id: "localFiles", Icon: Download },
  { id: "longTasks", Icon: MonitorPlay },
  { id: "autoUpdate", Icon: RefreshCw },
  { id: "localExport", Icon: FolderDown },
] as const;

/**
 * 更新日志。每条对应 main 上一次真实发版 —— 版本号、日期与摘要都取自
 * `src/novelvideo/release-notes.md` 的历史版本,不写还没发布的东西。
 * 文案在 i18n 的 downloadPage.changelog.<id> 下。
 */
const CHANGELOG = [
  { id: "v132", version: "1.3.2", date: "2026-08-07" },
  { id: "v131", version: "1.3.1", date: "2026-08-07" },
  { id: "v130", version: "1.3.0", date: "2026-08-06" },
  { id: "v121", version: "1.2.1", date: "2026-08-03" },
  { id: "v120", version: "1.2.0", date: "2026-07-31" },
] as const;

/** FAQ 顺序即展示顺序;带 link 的条目会在答案末尾追加一个外链。 */
const FAQ = [
  { id: "macGatekeeper" },
  { id: "winSmartScreen" },
  { id: "offline" },
  { id: "update", link: RELEASES_URL },
  { id: "storage" },
  { id: "openSource", link: GITHUB_URL },
] as const;

function formatStars(count: number): string {
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
}

/** 把 2026-08-07 显示成 08-07 —— 同年内日期,年份是噪音。 */
function formatLogDate(iso: string): string {
  return iso.slice(5);
}

/**
 * 安装包校验和。值取自清单里**这一个文件**自己的 sha512(不是顶层那个,
 * 那属于自动更新用的包),整段可见不截断 —— 核验时要能原样比对。
 */
function ChecksumRow({ sha512 }: { sha512: string | null }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  // 复制成功的反馈自己退回去;组件卸载时清掉定时器,避免对已卸载组件 setState。
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    if (!sha512) return;
    try {
      await navigator.clipboard.writeText(sha512);
      setCopied(true);
    } catch {
      // 无剪贴板权限(非安全上下文等)时不弹错:值本来就明文可选中手动复制。
    }
  }

  return (
    <div className={styles.checksum}>
      <div className={styles.checksumHead}>
        <span>{t("downloadPage.release.checksum.label")}</span>
        {sha512 && (
          <button type="button" className={styles.checksumCopy} onClick={copy}>
            {t(
              copied
                ? "downloadPage.release.checksum.copied"
                : "downloadPage.release.checksum.copy",
            )}
          </button>
        )}
      </div>
      <p className={styles.checksumValue}>
        {sha512 ?? t("downloadPage.release.checksum.pending")}
      </p>
      <p className={styles.checksumNote}>
        {t("downloadPage.release.checksum.note")}
      </p>
    </div>
  );
}

export function DownloadPage() {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const stars = useGithubStars(GITHUB_REPO);
  const releases = useDesktopRelease();

  const pageRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);

  // 挂载后再探测,避免预渲染的外壳把错误的平台顺序烤进 HTML。
  const [platform, setPlatform] = useState<DesktopPlatform>("mac");
  useEffect(() => {
    setPlatform(detectDesktopPlatform());
  }, []);

  const ordered: DesktopPlatform[] =
    platform === "windows" ? ["windows", "mac"] : ["mac", "windows"];

  // 版本区展示当前系统那一档的清单信息(两个平台同版发布,取哪个都一样)。
  const current = releases[platform];

  // 滚动进场。这里直接操作 DOM 而不是给每个元素挂 state:要露出的元素有二十来个,
  // 逐个上 hook 会违反 hooks 规则,单个 observer 扫 [data-reveal] 更省也更好读。
  useEffect(() => {
    const root = pageRef.current;
    if (!root) return;

    const targets = Array.from(root.querySelectorAll<HTMLElement>("[data-reveal]"));
    const revealAll = () => {
      for (const el of targets) el.classList.add(styles.riseIn);
      stripRef.current?.style.setProperty("--strip-width", STRIP_FILL);
    };

    if (reducedMotion || typeof IntersectionObserver === "undefined") {
      revealAll();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add(styles.riseIn);
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.05 },
    );
    for (const el of targets) observer.observe(el);

    // 校准条只推一次,不做循环动画。
    const strip = stripRef.current;
    let stripObserver: IntersectionObserver | undefined;
    if (strip) {
      stripObserver = new IntersectionObserver(
        (entries) => {
          if (!entries[0]?.isIntersecting) return;
          strip.style.setProperty("--strip-width", STRIP_FILL);
          stripObserver?.disconnect();
        },
        { threshold: 0.4 },
      );
      stripObserver.observe(strip);
    }

    return () => {
      observer.disconnect();
      stripObserver?.disconnect();
    };
  }, [reducedMotion]);

  return (
    <div className={styles.page} ref={pageRef}>
      <header className={styles.top}>
        <div className={styles.topInner}>
          <a className={styles.brand} href="#top" aria-label="DramaClaw">
            <img className={styles.brandMark} src="/brand/logo-d.png" alt="" aria-hidden="true" />
            <img
              className={styles.brandWordmark}
              src="/brand/dramaclaw-wordmark.png"
              alt="DramaClaw"
            />
          </a>
          <nav className={styles.topNav}>
            <a href="#capability">{t("downloadPage.nav.capability")}</a>
            <a href="#release">{t("downloadPage.nav.release")}</a>
            <a href="#faq">{t("downloadPage.nav.faq")}</a>
          </nav>
          <a className={styles.star} href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
            <GithubMark />
            <span className={styles.mono}>{formatStars(stars ?? FALLBACK_GITHUB_STARS)}</span>
          </a>
        </div>
      </header>

      <main id="top">
        <div className={styles.hero}>
          <div className={clsx(styles.wrap, styles.heroInner)}>
            <div className={styles.heroLead}>
              <img
                className={clsx(styles.heroWordmark, styles.rise)}
                data-reveal=""
                src="/brand/dramaclaw-wordmark.png"
                alt="DramaClaw"
              />

              {/* slogan 与登录页共用同一批 auth.stage.* 键,两处永远同步。 */}
              <h1 className={clsx(styles.heroTitle, styles.rise)} data-reveal="">
                {t("auth.stage.headlines.createUniverse")}
              </h1>
              <p className={clsx(styles.heroSlogan, styles.rise)} data-reveal="">
                <span>{t("auth.stage.subtitlePrefix")}</span>
                <em>{t("auth.stage.subtitleBrand")}</em>
                {t("auth.stage.subtitleSuffix") && (
                  <span>{t("auth.stage.subtitleSuffix")}</span>
                )}
              </p>

              <p className={clsx(styles.heroSub, styles.rise)} data-reveal="">
                {t("downloadPage.hero.subtitle")}
              </p>
            </div>

            <div className={styles.heroAside}>
              <div className={clsx(styles.platforms, styles.rise)} data-reveal="">
                {ordered.map((os) => {
                  const Mark = PLATFORM_MARKS[os];
                  const detected = os === platform;
                  return (
                    <div
                      key={os}
                      className={clsx(styles.platform, detected && styles.platformDetected)}
                    >
                      <div className={styles.platformHead}>
                        <Mark />
                        <span className={styles.platformName}>
                          {t(`downloadPage.platform.${os}.name`)}
                        </span>
                        {detected && (
                          <span className={styles.platformTag}>
                            {t("downloadPage.platform.detected")}
                          </span>
                        )}
                      </div>

                      <dl className={styles.readout}>
                        <dt>{t("downloadPage.platform.format")}</dt>
                        <dd>{t(`downloadPage.platform.${os}.format`)}</dd>
                        <dt>{t("downloadPage.platform.arch")}</dt>
                        <dd>{t(`downloadPage.platform.${os}.arch`)}</dd>
                        <dt>{t("downloadPage.platform.requirement")}</dt>
                        <dd>{t(`downloadPage.platform.${os}.requirement`)}</dd>
                      </dl>

                      <a
                        className={clsx(styles.button, detected && styles.buttonPrimary)}
                        href={releases[os].url}
                        download
                      >
                        <Download aria-hidden="true" />
                        {t(`downloadPage.platform.${os}.cta`)}
                      </a>
                    </div>
                  );
                })}
              </div>

              <p className={clsx(styles.heroNote, styles.rise)} data-reveal="">
                {t("downloadPage.hero.note")}{" "}
                {t("downloadPage.hero.history")}{" "}
                <a href={RELEASES_LATEST_URL} target="_blank" rel="noopener noreferrer">
                  GitHub Releases
                </a>
              </p>
            </div>
          </div>

          <div className={styles.strip} ref={stripRef} aria-hidden="true" />
        </div>

        <section className={styles.section} id="preview">
          <div className={styles.wrap}>
            <p className={styles.eyebrow}>
              <b>{t("downloadPage.preview.eyebrow")}</b> / INTERFACE
            </p>
            <h2 className={clsx(styles.h2, styles.rise)} data-reveal="">
              {t("downloadPage.preview.title")}
            </h2>
            <p className={clsx(styles.lede, styles.rise)} data-reveal="">
              {t("downloadPage.preview.lede")}
            </p>

            <figure className={clsx(styles.shotFrame, styles.rise)} data-reveal="">
              <div className={styles.shotBar}>
                <span className={styles.shotDot} />
                <span className={styles.shotDot} />
                <span className={styles.shotDot} />
                <span className={styles.shotTitle}>{t("downloadPage.preview.windowTitle")}</span>
              </div>
              <DownloadCanvasPreview />
            </figure>
            <p className={styles.shotCaption}>{t("downloadPage.preview.caption")}</p>
          </div>
        </section>

        <section className={styles.section} id="capability">
          <div className={styles.wrap}>
            <p className={styles.eyebrow}>
              <b>{t("downloadPage.capability.eyebrow")}</b> / CAPABILITIES
            </p>
            <h2 className={clsx(styles.h2, styles.rise)} data-reveal="">
              {t("downloadPage.capability.title")}
            </h2>
            <p className={clsx(styles.lede, styles.rise)} data-reveal="">
              {t("downloadPage.capability.lede")}
            </p>

            <div className={clsx(styles.capabilityGrid, styles.rise)} data-reveal="">
              {CAPABILITIES.map(({ id, Icon }) => (
                <div key={id} className={styles.capabilityCell}>
                  <Icon strokeWidth={1.4} aria-hidden="true" />
                  <h3>{t(`downloadPage.capability.items.${id}.title`)}</h3>
                  <p>{t(`downloadPage.capability.items.${id}.description`)}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.section} id="release">
          <div className={styles.wrap}>
            <p className={styles.eyebrow}>
              <b>{t("downloadPage.release.eyebrow")}</b> / RELEASE
            </p>
            <h2 className={clsx(styles.h2, styles.rise)} data-reveal="">
              {t("downloadPage.release.title")}
            </h2>

            <div className={styles.releaseGrid}>
              <aside className={clsx(styles.spec, styles.rise)} data-reveal="">
                <dl>
                  <dt>{t("downloadPage.release.spec.version")}</dt>
                  <dd>
                    {current.version
                      ? `v${current.version}`
                      : t("downloadPage.release.spec.pending")}
                  </dd>
                  <dt>{t("downloadPage.release.spec.released")}</dt>
                  <dd>
                    {current.releaseDate ?? t("downloadPage.release.spec.pending")}
                  </dd>
                  <dt>macOS</dt>
                  <dd>{t("downloadPage.release.spec.macValue")}</dd>
                  <dt>Windows</dt>
                  <dd>{t("downloadPage.release.spec.windowsValue")}</dd>
                  <dt>{t("downloadPage.release.spec.autoUpdate")}</dt>
                  <dd className={styles.specOk}>
                    {t("downloadPage.release.spec.autoUpdateValue")}
                  </dd>
                  <dt>{t("downloadPage.release.spec.license")}</dt>
                  <dd>Elastic-2.0</dd>
                </dl>
                <ChecksumRow sha512={current.sha512} />
              </aside>

              <ol className={clsx(styles.changelog, styles.rise)} data-reveal="">
                {CHANGELOG.map(({ id, version, date }) => (
                  <li key={id}>
                    <div className={styles.changelogMeta}>
                      <span className={styles.mono}>v{version}</span>
                      <time dateTime={date}>{formatLogDate(date)}</time>
                    </div>
                    <div>
                      <b>{t(`downloadPage.changelog.${id}.title`)}</b>
                      <p>{t(`downloadPage.changelog.${id}.description`)}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        <section className={styles.section} id="faq">
          <div className={styles.wrap}>
            <p className={styles.eyebrow}>
              <b>{t("downloadPage.faq.eyebrow")}</b> / FAQ
            </p>
            <h2 className={clsx(styles.h2, styles.rise)} data-reveal="">
              {t("downloadPage.faq.title")}
            </h2>

            <div className={clsx(styles.faq, styles.rise)} data-reveal="">
              {FAQ.map((item, index) => (
                <details key={item.id} open={index === 0}>
                  <summary>{t(`downloadPage.faq.items.${item.id}.question`)}</summary>
                  <p className={styles.faqAnswer}>
                    {t(`downloadPage.faq.items.${item.id}.answer`)}
                    {"link" in item && item.link && (
                      <>
                        {" "}
                        <a href={item.link} target="_blank" rel="noopener noreferrer">
                          {t(`downloadPage.faq.items.${item.id}.linkLabel`)}
                        </a>
                      </>
                    )}
                  </p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={styles.wrap}>
          <div className={styles.footerRow}>
            <img
              className={styles.footerWordmark}
              src="/brand/dramaclaw-wordmark.png"
              alt="DramaClaw"
            />
            <nav className={styles.footerLinks}>
              <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
                GitHub
              </a>
              <a href="#capability">{t("downloadPage.nav.capability")}</a>
              <a href="#release">{t("downloadPage.nav.release")}</a>
              <a href="#faq">{t("downloadPage.nav.faq")}</a>
            </nav>
          </div>
          <p className={styles.footerMeta}>{t("downloadPage.footer.meta")}</p>
        </div>
      </footer>
    </div>
  );
}
