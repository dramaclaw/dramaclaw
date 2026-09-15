// SPDX-License-Identifier: Elastic-2.0
import { usePikoPlayback } from "./piko-bgm";
import { PIKO_OST_TRACKS } from "./piko-ost-tracks";
import { PIKO_MUSIC_PLAYLISTS } from "./piko-map-music";
import styles from "./piko-music.module.css";
export function PikoMusicMarquee() {
  const playback = usePikoPlayback();
  const track = PIKO_OST_TRACKS.find(track => PIKO_MUSIC_PLAYLISTS[track.key][0] === playback.src);
  if (!track || !playback.playing) return null;
  return <div className={styles.marquee} aria-label={`正在播放：${track.title}`}>
    <div key={track.key} className={styles.marqueeTrack} aria-hidden="true"><span>正在播放 · {track.title}</span><span>正在播放 · {track.title}</span></div>
  </div>;
}
