// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Download, PauseIcon, X } from "lucide-react";
import { liexiaorenAssets } from "@/features/liexiaoren/liexiaoren-assets";
import styles from "./liexiaoren-skin-preview.module.css";

const ENTRY_CYCLE_MS = 3000;
const ENTRY_FADE_MS = 420;
const ENTRY_IDLE_MS = 4000;
const TITLE_IDLE_MS = 10000;

export function LiexiaorenSkinPreview() {
  const [open, setOpen] = useState(false);
  const [posterOpen, setPosterOpen] = useState(false);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [entryVideoVisible, setEntryVideoVisible] = useState(true);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const entryVideoRef = useRef<HTMLVideoElement | null>(null);
  const titleVideoRef = useRef<HTMLVideoElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const entryCycleTimerRef = useRef<number | null>(null);
  const titleReplayTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (posterOpen) {
        setPosterOpen(false);
        return;
      }
      setOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, posterOpen]);

  useEffect(() => {
    if (!open) {
      setPosterOpen(false);
      setVideoPlaying(false);
      if (titleReplayTimerRef.current !== null) {
        window.clearTimeout(titleReplayTimerRef.current);
        titleReplayTimerRef.current = null;
      }
      return;
    }
    dialogRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    return () => {
      if (entryCycleTimerRef.current !== null) {
        window.clearTimeout(entryCycleTimerRef.current);
      }
      if (titleReplayTimerRef.current !== null) {
        window.clearTimeout(titleReplayTimerRef.current);
      }
    };
  }, []);

  const playPreviewVideo = () => {
    setVideoPlaying(true);
    void videoRef.current?.play().catch(() => {
      setVideoPlaying(false);
    });
  };

  const pausePreviewVideo = () => {
    setVideoPlaying(false);
  };

  const pausePreviewFromOverlay = () => {
    videoRef.current?.pause();
    setVideoPlaying(false);
  };

  const playPreviewFullscreen = () => {
    const previewVideo = videoRef.current;
    if (!previewVideo) return;
    setVideoPlaying(true);
    void previewVideo.play().catch(() => {
      setVideoPlaying(false);
    });
    const fullscreenTarget = previewVideo as HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
    };
    if (fullscreenTarget.requestFullscreen) {
      void fullscreenTarget.requestFullscreen();
      return;
    }
    fullscreenTarget.webkitEnterFullscreen?.();
  };

  const handleEntryTimeUpdate = () => {
    const entryVideo = entryVideoRef.current;
    if (!entryVideo || entryCycleTimerRef.current !== null) return;
    const cycleSeconds = ENTRY_CYCLE_MS / 1000;
    const fadeStartSeconds = (ENTRY_CYCLE_MS - ENTRY_FADE_MS) / 1000;
    if (entryVideo.currentTime < Math.min(fadeStartSeconds, cycleSeconds)) return;
    setEntryVideoVisible(false);
    entryCycleTimerRef.current = window.setTimeout(() => {
      entryVideo.pause();
      entryVideo.currentTime = 0;
      entryCycleTimerRef.current = window.setTimeout(() => {
        setEntryVideoVisible(true);
        void entryVideo.play().catch(() => {
          setEntryVideoVisible(true);
        });
        entryCycleTimerRef.current = null;
      }, ENTRY_IDLE_MS);
    }, ENTRY_FADE_MS);
  };

  const handleTitleEnded = () => {
    const titleVideo = titleVideoRef.current;
    if (!titleVideo || titleReplayTimerRef.current !== null) return;
    titleReplayTimerRef.current = window.setTimeout(() => {
      titleVideo.currentTime = 0;
      void titleVideo.play().catch(() => undefined);
      titleReplayTimerRef.current = null;
    }, TITLE_IDLE_MS);
  };

  const dialog = open ? (
    <div className={styles.backdrop}>
      <div
        ref={dialogRef}
        className={`${styles.dialog} ${posterOpen ? styles.posterDialog : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={posterOpen ? "鲁班秘术猎魈人分享海报" : "鲁班秘术猎魈人档案"}
        tabIndex={-1}
      >
        {posterOpen ? (
          <div className={styles.posterView}>
            <button
              type="button"
              className={styles.posterCloseButton}
              aria-label="关闭分享海报"
              onClick={() => setOpen(false)}
            >
              <X aria-hidden="true" />
            </button>
            <img
              className={styles.posterImage}
              src={liexiaorenAssets.skin.poster}
              alt="鲁班秘术-猎魈人分享海报"
              draggable={false}
            />
            <div className={styles.posterActions}>
              <button
                type="button"
                className={styles.posterBackButton}
                onClick={() => setPosterOpen(false)}
              >
                <ArrowLeft aria-hidden="true" />
                <span>返回</span>
              </button>
              <a
                className={styles.posterDownloadButton}
                href={liexiaorenAssets.skin.poster}
                download="鲁班秘术-猎魈人分享海报.png"
              >
                <Download aria-hidden="true" />
                <span>下载海报</span>
              </a>
            </div>
          </div>
        ) : (
          <>
            <video
              ref={titleVideoRef}
              className={styles.title}
              src={liexiaorenAssets.skin.modalTitleVideo}
              poster={liexiaorenAssets.skin.modalTitle}
              muted
              autoPlay
              playsInline
              preload="auto"
              aria-label="鲁班秘术-猎魈人"
              onEnded={handleTitleEnded}
            />
            <button
              type="button"
              className={styles.closeButton}
              aria-label="关闭猎魈档案"
              onClick={() => setOpen(false)}
            >
              <img src={liexiaorenAssets.skin.modalCloseButton} alt="" draggable={false} />
            </button>

            <div className={styles.frameWrap}>
              <img
                className={styles.frame}
                src={liexiaorenAssets.skin.modalFrame}
                alt=""
                draggable={false}
              />
              <div className={styles.videoSlot}>
                <video
                  ref={videoRef}
                  src={liexiaorenAssets.skin.modalPreviewVideo}
                  poster={liexiaorenAssets.skin.modalPreviewPoster}
                  playsInline
                  preload="metadata"
                  controls={videoPlaying}
                  onPause={pausePreviewVideo}
                  onEnded={pausePreviewVideo}
                />
                {!videoPlaying ? (
                  <button
                    type="button"
                    className={styles.playButton}
                    aria-label="播放猎魈人视频"
                    onClick={playPreviewVideo}
                  >
                    <img src={liexiaorenAssets.skin.modalPlayButton} alt="" draggable={false} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles.pauseButton}
                    aria-label="暂停猎魈人视频"
                    onClick={pausePreviewFromOverlay}
                  >
                    <PauseIcon aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>

            <div className={styles.actions}>
              <button
                type="button"
                className={styles.imageButton}
                onClick={() => {
                  videoRef.current?.pause();
                  setVideoPlaying(false);
                  setPosterOpen(true);
                }}
              >
                <img src={liexiaorenAssets.skin.modalPrimaryButton} alt="生成分享海报" draggable={false} />
              </button>
              <button type="button" className={styles.imageButton} onClick={playPreviewFullscreen}>
                <img src={liexiaorenAssets.skin.modalSecondaryButton} alt="观看完整视频" draggable={false} />
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        type="button"
        className={styles.entry}
        aria-label="打开猎魈档案"
        onClick={() => setOpen(true)}
      >
        <video
          ref={entryVideoRef}
          className={entryVideoVisible ? undefined : styles.entryVideoHidden}
          src={liexiaorenAssets.skin.entryBadgeVideo}
          poster={liexiaorenAssets.skin.entryBadge}
          muted
          autoPlay
          playsInline
          preload="auto"
          aria-hidden="true"
          onTimeUpdate={handleEntryTimeUpdate}
        />
      </button>

      {dialog && typeof document !== "undefined" ? createPortal(dialog, document.body) : null}
    </>
  );
}
