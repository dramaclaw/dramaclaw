// SPDX-License-Identifier: Elastic-2.0
import { Play, Pause } from "lucide-react";
import { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { PikoThreeSlicePanelSkin } from "./PikoThreeSlicePanelSkin";
import { PIKO_MUSIC_PLAYLISTS } from "./piko-map-music";
import { selectPikoMusic, setPikoMusicMuted, usePikoPlayback, usePikoSelection } from "./piko-bgm";
import styles from "./piko-music.module.css";
import { PIKO_OST_TRACKS as tracks, pikoOstTitleKey } from "./piko-ost-tracks";

import { PikoMusicPetals } from "./PikoMusicPetals";
import { playPikoUiSound } from "./piko-audio";
import iconStyles from "./piko-icon-button.module.css";

const ROOT = "/piko/world/ui/music-player/";
const formatTime = (value = 0) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
export function PikoMusicDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const playback = usePikoPlayback();
  const selection = usePikoSelection();
  const [spinning, setSpinning] = useState(false);
  // Lower the arm before spinning; on pause, stop the disc and retract immediately.
  useEffect(() => {
    if (!open || !playback.playing) { setSpinning(false); return; }
    const timer = window.setTimeout(() => setSpinning(true), 650);
    return () => window.clearTimeout(timer);
  }, [open, playback.playing, playback.src]);
  const current = tracks.findIndex(track => PIKO_MUSIC_PLAYLISTS[track.key][0] === playback.src);
  // Portal contents can mount after the parent effect; wait for the actual list.
  const listRef = useCallback((list: HTMLOListElement | null) => {
    if (!list || !open || current < 0) return;
    const frame = requestAnimationFrame(() => {
      const row = list.children[current] as HTMLElement | undefined;
      const first = list.firstElementChild as HTMLElement | null;
      if (row && first) list.scrollTo?.({ top: row.offsetTop - first.offsetTop, behavior: "instant" });
    });
    return () => cancelAnimationFrame(frame);
  }, [current, open]);
  const caption = t("pikoWorld.music.caption", {
    album: t("pikoWorld.music.albumTitle"),
    title: current >= 0 ? t(pikoOstTitleKey(tracks[current].key)) : t("pikoWorld.music.captionEmpty"),
  });
  const choose = (index: number) => selectPikoMusic(PIKO_MUSIC_PLAYLISTS[tracks[(index + tracks.length) % tracks.length].key]);
  return <Dialog open={open} onOpenChange={nextOpen => {
    if (!nextOpen) playPikoUiSound("close");
    onOpenChange(nextOpen);
  }}>
    <DialogContent showCloseButton={false} overlayClassName="!bg-black/25 !backdrop-blur-none" className={styles.dialog} aria-describedby={undefined} finalFocus={() => document.getElementById("piko-world-music")}>
      <PikoThreeSlicePanelSkin blendSeams topSrc={`${ROOT}panel-top-v1.png`} middleSrc={`${ROOT}panel-middle-v1.png`} bottomSrc={`${ROOT}panel-bottom-v1.png`} />
      <div className={styles.content}><div className={styles.scroll}>
        <DialogTitle className="sr-only">{t("pikoWorld.music.albumTitle")}</DialogTitle>
        <div className={styles.turntable} aria-hidden="true">
          <img className={styles.body} src={`${ROOT}turntable-body-v2.png`} alt="" draggable={false} />
          <div className={styles.record} style={{ animationPlayState: open && playback.playing && spinning ? "running" : "paused" }}>
            <img src={`${ROOT}vinyl-disc-v1.png`} alt="" draggable={false} />
            <img className={styles.cover} src={`${ROOT}album-cover-v1.png`} alt="" draggable={false} />
          </div>
          <img className={`${styles.arm} ${playback.playing ? styles.engaged : ""}`} src={`${ROOT}tonearm-v1.png`} alt="" draggable={false} />
          {open && <PikoMusicPetals emitting={playback.playing && spinning} />}
        </div>
        <div className={styles.captionRow}>
        <div className={styles.caption} aria-label={caption} title={caption}>
          <span>{caption}</span>
        </div>
        <button type="button" role="switch" className={styles.follow} aria-label={t("pikoWorld.music.followMap")} aria-checked={selection === null} onClick={() => selection === null ? current >= 0 && selectPikoMusic(PIKO_MUSIC_PLAYLISTS[tracks[current].key]) : selectPikoMusic(null)}><span>{t("pikoWorld.music.followMap")}</span><span className={styles.toggle} aria-hidden="true" /></button>
        </div>
        {playback.error && <p role="status" className={styles.description}>{t("pikoWorld.music.playbackError")}</p>}
        <ol ref={listRef} className={styles.list} aria-label={t("pikoWorld.music.trackList")}>
          {tracks.map((track, index) => <li key={track.key}><button type="button" aria-current={current === index ? "true" : undefined} aria-label={t(current === index && playback.playing ? "pikoWorld.music.pauseTrack" : "pikoWorld.music.playTrack", { title: t(pikoOstTitleKey(track.key)) })} onClick={() => current === index ? setPikoMusicMuted(playback.playing) : choose(index)}>
            <span className={styles.number}>{String(index + 1).padStart(2, "0")}</span>
            <span className={styles.track}><strong>{t(pikoOstTitleKey(track.key))}</strong></span>
            <span className={styles.time}>{current === index ? `${formatTime(playback.currentTime)} / ${formatTime(playback.duration)}` : formatTime(track.duration)}</span>
            <span className={styles.state} aria-hidden="true">{current === index && playback.playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}</span>
          </button></li>)}
        </ol>
      </div></div>
      <DialogClose render={<button type="button" className={`${styles.close} ${iconStyles.button}`} aria-label={t("pikoWorld.music.close")} />}><img src="/piko/world/ui/piko-world-close-icon-v1.png" alt="" /></DialogClose>
    </DialogContent>
  </Dialog>;
}
