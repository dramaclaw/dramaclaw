// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";

const BASE = "/piko/world/entry/piko-entry-b1a";

export function PikoEntryMedia({ active }: { active: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const reducedMotion = useReducedMotion();
  const shouldPlay = active && !reducedMotion;
  const shouldPlayRef = useRef(shouldPlay);
  shouldPlayRef.current = shouldPlay;
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState(false);
  // Safari uses the original HEVC alpha stream; Chromium/Firefox use VP9 alpha.
  const hevc = typeof navigator !== "undefined" && /Apple/.test(navigator.vendor);

  useEffect(() => {
    if (shouldPlay) setLoaded(true);
    const video = videoRef.current;
    if (!video) return;
    if (!shouldPlay) {
      video.pause();
      video.currentTime = 0;
      setPlaying(false);
      return;
    }
    if (!loaded) return;
    if (video.error) video.load();
    let cancelled = false;
    void video.play().catch(() => {
      if (!cancelled) setPlaying(false);
    });
    return () => {
      cancelled = true;
      video.pause();
    };
  }, [shouldPlay, loaded]);

  return (
    <>
      <img
        src={`${BASE}-poster-v1.png`}
        width={640}
        height={480}
        alt=""
        draggable={false}
        className={`pointer-events-none block size-full object-contain ${playing ? "invisible" : "visible"}`}
      />
      <video
        ref={videoRef}
        src={loaded ? `${BASE}-v1.${hevc ? "mov" : "webm"}` : undefined}
        muted
        playsInline
        loop
        preload="none"
        aria-hidden="true"
        disablePictureInPicture
        onPlaying={() => {
          const video = videoRef.current;
          if (!shouldPlayRef.current) {
            video?.pause();
            if (video) video.currentTime = 0;
            return;
          }
          setPlaying(true);
        }}
        onError={() => setPlaying(false)}
        className={`pointer-events-none absolute inset-0 size-full object-contain ${playing ? "visible" : "invisible"}`}
      />
    </>
  );
}
