// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ArrowLeft, RotateCcw } from "lucide-react";
import styles from "./piko-loading-recovery.module.css";
import { playPikoUiSound } from "./piko-audio";
import type { PikoMapLoadState } from "./PikoWorldCanvas";
import {
  loadingDisplayProgress, PIKO_LOADING_SCENES, PIKO_LOADING_CONTROLS, PIKO_LOADING_MIN_MS,
  PIKO_LOADING_TIMEOUT_MS, preloadLoadingImages,
} from "./piko-loading";

// Display windows remove transparent canvas padding without altering user artwork.
function ControlImage({ kind }: { kind: keyof typeof PIKO_LOADING_CONTROLS }) {
  const spec = {
    frame: { box: "30 482 1365 118", width: 1434, height: 1097 },
    fill: { box: "91 309 1960 107", width: 2142, height: 734 },
  }[kind];
  return <svg viewBox={spec.box} preserveAspectRatio={kind === "frame" ? "xMidYMid meet" : "none"} aria-hidden="true" className="block size-full overflow-hidden">
    <image href={PIKO_LOADING_CONTROLS[kind]} width={spec.width} height={spec.height} />
  </svg>;
}

type Props = {
  loadState: PikoMapLoadState;
  onEnter: () => void;
  onRetry: () => void;
};

export function PikoLoadingScreen({ loadState, onEnter, onRetry }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [scene] = useState(() => PIKO_LOADING_SCENES[Math.floor(Math.random() * PIKO_LOADING_SCENES.length)]);
  const background = scene.src;
  const [visualReady, setVisualReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const screenRef = useRef<HTMLDivElement>(null);
  const error = failed || loadState === "error";
  const progress = loadingDisplayProgress(elapsed, visualReady && loadState === "ready");
  const ready = !error && progress === 100;
  const enterRef = useRef(onEnter);
  enterRef.current = onEnter;

  useEffect(() => {
    if (!ready) return;
    // Hold the completed progress bar briefly before revealing the map.
    const timer = window.setTimeout(() => enterRef.current(), 1_500);
    return () => window.clearTimeout(timer);
  }, [ready]);

  useEffect(() => {
    screenRef.current?.focus();
    const controller = new AbortController();
    void preloadLoadingImages([background, ...Object.values(PIKO_LOADING_CONTROLS)], controller.signal)
      .then(() => { if (!controller.signal.aborted) setVisualReady(true); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [background]);

  useEffect(() => {
    if (!visualReady || error) return;
    const start = performance.now();
    const timer = window.setInterval(() => {
      const next = Math.min(PIKO_LOADING_MIN_MS, performance.now() - start);
      setElapsed(next);
      if (next === PIKO_LOADING_MIN_MS) window.clearInterval(timer);
    }, 50);
    return () => window.clearInterval(timer);
  }, [visualReady, error]);

  useEffect(() => {
    if (error || (visualReady && loadState === "ready")) return;
    const timer = window.setTimeout(() => setFailed(true), PIKO_LOADING_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [error, visualReady, loadState]);

  return <div ref={screenRef} tabIndex={-1} aria-label={t("pikoWorld.loadingTitle")}
    className="dark fixed inset-0 z-50 overflow-hidden bg-background focus:outline-none" data-testid="piko-loading-screen" data-scene={scene.id}>
    <img src={background} alt="" draggable={false} className="absolute inset-0 size-full object-cover" />
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_top,rgb(var(--bg-rgb)/0.95)_0%,rgb(var(--bg-rgb)/0.8)_16%,transparent_44%)]" />
    <div className="absolute inset-x-[6%] bottom-[max(5dvh,env(safe-area-inset-bottom))] flex flex-col items-center gap-4 sm:gap-5">
      <p role={error ? "alert" : undefined} className="max-w-3xl text-center text-sm leading-relaxed text-foreground sm:text-base">
        {t(error ? "pikoWorld.loadingFailed" : `pikoWorld.loadingScenes.${scene.id}.line`)}
      </p>
      {!error && <div role="progressbar" aria-label={t("pikoWorld.loadingProgress")}
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}
        aria-valuetext={t(ready ? "pikoWorld.loadingReady" : "pikoWorld.loadingPreparing")}
        className="relative aspect-[1365/118] w-[min(440px,100%)]">
        <ControlImage kind="frame" />
        <div className="absolute left-[6%] right-[6.2%] top-[21%] bottom-[22%] overflow-hidden rounded-full">
          <div className="size-full transition-[clip-path] duration-[var(--duration-base)] ease-out motion-reduce:transition-none"
            style={{ clipPath: `inset(0 ${100 - progress}% 0 0)` }}>
            <ControlImage kind="fill" />
          </div>
        </div>
      </div>}
      {error && <div className={styles.actions}>
        <button type="button" className={`${styles.button} ${styles.secondary}`} onClick={() => { playPikoUiSound("close"); void navigate({ to: "/" }); }}>
          <ArrowLeft aria-hidden="true" />{t("pikoWorld.loadingBack")}
        </button>
        <button type="button" className={`${styles.button} ${styles.primary}`} onClick={() => { playPikoUiSound("open"); onRetry(); }}>
          <RotateCcw aria-hidden="true" />{t("pikoWorld.loadingRetry")}
        </button>
      </div>}
    </div>
  </div>;
}
