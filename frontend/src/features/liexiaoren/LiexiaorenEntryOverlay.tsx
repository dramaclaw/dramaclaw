// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState } from "react";
import { liexiaorenAssets } from "@/features/liexiaoren/liexiaoren-assets";
import styles from "./liexiaoren-entry-overlay.module.css";

type EntryPhase = "intro" | "loop" | "closing";

export function LiexiaorenEntryOverlay({
  onClose,
}: {
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<EntryPhase>("intro");
  const [loopReady, setLoopReady] = useState(false);
  const [muted, setMuted] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const mainVideoRef = useRef<HTMLVideoElement | null>(null);
  const loopVideoRef = useRef<HTMLVideoElement | null>(null);

  const close = useCallback(() => {
    setPhase("closing");
  }, []);

  useEffect(() => {
    if (phase !== "closing") return;
    const timer = window.setTimeout(onClose, 420);
    return () => window.clearTimeout(timer);
  }, [onClose, phase]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [close]);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  const playWithAudioFallback = useCallback((video: HTMLVideoElement | null) => {
    if (!video) return;
    if (muted) {
      video.muted = true;
      void video.play().catch(() => undefined);
      return;
    }
    video.muted = false;
    void video.play().catch(() => {
      setMuted(true);
      video.muted = true;
      void video.play().catch(() => undefined);
    });
  }, [muted]);

  useEffect(() => {
    if (phase === "intro" || !loopReady) return;
    playWithAudioFallback(loopVideoRef.current);
  }, [loopReady, phase, playWithAudioFallback]);

  return (
    <div
      ref={rootRef}
      className={`${styles.overlay} ${phase === "closing" ? styles.overlayClosing : ""}`}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="鲁班秘术猎魈人入场动画"
    >
      <button
        type="button"
        className={styles.skipHint}
        aria-label="取消入场动画"
        onClick={close}
      >
        <kbd>ESC</kbd>
        <span>取消动画</span>
      </button>
      <div className={styles.stage}>
        <video
          ref={mainVideoRef}
          className={`${styles.video} ${phase !== "intro" ? styles.videoDimmed : ""}`}
          src={liexiaorenAssets.entry.mainVideo}
          muted={muted}
          autoPlay
          playsInline
          preload="auto"
          onCanPlay={() => playWithAudioFallback(mainVideoRef.current)}
          onEnded={() => setPhase("loop")}
          onError={() => setPhase("loop")}
        />
        <video
          ref={loopVideoRef}
          className={`${styles.video} ${styles.loopVideo} ${
            phase !== "intro" && loopReady ? styles.loopVideoVisible : ""
          }`}
          src={liexiaorenAssets.entry.loopVideo}
          muted={phase === "intro" ? true : muted}
          loop
          playsInline
          preload="auto"
          onCanPlay={() => setLoopReady(true)}
          onError={close}
        />

        {phase !== "intro" ? (
          <button
            type="button"
            className={styles.enterButton}
            aria-label="启封档案并进入页面"
            onClick={close}
          />
        ) : null}
      </div>
    </div>
  );
}
