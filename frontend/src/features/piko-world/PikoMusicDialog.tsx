// SPDX-License-Identifier: Elastic-2.0
import { Play, Pause } from "lucide-react";
import { useEffect, useState, useRef } from "react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { PikoThreeSlicePanelSkin } from "./PikoThreeSlicePanelSkin";
import { PIKO_MUSIC_PLAYLISTS } from "./piko-map-music";
import { selectPikoMusic, setPikoMusicMuted, usePikoPlayback, usePikoSelection } from "./piko-bgm";
import styles from "./piko-music.module.css";
import { PIKO_OST_TRACKS as tracks } from "./piko-ost-tracks";

const ROOT = "/piko/world/ui/music-player/";
const formatTime = (value = 0) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
export function PikoMusicDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const playback = usePikoPlayback();
  const selection = usePikoSelection();
  const listRef = useRef<HTMLOListElement>(null);
  const [spinning, setSpinning] = useState(false);
  // Symmetric sequence: lower arm, wait, spin; stop disc, wait, lift arm.
  useEffect(() => {
    if (!open || !playback.playing) { setSpinning(false); return; }
    const timer = window.setTimeout(() => setSpinning(true), 650);
    return () => window.clearTimeout(timer);
  }, [open, playback.playing, playback.src]);
  const current = tracks.findIndex(track => PIKO_MUSIC_PLAYLISTS[track.key][0] === playback.src);
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const row = list?.children[current] as HTMLElement | undefined;
    if (list && row) list.scrollTo?.({ top: row.offsetTop - (list.firstElementChild as HTMLElement).offsetTop, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }, [current, open]);
  const caption = `《Piko小镇原声OST》- ${tracks[current]?.title ?? "选择一首小镇旋律"}`;
  const choose = (index: number) => selectPikoMusic(PIKO_MUSIC_PLAYLISTS[tracks[(index + tracks.length) % tracks.length].key]);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent showCloseButton={false} overlayClassName="!bg-black/25 !backdrop-blur-none" className={styles.dialog} aria-describedby={undefined} finalFocus={() => document.getElementById("piko-world-music")}>
      <PikoThreeSlicePanelSkin blendSeams topSrc={`${ROOT}panel-top-v1.png`} middleSrc={`${ROOT}panel-middle-v1.png`} bottomSrc={`${ROOT}panel-bottom-v1.png`} />
      <div className={styles.content}><div className={styles.scroll}>
        <DialogTitle className="sr-only">Piko小镇原声OST</DialogTitle>
        <div className={styles.turntable} aria-hidden="true">
          <img className={styles.body} src={`${ROOT}turntable-body-v2.png`} alt="" draggable={false} />
          <div className={styles.record} style={{ animationPlayState: open && playback.playing && spinning ? "running" : "paused" }}>
            <img src={`${ROOT}vinyl-disc-v1.png`} alt="" draggable={false} />
            <img className={styles.cover} src={`${ROOT}album-cover-v1.png`} alt="" draggable={false} />
          </div>
          <img className={`${styles.arm} ${playback.playing ? styles.engaged : ""}`} src={`${ROOT}tonearm-v1.png`} alt="" draggable={false} />
        </div>
        <div className={styles.captionRow}>
        <div className={styles.caption} aria-label={caption} title={caption}>
          <span>{caption}</span>
        </div>
        <button type="button" role="switch" className={styles.follow} aria-label="跟随地图音乐" aria-checked={selection === null} onClick={() => selection === null ? current >= 0 && selectPikoMusic(PIKO_MUSIC_PLAYLISTS[tracks[current].key]) : selectPikoMusic(null)}><span>跟随地图音乐</span><span className={styles.toggle} aria-hidden="true" /></button>
        </div>
        {playback.error && <p role="status" className={styles.description}>暂时无法播放，请点击曲目重试。</p>}
        <ol ref={listRef} className={styles.list} aria-label="地图音乐列表">
          {tracks.map((track, index) => <li key={track.key}><button type="button" aria-current={current === index ? "true" : undefined} aria-label={`${current === index && playback.playing ? "暂停" : "播放"}${track.title}`} onClick={() => current === index ? setPikoMusicMuted(playback.playing) : choose(index)}>
            <span className={styles.number}>{String(index + 1).padStart(2, "0")}</span>
            <span className={styles.track}><strong>{track.title}</strong></span>
            <span className={styles.time}>{current === index ? `${formatTime(playback.currentTime)} / ${formatTime(playback.duration)}` : formatTime(track.duration)}</span>
            <span className={styles.state} aria-hidden="true">{current === index && playback.playing ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}</span>
          </button></li>)}
        </ol>
      </div></div>
      <DialogClose render={<button type="button" className={styles.close} aria-label="关闭音乐播放器" />}><img src="/piko/world/ui/piko-world-close-icon-v1.png" alt="" /></DialogClose>
    </DialogContent>
  </Dialog>;
}
