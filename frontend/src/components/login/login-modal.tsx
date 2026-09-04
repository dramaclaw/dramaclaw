// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { businessWechatQrUrl, loginModalShowcaseVideo } from "./cinematic/media";
import { LoginCard } from "./login-card";
import styles from "./login.module.css";

type LoginModalProps = {
  open: boolean;
  onClose: () => void;
};

export function LoginModal({ open, onClose }: LoginModalProps) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();

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
              <video
                className={styles.loginMediaVideo}
                src={loginModalShowcaseVideo}
                muted
                playsInline
                autoPlay={!reducedMotion}
                loop
                preload="metadata"
                aria-hidden="true"
              />
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
