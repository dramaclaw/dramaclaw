// SPDX-License-Identifier: Elastic-2.0
import { useTranslation } from "react-i18next";
import { usePikoPlayback } from "./piko-bgm";
import { PIKO_OST_TRACKS, pikoOstTitleKey } from "./piko-ost-tracks";
import { PIKO_MUSIC_PLAYLISTS } from "./piko-map-music";
import styles from "./piko-music.module.css";
export function PikoMusicMarquee() {
  const { t } = useTranslation();
  const playback = usePikoPlayback();
  const track = PIKO_OST_TRACKS.find(track => PIKO_MUSIC_PLAYLISTS[track.key][0] === playback.src);
  if (!track || !playback.playing) return null;
  const title = t(pikoOstTitleKey(track.key));
  const line = t("pikoWorld.music.nowPlayingMarquee", { title });
  return <div className={styles.marquee} aria-label={t("pikoWorld.music.nowPlaying", { title })}>
    <div key={track.key} className={styles.marqueeTrack} aria-hidden="true"><span>{line}</span><span>{line}</span></div>
  </div>;
}
