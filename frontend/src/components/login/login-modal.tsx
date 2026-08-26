// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { businessWechatQrUrl, loginModalShowcaseVideos } from "./cinematic/media";
import { LoginCard } from "./login-card";
import styles from "./login.module.css";

type LoginModalProps = {
  open: boolean;
  onClose: () => void;
};

const SHOWCASE_CLIP_DURATION_SECONDS = 18;
const SHOWCASE_CROSSFADE_DURATION_MS = 720;

export function LoginModal({ open, onClose }: LoginModalProps) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const [showcaseIndex, setShowcaseIndex] = useState(0);
  const [outgoingShowcaseIndex, setOutgoingShowcaseIndex] = useState<number | null>(null);
  const showcaseTransitionTimer = useRef<number | null>(null);
  const showcaseTransitioning = useRef(false);
  const failedShowcaseIds = useRef<Set<string>>(new Set());
  const showcaseIndexRef = useRef(0);
  const pendingShowcaseAdvance = useRef(false);
  const [showcaseUnavailable, setShowcaseUnavailable] = useState(false);
  const activeShowcase = loginModalShowcaseVideos[showcaseIndex] ?? loginModalShowcaseVideos[0];
  const outgoingShowcase =
    outgoingShowcaseIndex === null ? null : loginModalShowcaseVideos[outgoingShowcaseIndex];
  const visibleShowcases = outgoingShowcase
    ? [
        { item: outgoingShowcase, outgoing: true },
        { item: activeShowcase, outgoing: false },
      ]
    : [{ item: activeShowcase, outgoing: false }];

  const goToShowcase = (nextIndex: number) => {
    showcaseIndexRef.current = nextIndex;
    setShowcaseIndex(nextIndex);
  };

  const showNextShowcase = () => {
    if (showcaseTransitioning.current) {
      // 过渡期内的推进请求不能丢。CDN 整体不可用时，incoming 片源会在锁释放前
      // 就报错，而 error 对同一个元素只发一次 —— 直接 return 会永久停在这个失败
      // 片源上，既不继续尝试剩余片源，也走不到静态兜底。记下来，过渡结束后补。
      pendingShowcaseAdvance.current = true;
      return;
    }

    // 读 ref 而非闭包：补偿推进是在过渡计时器回调里发起的，那个闭包捕获的
    // showcaseIndex 已经过期了。
    const currentIndex = showcaseIndexRef.current;
    const nextIndex = (currentIndex + 1) % loginModalShowcaseVideos.length;
    if (reducedMotion) {
      goToShowcase(nextIndex);
      return;
    }

    showcaseTransitioning.current = true;
    setOutgoingShowcaseIndex(currentIndex);
    goToShowcase(nextIndex);

    if (showcaseTransitionTimer.current !== null) {
      window.clearTimeout(showcaseTransitionTimer.current);
    }
    showcaseTransitionTimer.current = window.setTimeout(() => {
      setOutgoingShowcaseIndex(null);
      showcaseTransitioning.current = false;
      showcaseTransitionTimer.current = null;
      if (pendingShowcaseAdvance.current) {
        pendingShowcaseAdvance.current = false;
        showNextShowcase();
      }
    }, SHOWCASE_CROSSFADE_DURATION_MS);
  };

  // 轮换在 reducedMotion 下的唯一驱动就是 onError（此时 autoPlay 关闭，
  // onEnded/onTimeUpdate 都不触发）。逐个记下失败片源，全部失败就停在
  // .loginMedia 的静态底色上，不再卸载/重建 <video> 反复发请求。
  const handleShowcaseError = (id: string) => {
    failedShowcaseIds.current.add(id);
    if (failedShowcaseIds.current.size < loginModalShowcaseVideos.length) {
      showNextShowcase();
      return;
    }
    pendingShowcaseAdvance.current = false;
    if (showcaseTransitionTimer.current !== null) {
      window.clearTimeout(showcaseTransitionTimer.current);
      showcaseTransitionTimer.current = null;
    }
    showcaseTransitioning.current = false;
    setOutgoingShowcaseIndex(null);
    setShowcaseUnavailable(true);
  };

  useEffect(() => {
    if (showcaseTransitionTimer.current !== null) {
      window.clearTimeout(showcaseTransitionTimer.current);
      showcaseTransitionTimer.current = null;
    }
    showcaseTransitioning.current = false;
    setOutgoingShowcaseIndex(null);
    failedShowcaseIds.current.clear();
    pendingShowcaseAdvance.current = false;
    setShowcaseUnavailable(false);
    if (!open) return;
    goToShowcase(0);
  }, [open]);

  useEffect(
    () => () => {
      if (showcaseTransitionTimer.current !== null) {
        window.clearTimeout(showcaseTransitionTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className={styles.loginOverlay}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          role="dialog"
          aria-modal="true"
          aria-label={t("auth.login")}
        >
          <motion.div
            className={styles.loginDialog}
            initial={{ opacity: 0, scale: 0.98, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 10 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          >
            <button
              type="button"
              className={styles.loginClose}
              onClick={onClose}
              aria-label={t("auth.closeLogin")}
            >
              <X strokeWidth={1.8} aria-hidden="true" />
            </button>

            <section className={styles.loginMedia} aria-label={t("auth.modal.showcaseLabel")}>
              {!showcaseUnavailable &&
                visibleShowcases.map(({ item, outgoing }) => (
                  <video
                    key={item.id}
                    className={`${styles.loginMediaVideo} ${
                      outgoing
                        ? styles.loginMediaVideoOutgoing
                        : styles.loginMediaVideoIncoming
                    }`}
                    src={item.video}
                    muted
                    playsInline
                    autoPlay={!reducedMotion}
                    preload="metadata"
                    onTimeUpdate={
                      outgoing
                        ? undefined
                        : (event) => {
                            if (event.currentTarget.currentTime >= SHOWCASE_CLIP_DURATION_SECONDS) {
                              showNextShowcase();
                            }
                          }
                    }
                    onEnded={outgoing ? undefined : showNextShowcase}
                    onError={outgoing ? undefined : () => handleShowcaseError(item.id)}
                    data-showcase-id={item.id}
                    data-showcase-phase={outgoing ? "outgoing" : "incoming"}
                    aria-hidden="true"
                  />
                ))}
              <div className={styles.loginMediaShade} aria-hidden="true" />
              <div className={styles.loginMediaCopy}>
                <h2>{t("auth.modal.showcaseTitle")}</h2>
                <span>{t("auth.modal.showcaseDescription")}</span>
              </div>
            </section>

            <section className={styles.loginPanel}>
              <div className={styles.loginPanelInner}>
                <header className={styles.loginPanelHeader}>
                  <img
                    className={styles.loginPanelBrand}
                    src="/brand/dramaclaw-wordmark.png"
                    alt="DramaClaw"
                  />
                  <h2 className={styles.loginPanelTitle}>{t("auth.modal.title")}</h2>
                  <p className={styles.loginPanelSubtitle}>{t("auth.modal.subtitle")}</p>
                </header>

                <LoginCard />

                <div className={styles.loginApplyRow}>
                  <span>{t("auth.modal.noAccount")}</span>
                  <div className={styles.loginApplyAccount}>
                    <button
                      type="button"
                      className={styles.loginApplyTrigger}
                      aria-describedby="login-apply-account-popover"
                    >
                      {t("auth.modal.applyAccount")}
                    </button>
                    <div
                      id="login-apply-account-popover"
                      className={styles.loginApplyPopover}
                      role="tooltip"
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
                </div>
              </div>
            </section>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
