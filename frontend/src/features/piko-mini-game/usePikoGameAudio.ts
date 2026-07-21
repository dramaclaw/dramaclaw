// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef } from "react";

export function usePikoGameAudio(muted: boolean) {
  const audioContextRef = useRef<AudioContext | null>(null);
  const mutedRef = useRef(muted);

  const getAudioContext = useCallback(() => {
    if (mutedRef.current) return null;
    const AudioContextClass =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return null;
    audioContextRef.current ??= new AudioContextClass();
    if (audioContextRef.current.state === "suspended") void audioContextRef.current.resume();
    return audioContextRef.current;
  }, []);

  const playTone = useCallback((
    frequency: number,
    duration: number,
    volume: number,
    type: OscillatorType = "sine",
    delay = 0,
    endFrequency?: number,
  ) => {
    const context = getAudioContext();
    if (!context) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const startsAt = context.currentTime + delay;
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, startsAt);
    if (endFrequency) oscillator.frequency.exponentialRampToValueAtTime(endFrequency, startsAt + duration);
    gain.gain.setValueAtTime(0.0001, startsAt);
    gain.gain.exponentialRampToValueAtTime(volume, startsAt + 0.007);
    gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(startsAt);
    oscillator.stop(startsAt + duration + 0.02);
  }, [getAudioContext]);

  useEffect(() => {
    mutedRef.current = muted;
    const context = audioContextRef.current;
    if (!context) return;
    if (muted && context.state === "running") void context.suspend();
    if (!muted && context.state === "suspended") void context.resume();
  }, [muted]);

  useEffect(() => {
    return () => {
      const context = audioContextRef.current;
      audioContextRef.current = null;
      if (context && context.state !== "closed") void context.close();
    };
  }, []);

  return playTone;
}
