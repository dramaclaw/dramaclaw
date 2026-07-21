// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Gamepad2, Volume2, VolumeX, X } from "lucide-react";
import { PikoActionFigure } from "@/features/companion/PikoActionFigure";
import { PikoBreakoutGame } from "@/features/piko-mini-game/PikoBreakoutGame";
import { PikoCatchGame } from "@/features/piko-mini-game/PikoCatchGame";
import { PikoFlyingGame } from "@/features/piko-mini-game/PikoFlyingGame";
import { PikoLeapGame } from "@/features/piko-mini-game/PikoLeapGame";
import { PikoRollingBallGame } from "@/features/piko-mini-game/PikoRollingBallGame";
import { cn } from "@/lib/utils";

const GAME_DURATION_MS = 60_000;
const RAIN_SPAWN_INTERVAL_MS = 150;
const BULLET_SPEED = 78;
const HIT_RANGE = 8.6;
const FIRE_COOLDOWN_MS = 150;
const COMBO_BOOST_MS = 3_000;
const RAIN_EVENT_MS = 3_500;
const BURST_RADIUS = 18;
const BURST_EFFECT_MS = 620;
const ULTIMATE_EFFECT_MS = 720;
const STRONG_COMBO_THRESHOLD = 18;
const HIT_SPARK_MS = 460;
const POWER_UP_START_DELAY_MS = 6_500;
const POWER_UP_MIN_GAP_MS = 8_500;
const POWER_UP_MAX_GAP_MS = 12_000;
const MAX_POWER_UP_DROPS = 5;
const POWER_UP_CATCH_X_RANGE = 12.5;
const POWER_UP_CATCH_Y_RANGE = 14;
const MAGNET_DURATION_MS = 3_400;
const RAPID_DURATION_MS = 4_200;
const JELLY_DURATION_MS = 3_800;
const RAPID_FIRE_COOLDOWN_MS = 82;
const ENERGY_MAX = 100;
const ENERGY_NEAR_READY = 90;
const ENERGY_HIT_GAIN = 1;
const ENERGY_POWER_UP_GAIN = 2;

type FallingKind = "spark" | "crystal" | "combo" | "burst";
type GamePhase = "warmup" | "flow" | "rush";
type PowerUpKind = "magnet" | "rapid" | "jelly";

type FallingItem = {
  id: number;
  x: number;
  y: number;
  size: number;
  speed: number;
  kind: FallingKind;
  spin: number;
  drift: number;
  sway: number;
  wave: number;
};

type PixelBullet = {
  id: number;
  x: number;
  y: number;
};

type PixelBulletDraft = Omit<PixelBullet, "id">;

type PowerUpItem = {
  id: number;
  x: number;
  y: number;
  kind: PowerUpKind;
  speed: number;
  spin: number;
  wave: number;
};

type FloatingFeedback = {
  id: number;
  key: string;
  values?: Record<string, number>;
};

type BurstEffect = {
  id: number;
  x: number;
  y: number;
  kind?: "burst" | "ultimate";
};

type HitSpark = {
  id: number;
  x: number;
  y: number;
  kind: FallingKind;
};

type GameStatus = "idle" | "countdown" | "playing" | "finished";
type StationView = "library" | "game";
type PikoGameId = "inspiration-station" | "memory-match" | "breakout" | "rolling-ball" | "flying" | "catch" | "leap";

type PikoInspirationStationProps = {
  open: boolean;
  onClose: () => void;
};

const PIKO_GAME_LIBRARY = [
  {
    id: "inspiration-station",
    titleKey: "pikoMiniGame.title",
  },
  {
    id: "memory-match",
    titleKey: "pikoMiniGame.memory.title",
  },
  {
    id: "breakout",
    titleKey: "pikoMiniGame.breakout.title",
  },
  {
    id: "rolling-ball",
    titleKey: "pikoMiniGame.rollingBall.title",
  },
  {
    id: "flying",
    titleKey: "pikoMiniGame.flying.title",
  },
  {
    id: "catch",
    titleKey: "pikoMiniGame.catch.title",
  },
  {
    id: "leap",
    titleKey: "pikoMiniGame.leap.title",
  },
] as const;

const KIND_LABEL: Record<FallingKind, string> = {
  spark: "✦",
  crystal: "◆",
  combo: "✚",
  burst: "✹",
};

const POWER_UP_LABEL: Record<PowerUpKind, string> = {
  magnet: "⌁",
  rapid: "◇",
  jelly: "◌",
};

const FINALE_CONFETTI = Array.from({ length: 12 }, (_, index) => ({
  id: index,
  x: `${(index - 5.5) * 18}px`,
  y: `${46 + (index % 4) * 14}px`,
  rotate: `${160 + index * 23}deg`,
  delay: `${index * 46}ms`,
  color:
    index % 3 === 0
      ? "rgb(165 243 252 / 0.92)"
      : index % 3 === 1
        ? "rgb(253 230 138 / 0.9)"
        : "rgb(217 249 157 / 0.88)",
}));

const POWER_UP_ORDER: PowerUpKind[] = ["magnet", "rapid", "jelly"];

const POWER_UP_COLLECT_SOUND_SRC = "/piko/sounds/power-up-collect.wav";
const ULTIMATE_NEARLY_READY_SOUND_SRC = "/piko/sounds/ultimate-nearly-ready.wav";
const ULTIMATE_READY_SOUND_SRC = "/piko/sounds/ultimate-ready.wav";
const ULTIMATE_CAST_SOUND_SRC = "/piko/sounds/ultimate-cast.wav";
const BGM_SOUND_SRC = "/piko/sounds/bgm.mp3";
const BGM_VOLUME = 0.5;
const BGM_FADE_MS = 2_200;
const BGM_RESTART_BEFORE_END_SECONDS = 3.2;

type ResultSoundKind = "combo" | "wild" | "burst" | "rain" | "high" | "medium" | "soft";
type MemoryCard = {
  id: number;
  value: string;
  matched: boolean;
};

let hitAudioContext: AudioContext | null = null;
let pikoAudioMuted = false;
let powerUpCollectAudio: HTMLAudioElement | null = null;
let ultimateNearlyReadyAudio: HTMLAudioElement | null = null;
let ultimateReadyAudio: HTMLAudioElement | null = null;
let ultimateCastAudio: HTMLAudioElement | null = null;
let bgmAudio: HTMLAudioElement | null = null;
let bgmFadeTimer: number | null = null;
let bgmLoopTimer: number | null = null;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function shuffleMemoryCards(cards: MemoryCard[]) {
  return [...cards].sort(() => Math.random() - 0.5);
}

function makeMemoryDeck() {
  const values = ["✦", "◆", "✚", "✹", "◇", "◌"];
  return shuffleMemoryCards(
    values.flatMap((value, index) => [
      { id: index * 2, value, matched: false },
      { id: index * 2 + 1, value, matched: false },
    ]),
  );
}

function panFromX(x: number) {
  return clamp((x - 50) / 58, -0.68, 0.68);
}

function phaseForElapsed(elapsed: number): GamePhase {
  if (elapsed < 8_000) return "warmup";
  if (elapsed < 45_000) return "flow";
  return "rush";
}

function spawnIntervalFor(phase: GamePhase) {
  if (phase === "warmup") return 620;
  if (phase === "flow") return 410;
  return 285;
}

function randomKind(phase: GamePhase): FallingKind {
  const roll = Math.random();
  if (phase === "warmup") {
    if (roll > 0.92) return "crystal";
    if (roll > 0.84) return "combo";
    return "spark";
  }
  if (phase === "rush") {
    if (roll > 0.88) return "burst";
    if (roll > 0.76) return "combo";
    if (roll > 0.56) return "crystal";
    return "spark";
  }
  if (roll > 0.92) return "burst";
  if (roll > 0.82) return "combo";
  if (roll > 0.64) return "crystal";
  return "spark";
}

function makeItem(id: number, phase: GamePhase): FallingItem {
  const kind = randomKind(phase);
  const phaseSpeed = phase === "rush" ? 6 : phase === "flow" ? 1.8 : 0;
  const baseSize = kind === "burst" ? 13.8 : kind === "crystal" ? 12.2 : kind === "combo" ? 12.8 : 10.4;
  const baseSpeed = kind === "burst" ? 15 : kind === "crystal" ? 16.5 : kind === "combo" ? 18 : 20.5;
  return {
    id,
    kind,
    x: 8 + Math.random() * 84,
    y: -8,
    size: baseSize + Math.random() * 1.8,
    speed: baseSpeed + phaseSpeed + Math.random() * 7,
    spin: -12 + Math.random() * 24,
    drift: kind === "combo" ? randomBetween(-5.8, 5.8) : kind === "burst" ? randomBetween(-1.8, 1.8) : 0,
    sway: kind === "combo" ? randomBetween(0.8, 1.55) : kind === "crystal" ? randomBetween(0.25, 0.55) : 0,
    wave: Math.random() * Math.PI * 2,
  };
}

function randomPowerUpKind(previous: PowerUpKind | null): PowerUpKind {
  const candidates = previous ? POWER_UP_ORDER.filter((kind) => kind !== previous) : POWER_UP_ORDER;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function makePowerUp(id: number, phase: GamePhase, previous: PowerUpKind | null): PowerUpItem {
  const kind = randomPowerUpKind(previous);
  return {
    id,
    kind,
    x: 12 + Math.random() * 76,
    y: -8,
    speed: phase === "rush" ? randomBetween(17, 21) : randomBetween(13, 17),
    spin: randomBetween(-18, 18),
    wave: Math.random() * Math.PI * 2,
  };
}

function scheduleNextPowerUp(now: number) {
  return now + POWER_UP_MIN_GAP_MS + Math.random() * (POWER_UP_MAX_GAP_MS - POWER_UP_MIN_GAP_MS);
}

function makeOpeningItems(): FallingItem[] {
  return Array.from({ length: 5 }, (_, index) => ({
    ...makeItem(index, "warmup"),
    x: 14 + index * 18 + Math.random() * 6,
    y: -22 - index * 12,
  }));
}

function scoreFor(kind: FallingKind) {
  if (kind === "crystal") return 3;
  if (kind === "burst") return 2;
  return 1;
}

function resultKindFor(score: number, maxCombo: number, burstHits: number, rainEvents: number): ResultSoundKind {
  if (maxCombo >= STRONG_COMBO_THRESHOLD) return "combo";
  if (burstHits > 0 && rainEvents > 0) return "wild";
  if (burstHits > 0) return "burst";
  if (rainEvents > 0) return "rain";
  if (score >= 42) return "high";
  if (score >= 22) return "medium";
  return "soft";
}

function getAudioContext() {
  if (pikoAudioMuted) return null;
  const AudioContextClass =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return null;
  hitAudioContext ??= new AudioContextClass();
  const context = hitAudioContext;
  if (context.state === "suspended") {
    void context.resume();
  }
  return context;
}

function setPikoAudioMuted(muted: boolean) {
  pikoAudioMuted = muted;
  if (!muted) return;
  stopManagedAudio();
}

function stopAudioElement(audio: HTMLAudioElement | null) {
  if (!audio) return;
  audio.pause();
  audio.currentTime = 0;
}

function clearBgmTimers() {
  if (bgmFadeTimer !== null) {
    window.clearInterval(bgmFadeTimer);
    bgmFadeTimer = null;
  }
  if (bgmLoopTimer !== null) {
    window.clearInterval(bgmLoopTimer);
    bgmLoopTimer = null;
  }
}

function ensureBgmAudio() {
  bgmAudio ??= new Audio(BGM_SOUND_SRC);
  bgmAudio.preload = "auto";
  bgmAudio.loop = false;
  return bgmAudio;
}

function fadeBgmTo(targetVolume: number, durationMs: number, onComplete?: () => void) {
  const audio = ensureBgmAudio();
  if (bgmFadeTimer !== null) {
    window.clearInterval(bgmFadeTimer);
    bgmFadeTimer = null;
  }
  const startVolume = audio.volume;
  const startedAt = performance.now();
  bgmFadeTimer = window.setInterval(() => {
    const progress = Math.min(1, (performance.now() - startedAt) / durationMs);
    audio.volume = startVolume + (targetVolume - startVolume) * progress;
    if (progress >= 1) {
      if (bgmFadeTimer !== null) {
        window.clearInterval(bgmFadeTimer);
        bgmFadeTimer = null;
      }
      onComplete?.();
    }
  }, 50);
}

function scheduleBgmSoftLoop() {
  if (bgmLoopTimer !== null) {
    window.clearInterval(bgmLoopTimer);
  }
  bgmLoopTimer = window.setInterval(() => {
    const audio = bgmAudio;
    if (!audio || pikoAudioMuted || audio.paused || !Number.isFinite(audio.duration)) return;
    const remaining = audio.duration - audio.currentTime;
    if (remaining > BGM_RESTART_BEFORE_END_SECONDS) return;
    if (bgmLoopTimer !== null) {
      window.clearInterval(bgmLoopTimer);
      bgmLoopTimer = null;
    }
    fadeBgmTo(0, BGM_FADE_MS, () => {
      if (pikoAudioMuted) return;
      audio.currentTime = 0;
      audio.volume = 0;
      void audio.play().then(() => {
        fadeBgmTo(BGM_VOLUME, BGM_FADE_MS);
        scheduleBgmSoftLoop();
      }).catch(() => undefined);
    });
  }, 250);
}

function startBgm() {
  if (pikoAudioMuted) return;
  const audio = ensureBgmAudio();
  if (!audio.paused) {
    scheduleBgmSoftLoop();
    return;
  }
  clearBgmTimers();
  audio.currentTime = 0;
  audio.volume = 0;
  void audio.play().then(() => {
    fadeBgmTo(BGM_VOLUME, BGM_FADE_MS);
    scheduleBgmSoftLoop();
  }).catch(() => undefined);
}

function stopBgm() {
  clearBgmTimers();
  if (!bgmAudio) return;
  stopAudioElement(bgmAudio);
  bgmAudio.volume = 0;
}

function stopManagedAudio() {
  stopBgm();
  stopAudioElement(powerUpCollectAudio);
  stopAudioElement(ultimateNearlyReadyAudio);
  stopAudioElement(ultimateReadyAudio);
  stopAudioElement(ultimateCastAudio);
  if (hitAudioContext?.state === "running") {
    void hitAudioContext.suspend();
  }
}

function playAudioElement(audio: HTMLAudioElement, volume: number) {
  if (pikoAudioMuted) return;
  stopAudioElement(audio);
  audio.volume = volume;
  void audio.play().catch(() => undefined);
}

function playPowerUpCollectAudio() {
  powerUpCollectAudio ??= new Audio(POWER_UP_COLLECT_SOUND_SRC);
  playAudioElement(powerUpCollectAudio, 0.7);
}

function playUltimateNearlyReadyAudio() {
  ultimateNearlyReadyAudio ??= new Audio(ULTIMATE_NEARLY_READY_SOUND_SRC);
  playAudioElement(ultimateNearlyReadyAudio, 0.72);
}

function playUltimateReadyAudio() {
  ultimateReadyAudio ??= new Audio(ULTIMATE_READY_SOUND_SRC);
  playAudioElement(ultimateReadyAudio, 0.72);
}

function playUltimateCastAudio() {
  ultimateCastAudio ??= new Audio(ULTIMATE_CAST_SOUND_SRC);
  playAudioElement(ultimateCastAudio, 0.74);
}

function playTone(
  frequency: number,
  duration: number,
  volume: number,
  type: OscillatorType = "square",
  startDelay = 0,
  pan = 0,
  pitchJitter = 0,
) {
  const context = getAudioContext();
  if (!context) return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = type;
  const startsAt = context.currentTime + startDelay;
  const pitchedFrequency = frequency * randomBetween(1 - pitchJitter, 1 + pitchJitter);
  oscillator.frequency.setValueAtTime(pitchedFrequency, startsAt);
  gain.gain.setValueAtTime(0.0001, startsAt);
  gain.gain.exponentialRampToValueAtTime(volume, startsAt + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);
  oscillator.connect(gain);
  if (context.createStereoPanner) {
    const panner = context.createStereoPanner();
    panner.pan.setValueAtTime(pan, startsAt);
    gain.connect(panner);
    panner.connect(context.destination);
  } else {
    gain.connect(context.destination);
  }
  oscillator.start(startsAt);
  oscillator.stop(startsAt + duration + 0.01);
}

function playSweep(
  from: number,
  to: number,
  duration: number,
  volume: number,
  type: OscillatorType = "sawtooth",
  pan = 0,
  startDelay = 0,
) {
  const context = getAudioContext();
  if (!context) return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const startsAt = context.currentTime + startDelay;
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(from, startsAt);
  oscillator.frequency.exponentialRampToValueAtTime(to, startsAt + duration);
  gain.gain.setValueAtTime(0.0001, startsAt);
  gain.gain.exponentialRampToValueAtTime(volume, startsAt + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);
  oscillator.connect(gain);
  if (context.createStereoPanner) {
    const panner = context.createStereoPanner();
    panner.pan.setValueAtTime(pan, startsAt);
    gain.connect(panner);
    panner.connect(context.destination);
  } else {
    gain.connect(context.destination);
  }
  oscillator.start(startsAt);
  oscillator.stop(startsAt + duration + 0.02);
}

function playNoiseBurst(duration = 0.11, volume = 0.16, pan = 0, startDelay = 0) {
  const context = getAudioContext();
  if (!context) return;
  const bufferSize = Math.floor(context.sampleRate * duration);
  const buffer = context.createBuffer(1, bufferSize, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < bufferSize; index += 1) {
    data[index] = (Math.random() * 2 - 1) * (1 - index / bufferSize);
  }
  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();
  const gain = context.createGain();
  const startsAt = context.currentTime + startDelay;
  source.buffer = buffer;
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(1_600, startsAt);
  filter.Q.setValueAtTime(5.5, startsAt);
  gain.gain.setValueAtTime(volume, startsAt);
  gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);
  source.connect(filter);
  filter.connect(gain);
  if (context.createStereoPanner) {
    const panner = context.createStereoPanner();
    panner.pan.setValueAtTime(pan, startsAt);
    gain.connect(panner);
    panner.connect(context.destination);
  } else {
    gain.connect(context.destination);
  }
  source.start(startsAt);
  source.stop(startsAt + duration + 0.01);
}

function playHitSound(kind: FallingKind, x: number, combo: number, rainActive: boolean) {
  const pan = panFromX(x);
  const comboLift = Math.min(0.08, combo * 0.003);
  const rainSparkleVolume = rainActive ? 0.08 : 0;
  if (kind === "crystal") {
    playTone(987.77, 0.07, 0.21, "triangle", 0, pan, 0.025);
    playTone(1_318.51, 0.08, 0.17, "triangle", 0.038, pan * 0.86, 0.022);
    playTone(1_760, 0.11, 0.14 + comboLift, "sine", 0.084, pan * 0.7, 0.018);
    if (rainActive) playTone(2_093, 0.08, rainSparkleVolume, "sine", 0.13, pan * 0.4, 0.04);
    return;
  }
  if (kind === "combo") {
    playTone(659.25 + combo * 5, 0.065, 0.19, "square", 0, pan, 0.015);
    playTone(987.77 + combo * 6, 0.075, 0.17, "square", 0.038, pan * 0.75, 0.014);
    playTone(1_318.51 + combo * 8, 0.095, 0.16 + comboLift, "triangle", 0.078, pan * 0.55, 0.012);
    playTone(1_760, 0.07, 0.08, "sine", 0.14, -pan * 0.35, 0.03);
    return;
  }
  if (kind === "burst") {
    playNoiseBurst(0.15, 0.2, pan);
    playSweep(160, 860, 0.2, 0.22, "sawtooth", pan);
    playTone(1_174.66, 0.09, 0.16, "triangle", 0.055, pan * 0.7, 0.018);
    playTone(1_568, 0.1, 0.12, "sine", 0.115, -pan * 0.42, 0.025);
    playTone(2_349.32, 0.08, 0.09, "sine", 0.17, pan * 0.26, 0.035);
    return;
  }
  playTone(1_046.5, 0.052, 0.18 + comboLift, "square", 0, pan, 0.045);
  playTone(1_568, 0.064, 0.11 + rainSparkleVolume, "triangle", 0.034, pan * 0.7, 0.04);
}

function playFireSound(x: number, rapid = false) {
  const pan = panFromX(x);
  if (rapid) {
    playSweep(1_080, 1_680, 0.032, 0.045, "square", pan);
    playTone(2_093, 0.026, 0.026, "sine", 0.022, pan * 0.72, 0.04);
    return;
  }
  playSweep(860, 1_340, 0.048, 0.072, "square", pan);
  playTone(1_760, 0.034, 0.045, "sine", 0.028, pan * 0.72, 0.035);
}

function playEnergyNearlyReadySound() {
  playUltimateNearlyReadyAudio();
}

function playEnergyReadySound() {
  playUltimateReadyAudio();
}

function playUltimateSound() {
  playUltimateCastAudio();
}

function playPowerUpSound() {
  playPowerUpCollectAudio();
}

function playCountdownSound(count: number) {
  const frequency = count === 1 ? 783.99 : count === 2 ? 659.25 : 587.33;
  playTone(frequency, 0.09, 0.1, "triangle");
  playTone(frequency * 2, 0.06, 0.045, "sine", 0.035);
}

function PikoMemoryMatchGame({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const timersRef = useRef<Set<number>>(new Set());
  const [cards, setCards] = useState<MemoryCard[]>(() => makeMemoryDeck());
  const [flippedIds, setFlippedIds] = useState<number[]>([]);
  const [moves, setMoves] = useState(0);
  const matchedCount = cards.filter((card) => card.matched).length;
  const isComplete = matchedCount === cards.length;

  const clearTimers = useCallback(() => {
    for (const timer of timersRef.current) {
      window.clearTimeout(timer);
    }
    timersRef.current.clear();
  }, []);

  const resetMemoryGame = useCallback(() => {
    clearTimers();
    setCards(makeMemoryDeck());
    setFlippedIds([]);
    setMoves(0);
  }, [clearTimers]);

  useEffect(() => {
    return () => {
      clearTimers();
    };
  }, [clearTimers]);

  const flipCard = useCallback(
    (card: MemoryCard) => {
      if (card.matched || flippedIds.includes(card.id) || flippedIds.length >= 2 || isComplete) return;

      const nextFlippedIds = [...flippedIds, card.id];
      setFlippedIds(nextFlippedIds);

      if (nextFlippedIds.length !== 2) return;

      const [firstId, secondId] = nextFlippedIds;
      const firstCard = cards.find((candidate) => candidate.id === firstId);
      const secondCard = cards.find((candidate) => candidate.id === secondId);
      setMoves((current) => current + 1);

      const timer = window.setTimeout(() => {
        if (firstCard && secondCard && firstCard.value === secondCard.value) {
          setCards((current) =>
            current.map((candidate) =>
              candidate.id === firstCard.id || candidate.id === secondCard.id
                ? { ...candidate, matched: true }
                : candidate,
            ),
          );
        }
        setFlippedIds([]);
        timersRef.current.delete(timer);
      }, firstCard?.value === secondCard?.value ? 360 : 720);
      timersRef.current.add(timer);
    },
    [cards, flippedIds, isComplete],
  );

  return (
    <div className="relative h-[520px] overflow-hidden border border-white/[0.08] bg-white/[0.03]">
      <div className="flex h-full flex-col px-5 py-5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-xl font-semibold text-white">{t("pikoMiniGame.memory.title")}</h3>
            <p className="mt-1 text-sm text-white/56">{t("pikoMiniGame.memory.hint")}</p>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-xs text-white/48">{t("pikoMiniGame.memory.moves")}</div>
            <div className="mt-0.5 text-lg font-semibold text-white">{moves}</div>
          </div>
        </div>

        <div className="mt-6 grid flex-1 grid-cols-4 gap-3">
          {cards.map((card) => {
            const visible = card.matched || flippedIds.includes(card.id);
            return (
              <button
                key={card.id}
                type="button"
                className={cn(
                  "grid min-h-0 place-items-center rounded-2xl border text-3xl font-semibold leading-none transition-[background-color,border-color,transform,opacity]",
                  visible
                    ? "border-cyan-100/30 bg-cyan-200/[0.12] text-cyan-50 shadow-[0_0_22px_rgba(103,232,249,0.12)]"
                    : "border-white/[0.12] bg-white/[0.05] text-white/30 hover:-translate-y-0.5 hover:border-cyan-100/24 hover:bg-white/[0.08]",
                  card.matched && "opacity-58",
                )}
                aria-label={visible ? t("pikoMiniGame.memory.cardVisible", { value: card.value }) : t("pikoMiniGame.memory.cardHidden")}
                onClick={() => flipCard(card)}
              >
                {visible ? card.value : <Gamepad2 className="size-7" />}
              </button>
            );
          })}
        </div>

        {isComplete ? (
          <div className="absolute inset-0 grid place-items-center bg-black/58 px-5 backdrop-blur-md">
            <div className="max-w-sm rounded-2xl border border-white/[0.16] bg-black/64 px-7 py-6 text-center shadow-[0_24px_72px_rgba(0,0,0,0.5)]">
              <div className="text-sm font-medium text-cyan-100/78">
                {t("pikoMiniGame.memory.resultMeta", { moves })}
              </div>
              <h3 className="mt-2 text-2xl font-semibold text-white">{t("pikoMiniGame.memory.completed")}</h3>
              <div className="mt-6 flex justify-center gap-3">
                <button
                  type="button"
                  className="h-10 rounded-full border border-white/[0.14] px-5 text-sm text-white/78 transition-colors hover:bg-white/[0.08] hover:text-white"
                  onClick={onClose}
                >
                  {t("pikoMiniGame.backToWork")}
                </button>
                <button
                  type="button"
                  className="h-10 rounded-full bg-cyan-300 px-5 text-sm font-medium text-slate-950 transition-colors hover:bg-cyan-200"
                  onClick={resetMemoryGame}
                >
                  {t("pikoMiniGame.playAgain")}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function PikoInspirationStation({ open, onClose }: PikoInspirationStationProps) {
  const { t } = useTranslation();
  const boardRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number | null>(null);
  const lastSpawnRef = useRef(0);
  const nextEventAtRef = useRef(0);
  const nextPowerUpAtRef = useRef(0);
  const rainUntilRef = useRef(0);
  const comboBoostUntilRef = useRef(0);
  const activePowerUpRef = useRef<PowerUpKind | null>(null);
  const activePowerUpUntilRef = useRef(0);
  const comboRef = useRef(0);
  const maxComboRef = useRef(0);
  const burstHitsRef = useRef(0);
  const rainEventsRef = useRef(0);
  const rushAnnouncedRef = useRef(false);
  const lastPowerUpKindRef = useRef<PowerUpKind | null>(null);
  const powerUpsCaughtRef = useRef(0);
  const powerUpsDroppedRef = useRef(0);
  const energyNearlyReadyAnnouncedRef = useRef(false);
  const energyReadyAnnouncedRef = useRef(false);
  const powerUpUsesRef = useRef<Record<PowerUpKind, number>>({
    magnet: 0,
    rapid: 0,
    jelly: 0,
  });
  const feedbackIdRef = useRef(0);
  const feedbackTimerRef = useRef<number | null>(null);
  const burstEffectIdRef = useRef(0);
  const hitSparkIdRef = useRef(0);
  const effectTimersRef = useRef<Set<number>>(new Set());
  const scorePulseTimerRef = useRef<number | null>(null);
  const scorePulseFrameRef = useRef<number | null>(null);
  const itemIdRef = useRef(0);
  const powerUpIdRef = useRef(0);
  const bulletIdRef = useRef(0);
  const lastFireRef = useRef(0);
  const fireHoldTimerRef = useRef<number | null>(null);
  const isSpaceHeldRef = useRef(false);
  const pikoXRef = useRef(50);
  const scoreRef = useRef(0);
  const energyRef = useRef(0);
  const itemsRef = useRef<FallingItem[]>([]);
  const powerUpsRef = useRef<PowerUpItem[]>([]);
  const bulletsRef = useRef<PixelBullet[]>([]);
  const startedAtRef = useRef(0);
  const [status, setStatus] = useState<GameStatus>("idle");
  const [items, setItems] = useState<FallingItem[]>([]);
  const [powerUps, setPowerUps] = useState<PowerUpItem[]>([]);
  const [bullets, setBullets] = useState<PixelBullet[]>([]);
  const [activePowerUp, setActivePowerUp] = useState<PowerUpKind | null>(null);
  const [powerUpsCaught, setPowerUpsCaught] = useState(0);
  const [powerUpUses, setPowerUpUses] = useState<Record<PowerUpKind, number>>({
    magnet: 0,
    rapid: 0,
    jelly: 0,
  });
  const [rushActive, setRushActive] = useState(false);
  const [isAudioMuted, setIsAudioMuted] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("st.pikoMiniGame.muted") === "true";
  });
  const [pikoX, setPikoX] = useState(50);
  const [score, setScore] = useState(0);
  const [energy, setEnergy] = useState(0);
  const [caught, setCaught] = useState(0);
  const [timeLeft, setTimeLeft] = useState(GAME_DURATION_MS / 1000);
  const [countdown, setCountdown] = useState(3);
  const [floatingFeedback, setFloatingFeedback] = useState<FloatingFeedback | null>(null);
  const [burstEffects, setBurstEffects] = useState<BurstEffect[]>([]);
  const [hitSparks, setHitSparks] = useState<HitSpark[]>([]);
  const [scorePulse, setScorePulse] = useState(false);
  const [comboStage, setComboStage] = useState(0);
  const [maxCombo, setMaxCombo] = useState(0);
  const [burstHits, setBurstHits] = useState(0);
  const [rainEvents, setRainEvents] = useState(0);
  const [stationView, setStationView] = useState<StationView>("library");
  const [activeGameId, setActiveGameId] = useState<PikoGameId>("inspiration-station");

  const resultKind = useMemo(
    () => resultKindFor(score, maxCombo, burstHits, rainEvents),
    [burstHits, maxCombo, rainEvents, score],
  );
  const feedbackKey = `pikoMiniGame.feedback.${resultKind}` as const;
  const resultInsightKey = useMemo(() => {
    if (maxCombo >= STRONG_COMBO_THRESHOLD) return "pikoMiniGame.insight.combo";
    if (powerUpUses.jelly > 0) return "pikoMiniGame.insight.jelly";
    if (burstHits >= 2) return "pikoMiniGame.insight.burst";
    if (rainEvents > 0) return "pikoMiniGame.insight.rain";
    if (score >= 22) return "pikoMiniGame.insight.flow";
    return "pikoMiniGame.insight.soft";
  }, [burstHits, maxCombo, powerUpUses.jelly, rainEvents, score]);
  const activePowerUpLabel = activePowerUp ? t(`pikoMiniGame.powerUps.${activePowerUp}`) : null;
  const activeGameTitleKey =
    activeGameId === "memory-match"
      ? "pikoMiniGame.memory.title"
      : activeGameId === "breakout"
        ? "pikoMiniGame.breakout.title"
        : activeGameId === "rolling-ball"
          ? "pikoMiniGame.rollingBall.title"
          : activeGameId === "flying"
            ? "pikoMiniGame.flying.title"
            : activeGameId === "catch"
              ? "pikoMiniGame.catch.title"
              : activeGameId === "leap"
                ? "pikoMiniGame.leap.title"
            : "pikoMiniGame.title";

  useEffect(() => {
    setPikoAudioMuted(isAudioMuted);
    window.localStorage.setItem("st.pikoMiniGame.muted", String(isAudioMuted));
    if (!open || stationView !== "game" || activeGameId !== "inspiration-station" || isAudioMuted) {
      stopBgm();
      return;
    }
    startBgm();
    return () => {
      stopBgm();
    };
  }, [activeGameId, isAudioMuted, open, stationView]);

  const stopFrame = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  const showFloatingFeedback = useCallback((key: string, values?: Record<string, number>) => {
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }
    setFloatingFeedback({ id: feedbackIdRef.current++, key, values });
    feedbackTimerRef.current = window.setTimeout(() => {
      setFloatingFeedback(null);
      feedbackTimerRef.current = null;
    }, 1050);
  }, []);

  const clearTransientTimers = useCallback(() => {
    for (const timer of effectTimersRef.current) {
      window.clearTimeout(timer);
    }
    effectTimersRef.current.clear();
  }, []);

  const clearScorePulseTimers = useCallback(() => {
    if (scorePulseTimerRef.current !== null) {
      window.clearTimeout(scorePulseTimerRef.current);
      scorePulseTimerRef.current = null;
    }
    if (scorePulseFrameRef.current !== null) {
      cancelAnimationFrame(scorePulseFrameRef.current);
      scorePulseFrameRef.current = null;
    }
  }, []);

  const exitPointerLock = useCallback(() => {
    if (document.pointerLockElement === boardRef.current && document.exitPointerLock) {
      document.exitPointerLock();
    }
  }, []);

  const requestPointerLock = useCallback(() => {
    const board = boardRef.current;
    if (!board || document.pointerLockElement === board || !board.requestPointerLock) return;
    try {
      const lockResult = board.requestPointerLock();
      if (lockResult instanceof Promise) {
        lockResult.catch(() => undefined);
      }
    } catch {
      // CSS cursor hiding remains as the fallback when Pointer Lock is blocked.
    }
  }, []);

  const addBurstEffect = useCallback((x: number, y: number, kind: BurstEffect["kind"] = "burst") => {
    const id = burstEffectIdRef.current++;
    const duration = kind === "ultimate" ? ULTIMATE_EFFECT_MS : BURST_EFFECT_MS;
    setBurstEffects((current) => [...current, { id, x, y, kind }]);
    const timer = window.setTimeout(() => {
      setBurstEffects((current) => current.filter((effect) => effect.id !== id));
      effectTimersRef.current.delete(timer);
    }, duration);
    effectTimersRef.current.add(timer);
  }, []);

  const addHitSpark = useCallback((x: number, y: number, kind: FallingKind) => {
    const id = hitSparkIdRef.current++;
    setHitSparks((current) => [...current, { id, x, y, kind }]);
    const timer = window.setTimeout(() => {
      setHitSparks((current) => current.filter((spark) => spark.id !== id));
      effectTimersRef.current.delete(timer);
    }, HIT_SPARK_MS);
    effectTimersRef.current.add(timer);
  }, []);

  const triggerScorePulse = useCallback(() => {
    clearScorePulseTimers();
    setScorePulse(false);
    scorePulseFrameRef.current = window.requestAnimationFrame(() => {
      scorePulseFrameRef.current = null;
      setScorePulse(true);
      scorePulseTimerRef.current = window.setTimeout(() => {
        setScorePulse(false);
        scorePulseTimerRef.current = null;
      }, 260);
    });
  }, [clearScorePulseTimers]);

  const addEnergy = useCallback((amount: number) => {
    if (amount <= 0) return;
    const previous = energyRef.current;
    const wasReady = previous >= ENERGY_MAX;
    const next = clamp(previous + amount, 0, ENERGY_MAX);
    energyRef.current = next;
    setEnergy(next);
    if (
      previous < ENERGY_NEAR_READY &&
      next >= ENERGY_NEAR_READY &&
      !energyNearlyReadyAnnouncedRef.current
    ) {
      energyNearlyReadyAnnouncedRef.current = true;
      playEnergyNearlyReadySound();
    }
    if (!wasReady && next >= ENERGY_MAX && !energyReadyAnnouncedRef.current) {
      energyReadyAnnouncedRef.current = true;
      playEnergyReadySound();
      showFloatingFeedback("pikoMiniGame.float.energyReady");
    }
  }, [showFloatingFeedback]);

  const resetGame = useCallback(() => {
    stopFrame();
    exitPointerLock();
    if (feedbackTimerRef.current !== null) {
      window.clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }
    clearTransientTimers();
    clearScorePulseTimers();
    itemsRef.current = [];
    powerUpsRef.current = [];
    bulletsRef.current = [];
    setItems([]);
    setPowerUps([]);
    setBullets([]);
    setActivePowerUp(null);
    setPowerUpsCaught(0);
    setPowerUpUses({
      magnet: 0,
      rapid: 0,
      jelly: 0,
    });
    setRushActive(false);
    setScore(0);
    scoreRef.current = 0;
    setEnergy(0);
    energyRef.current = 0;
    setCaught(0);
    setTimeLeft(GAME_DURATION_MS / 1000);
    setCountdown(3);
    setFloatingFeedback(null);
    setBurstEffects([]);
    setHitSparks([]);
    setScorePulse(false);
    setComboStage(0);
    setMaxCombo(0);
    setBurstHits(0);
    setRainEvents(0);
    setPikoX(50);
    pikoXRef.current = 50;
    lastFrameRef.current = null;
    lastSpawnRef.current = 0;
    nextEventAtRef.current = 0;
    nextPowerUpAtRef.current = 0;
    rainUntilRef.current = 0;
    comboBoostUntilRef.current = 0;
    activePowerUpRef.current = null;
    activePowerUpUntilRef.current = 0;
    comboRef.current = 0;
    maxComboRef.current = 0;
    burstHitsRef.current = 0;
    rainEventsRef.current = 0;
    rushAnnouncedRef.current = false;
    lastPowerUpKindRef.current = null;
    powerUpsCaughtRef.current = 0;
    powerUpsDroppedRef.current = 0;
    energyNearlyReadyAnnouncedRef.current = false;
    energyReadyAnnouncedRef.current = false;
    powerUpUsesRef.current = {
      magnet: 0,
      rapid: 0,
      jelly: 0,
    };
    burstEffectIdRef.current = 0;
    hitSparkIdRef.current = 0;
    itemIdRef.current = 0;
    powerUpIdRef.current = 0;
    bulletIdRef.current = 0;
    lastFireRef.current = 0;
    isSpaceHeldRef.current = false;
    if (fireHoldTimerRef.current !== null) {
      window.clearTimeout(fireHoldTimerRef.current);
      fireHoldTimerRef.current = null;
    }
  }, [clearScorePulseTimers, clearTransientTimers, exitPointerLock, stopFrame]);

  const startGame = useCallback(() => {
    resetGame();
    requestPointerLock();
    setStatus("countdown");
  }, [requestPointerLock, resetGame]);

  const openGame = useCallback((gameId: PikoGameId) => {
    resetGame();
    setStatus("idle");
    setActiveGameId(gameId);
    setStationView("game");
  }, [resetGame]);

  const backToLibrary = useCallback(() => {
    resetGame();
    setStatus("idle");
    setActiveGameId("inspiration-station");
    setStationView("library");
  }, [resetGame]);

  const beginPlaying = useCallback(() => {
    startedAtRef.current = performance.now();
    const openingItems = makeOpeningItems();
    itemsRef.current = openingItems;
    itemIdRef.current = openingItems.length;
    nextEventAtRef.current = performance.now() + 10_000 + Math.random() * 4_000;
    nextPowerUpAtRef.current = performance.now() + POWER_UP_START_DELAY_MS + Math.random() * 3_000;
    setItems(openingItems);
    setStatus("playing");
  }, []);

  const finishGame = useCallback(() => {
    stopFrame();
    exitPointerLock();
    setStatus("finished");
  }, [exitPointerLock, stopFrame]);

  const materializeBullets = useCallback((next: PixelBulletDraft[]) => {
    return next.map((bullet) => ({
      ...bullet,
      id: bulletIdRef.current++,
    }));
  }, []);

  const addBullets = useCallback((next: PixelBulletDraft[]) => {
    const withIds = materializeBullets(next);
    bulletsRef.current = [...bulletsRef.current, ...withIds];
    setBullets(bulletsRef.current);
  }, [materializeBullets]);

  const releaseUltimate = useCallback(() => {
    if (energyRef.current < ENERGY_MAX || status !== "playing") return;
    if (itemsRef.current.length === 0) return;
    const originX = pikoXRef.current;
    const originY = 62;
    let scoreDelta = 0;
    const caughtDelta = itemsRef.current.length;
    for (const item of itemsRef.current) {
      scoreDelta += scoreFor(item.kind);
      addHitSpark(item.x, item.y, item.kind);
    }
    energyRef.current = 0;
    energyNearlyReadyAnnouncedRef.current = false;
    energyReadyAnnouncedRef.current = false;
    setEnergy(0);
    addBurstEffect(originX, originY, "ultimate");
    playUltimateSound();
    showFloatingFeedback("pikoMiniGame.float.ultimate");
    itemsRef.current = [];
    setItems(itemsRef.current);
    comboRef.current += caughtDelta;
    if (comboRef.current > maxComboRef.current) {
      maxComboRef.current = comboRef.current;
      setMaxCombo(comboRef.current);
    }
    setScore((prev) => {
      const nextScore = prev + scoreDelta;
      scoreRef.current = nextScore;
      return nextScore;
    });
    setCaught((prev) => prev + caughtDelta);
    triggerScorePulse();
  }, [addBurstEffect, addHitSpark, showFloatingFeedback, status, triggerScorePulse]);

  const activatePowerUp = useCallback(
    (kind: PowerUpKind, x: number, y: number, now: number) => {
      powerUpsCaughtRef.current += 1;
      powerUpUsesRef.current = {
        ...powerUpUsesRef.current,
        [kind]: powerUpUsesRef.current[kind] + 1,
      };
      setPowerUpsCaught(powerUpsCaughtRef.current);
      setPowerUpUses(powerUpUsesRef.current);
      addEnergy(ENERGY_POWER_UP_GAIN);
      playPowerUpSound();
      showFloatingFeedback(`pikoMiniGame.float.powerUp.${kind}`);
      addBurstEffect(x, y);

      activePowerUpRef.current = kind;
      activePowerUpUntilRef.current =
        now + (kind === "magnet" ? MAGNET_DURATION_MS : kind === "rapid" ? RAPID_DURATION_MS : JELLY_DURATION_MS);
      setActivePowerUp(kind);
    },
    [addBurstEffect, addEnergy, showFloatingFeedback],
  );

  const fireBullet = useCallback(() => {
    const now = performance.now();
    const cooldown = activePowerUpRef.current === "rapid" ? RAPID_FIRE_COOLDOWN_MS : FIRE_COOLDOWN_MS;
    if (now - lastFireRef.current < cooldown) return;
    lastFireRef.current = now;
    const nextBullets: PixelBulletDraft[] = [{ x: pikoXRef.current, y: 82 }];
    playFireSound(pikoXRef.current, activePowerUpRef.current === "rapid");
    addBullets(nextBullets);
  }, [addBullets]);

  const stopAutoFire = useCallback(() => {
    if (fireHoldTimerRef.current !== null) {
      window.clearTimeout(fireHoldTimerRef.current);
      fireHoldTimerRef.current = null;
    }
  }, []);

  const scheduleAutoFire = useCallback(() => {
    stopAutoFire();
    if (!isSpaceHeldRef.current) return;
    const delay = activePowerUpRef.current === "rapid" ? RAPID_FIRE_COOLDOWN_MS : FIRE_COOLDOWN_MS;
    fireHoldTimerRef.current = window.setTimeout(() => {
      fireHoldTimerRef.current = null;
      if (!isSpaceHeldRef.current) return;
      fireBullet();
      scheduleAutoFire();
    }, delay);
  }, [fireBullet, stopAutoFire]);

  useEffect(() => {
    if (!open) return;
    resetGame();
    setStatus("idle");
    setActiveGameId("inspiration-station");
    setStationView("library");
    return () => {
      stopFrame();
      exitPointerLock();
      stopBgm();
      clearTransientTimers();
      clearScorePulseTimers();
    };
  }, [clearScorePulseTimers, clearTransientTimers, exitPointerLock, open, resetGame, stopFrame]);

  useEffect(() => {
    if (!open || status !== "playing") return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "KeyQ") {
        event.preventDefault();
        releaseUltimate();
        return;
      }
      if (event.code !== "Space") return;
      event.preventDefault();
      if (isSpaceHeldRef.current) return;
      isSpaceHeldRef.current = true;
      fireBullet();
      scheduleAutoFire();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      isSpaceHeldRef.current = false;
      stopAutoFire();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      isSpaceHeldRef.current = false;
      stopAutoFire();
    };
  }, [fireBullet, open, releaseUltimate, scheduleAutoFire, status, stopAutoFire]);

  useEffect(() => {
    if (!open || status !== "countdown") return;
    let nextCount = 3;
    setCountdown(nextCount);
    playCountdownSound(nextCount);
    const timer = window.setInterval(() => {
      nextCount -= 1;
      if (nextCount <= 0) {
        window.clearInterval(timer);
        beginPlaying();
        return;
      }
      setCountdown(nextCount);
      playCountdownSound(nextCount);
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [beginPlaying, open, status]);

  useEffect(() => {
    if (!open || status !== "playing") return;

    const startedAt = startedAtRef.current || performance.now();
    startedAtRef.current = startedAt;

    const tick = (now: number) => {
      const last = lastFrameRef.current ?? now;
      const delta = Math.min(0.034, (now - last) / 1000);
      lastFrameRef.current = now;

      const remaining = Math.max(0, GAME_DURATION_MS - (now - startedAt));
      const elapsed = now - startedAt;
      const phase = phaseForElapsed(elapsed);
      const isRush = phase === "rush";
      setTimeLeft(Math.ceil(remaining / 1000));
      if (remaining <= 0) {
        finishGame();
        return;
      }

      if (isRush && !rushAnnouncedRef.current) {
        rushAnnouncedRef.current = true;
        setRushActive(true);
        showFloatingFeedback("pikoMiniGame.float.rush");
      }

      if (activePowerUpRef.current && now > activePowerUpUntilRef.current) {
        activePowerUpRef.current = null;
        activePowerUpUntilRef.current = 0;
        setActivePowerUp(null);
      }

      if (now > nextEventAtRef.current && remaining < GAME_DURATION_MS - 8_000) {
        rainUntilRef.current = now + RAIN_EVENT_MS;
        nextEventAtRef.current = now + 14_000 + Math.random() * 9_000;
        rainEventsRef.current += 1;
        setRainEvents(rainEventsRef.current);
        showFloatingFeedback("pikoMiniGame.float.rain");
      }

      const magnetActive = activePowerUpRef.current === "magnet";
      const jellyActive = activePowerUpRef.current === "jelly";
      const speedScale = jellyActive ? 0.42 : 1;
      const movedItems = itemsRef.current.map((item) => {
        const swayX = item.sway > 0 ? Math.sin(now / 620 + item.wave) * item.sway * delta * 16 : 0;
        const magnetPull =
          magnetActive && Math.abs(item.x - pikoXRef.current) < 26
            ? (pikoXRef.current - item.x) * delta * 2.8
            : 0;
        return {
          ...item,
          x: clamp(item.x + item.drift * delta + swayX + magnetPull, 5, 95),
          y: item.y + item.speed * delta * speedScale,
          spin: item.spin + (item.kind === "burst" ? 18 : item.kind === "combo" ? -24 : 10) * delta,
        };
      });
      if (movedItems.some((item) => item.y >= 104)) {
        comboRef.current = 0;
        setComboStage(0);
      }
      let nextItems = movedItems.filter((item) => item.y < 104);
      let nextPowerUps = powerUpsRef.current
        .map((powerUp) => ({
          ...powerUp,
          x: clamp(powerUp.x + Math.sin(now / 520 + powerUp.wave) * delta * 10, 6, 94),
          y: powerUp.y + powerUp.speed * delta * speedScale,
          spin: powerUp.spin + 42 * delta,
        }))
        .filter((powerUp) => powerUp.y < 105);
      let nextBullets = bulletsRef.current
        .map((bullet) => ({
          ...bullet,
          y: bullet.y - BULLET_SPEED * delta,
        }))
        .filter((bullet) => bullet.y > -5);
      const hitItemIds = new Set<number>();
      const hitBulletIds = new Set<number>();
      let scoreDelta = 0;
      let caughtDelta = 0;
      let hitKind: FallingKind | null = null;
      let hitSoundX = 50;

      const caughtPowerUpIds = new Set<number>();
      for (const powerUp of nextPowerUps) {
        const isCaught =
          Math.abs(powerUp.x - pikoXRef.current) <= POWER_UP_CATCH_X_RANGE &&
          Math.abs(powerUp.y - 78) <= POWER_UP_CATCH_Y_RANGE;
        if (!isCaught) continue;
        caughtPowerUpIds.add(powerUp.id);
        activatePowerUp(powerUp.kind, powerUp.x, powerUp.y, now);
      }
      if (caughtPowerUpIds.size > 0) {
        nextPowerUps = nextPowerUps.filter((powerUp) => !caughtPowerUpIds.has(powerUp.id));
      }

      for (const bullet of nextBullets) {
        for (const item of nextItems) {
          if (hitItemIds.has(item.id)) continue;
          const isHit =
            Math.abs(bullet.x - item.x) <= HIT_RANGE + item.size / 2 &&
            Math.abs(bullet.y - item.y) <= HIT_RANGE + item.size / 2;
          if (!isHit) continue;
          hitItemIds.add(item.id);
          hitBulletIds.add(bullet.id);
          hitKind = item.kind;
          hitSoundX = item.x;
          addHitSpark(item.x, item.y, item.kind);
          if (item.kind === "burst") {
            burstHitsRef.current += 1;
            setBurstHits(burstHitsRef.current);
            addBurstEffect(item.x, item.y);
            for (const nearby of nextItems) {
              const distance = Math.hypot(nearby.x - item.x, nearby.y - item.y);
              if (distance <= BURST_RADIUS) {
                hitItemIds.add(nearby.id);
                if (nearby.id !== item.id) addHitSpark(nearby.x, nearby.y, nearby.kind);
              }
            }
            showFloatingFeedback("pikoMiniGame.float.burst");
          }
          if (item.kind === "combo") {
            comboBoostUntilRef.current = now + COMBO_BOOST_MS;
            showFloatingFeedback("pikoMiniGame.float.comboBoost");
          }
          break;
        }
      }

      if (hitItemIds.size > 0) {
        const multiplier = now < comboBoostUntilRef.current ? 2 : 1;
        for (const item of nextItems) {
          if (!hitItemIds.has(item.id)) continue;
          scoreDelta += scoreFor(item.kind) * multiplier;
          caughtDelta += 1;
        }
        const previousCombo = comboRef.current;
        comboRef.current += caughtDelta;
        if (comboRef.current > maxComboRef.current) {
          maxComboRef.current = comboRef.current;
          setMaxCombo(comboRef.current);
        }
        if (Math.floor(previousCombo / 5) < Math.floor(comboRef.current / 5)) {
          showFloatingFeedback("pikoMiniGame.float.combo", { count: comboRef.current });
        }
        if (previousCombo < 5 && comboRef.current >= 5) setComboStage(1);
        if (previousCombo < 10 && comboRef.current >= 10) setComboStage(2);
        if (previousCombo < 15 && comboRef.current >= 15) setComboStage(3);
        nextItems = nextItems.filter((item) => !hitItemIds.has(item.id));
        nextBullets = nextBullets.filter((bullet) => !hitBulletIds.has(bullet.id));
        if (hitKind) playHitSound(hitKind, hitSoundX, comboRef.current, now < rainUntilRef.current);
        setScore((prev) => {
          const nextScore = Math.max(0, prev + scoreDelta);
          scoreRef.current = nextScore;
          return nextScore;
        });
        triggerScorePulse();
        addEnergy(caughtDelta * ENERGY_HIT_GAIN);
        if (caughtDelta > 0) setCaught((prev) => prev + caughtDelta);
      }

      const spawnInterval = now < rainUntilRef.current ? RAIN_SPAWN_INTERVAL_MS : spawnIntervalFor(phase);
      if (now - lastSpawnRef.current > spawnInterval) {
        lastSpawnRef.current = now;
        nextItems = [...nextItems, makeItem(itemIdRef.current++, phase)];
      }

      if (
        elapsed > POWER_UP_START_DELAY_MS &&
        now > nextPowerUpAtRef.current &&
        powerUpsDroppedRef.current < MAX_POWER_UP_DROPS
      ) {
        powerUpsDroppedRef.current += 1;
        const nextPowerUp = makePowerUp(powerUpIdRef.current++, phase, lastPowerUpKindRef.current);
        lastPowerUpKindRef.current = nextPowerUp.kind;
        nextPowerUps = [...nextPowerUps, nextPowerUp];
        nextPowerUpAtRef.current = scheduleNextPowerUp(now - (isRush ? 1_800 : 0));
      }

      itemsRef.current = nextItems;
      powerUpsRef.current = nextPowerUps;
      bulletsRef.current = nextBullets;
      setItems(nextItems);
      setPowerUps(nextPowerUps);
      setBullets(nextBullets);

      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame((now) => {
      lastSpawnRef.current = now;
      tick(now);
    });

    return stopFrame;
  }, [
    activatePowerUp,
    addBurstEffect,
    addEnergy,
    addHitSpark,
    finishGame,
    open,
    showFloatingFeedback,
    status,
    stopFrame,
    triggerScorePulse,
  ]);

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (status !== "playing") return;
    const rect = boardRef.current?.getBoundingClientRect();
    if (!rect) return;
    const nextX =
      document.pointerLockElement === boardRef.current
        ? clamp(pikoXRef.current + (event.movementX / rect.width) * 100, 8, 92)
        : clamp(((event.clientX - rect.left) / rect.width) * 100, 8, 92);
    pikoXRef.current = nextX;
    setPikoX(nextX);
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (status !== "playing") return;
    requestPointerLock();
    handlePointerMove(event);
    fireBullet();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/64 px-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="piko-mini-game-title"
    >
      <div className="w-full max-w-[900px] overflow-hidden rounded-[22px] border border-white/[0.12] bg-[#0b0d10]/92 shadow-[0_26px_90px_rgba(0,0,0,0.48)]">
        <div className="flex items-start justify-between gap-4 px-6 pb-4 pt-5">
          <h2 id="piko-mini-game-title" className="sr-only">
            {stationView === "library" ? t("pikoMiniGame.libraryTitle") : t(activeGameTitleKey)}
          </h2>
          <div className="flex min-h-9 min-w-0 items-center gap-4">
            {stationView === "library" ? (
              <div className="min-w-0">
                <div className="text-base font-semibold text-white">{t("pikoMiniGame.libraryTitle")}</div>
                <div className="mt-1 text-xs text-white/48">{t("pikoMiniGame.librarySubtitle")}</div>
              </div>
            ) : activeGameId === "inspiration-station" ? (
              <>
                <button
                  type="button"
                  className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-white/68 transition-colors hover:bg-white/[0.08] hover:text-white"
                  aria-label={t("pikoMiniGame.backToLibrary")}
                  onClick={backToLibrary}
                >
                  <ArrowLeft className="size-4" />
                </button>
                <span
                  className={cn(
                    "inline-flex items-center text-sm text-white/78 transition-transform duration-200",
                    scorePulse && "animate-[piko-mini-score-pulse_260ms_cubic-bezier(0.2,1.25,0.3,1)_both]",
                  )}
                >
                  <span className="mr-1 text-cyan-200" aria-hidden>
                    ✦
                  </span>
                  {t("pikoMiniGame.score", { score })}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-white/58">{t("pikoMiniGame.energy")}</span>
                  <div
                    className={cn(
                      "h-1.5 w-28 overflow-hidden rounded-full bg-white/[0.1] transition-shadow duration-200",
                      energy >= ENERGY_MAX && "shadow-[0_0_16px_rgba(103,232,249,0.32)] ring-1 ring-cyan-100/35",
                    )}
                  >
                    <div
                      className={cn(
                        "h-full rounded-full bg-cyan-300 transition-[width,filter] duration-200",
                        energy >= ENERGY_MAX && "animate-[piko-mini-energy-ready_820ms_ease-in-out_infinite]",
                      )}
                      style={{ width: `${energy}%` }}
                    />
                  </div>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[10px] font-semibold leading-none transition-[background-color,border-color,color,transform,box-shadow] duration-200",
                      energy >= ENERGY_MAX
                        ? "scale-110 border-cyan-100/60 bg-cyan-200/[0.18] text-cyan-50 shadow-[0_0_14px_rgba(103,232,249,0.34)] animate-[piko-mini-energy-ready_820ms_ease-in-out_infinite]"
                        : "border-white/10 text-white/38",
                    )}
                  >
                    Q
                  </span>
                </div>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-white/68 transition-colors hover:bg-white/[0.08] hover:text-white"
                  aria-label={t("pikoMiniGame.backToLibrary")}
                  onClick={backToLibrary}
                >
                  <ArrowLeft className="size-4" />
                </button>
                <div className="min-w-0">
                  <div className="text-base font-semibold text-white">{t(activeGameTitleKey)}</div>
                </div>
              </>
            )}
          </div>
          <div className="flex items-center gap-1">
            {stationView === "game" && (activeGameId === "inspiration-station" || activeGameId === "breakout" || activeGameId === "rolling-ball" || activeGameId === "flying" || activeGameId === "catch" || activeGameId === "leap") ? (
              <button
                type="button"
                className="inline-flex size-9 items-center justify-center rounded-full text-white/68 transition-colors hover:bg-white/[0.08] hover:text-white"
                aria-label={isAudioMuted ? t("pikoMiniGame.audioOn") : t("pikoMiniGame.audioOff")}
                onClick={() => setIsAudioMuted((current) => !current)}
              >
                {isAudioMuted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
              </button>
            ) : null}
            <button
              type="button"
              className="inline-flex size-9 items-center justify-center rounded-full text-white/68 transition-colors hover:bg-white/[0.08] hover:text-white"
              aria-label={t("common.close")}
              onClick={onClose}
            >
              <X className="size-5" />
            </button>
          </div>
        </div>

        <div className="px-6 pb-6">
          {stationView === "library" ? (
            <div className="h-[520px] overflow-y-auto pr-1">
              <div className="grid grid-cols-3 gap-3 sm:gap-4">
                {PIKO_GAME_LIBRARY.map((game) => (
                  <button
                    key={game.id}
                    type="button"
                    className="group flex aspect-square min-h-0 flex-col items-center justify-center gap-3 rounded-2xl border border-white/[0.12] bg-white/[0.04] p-3 text-center transition-[border-color,background-color,transform] hover:-translate-y-0.5 hover:border-cyan-200/40 hover:bg-cyan-200/[0.08] focus:outline-none focus:ring-2 focus:ring-cyan-200/45"
                    onClick={() => openGame(game.id)}
                  >
                    <span className="grid size-14 place-items-center rounded-2xl border border-cyan-100/24 bg-cyan-200/[0.1] text-cyan-100 shadow-[0_0_24px_rgba(103,232,249,0.14)] transition-colors group-hover:border-cyan-100/40 group-hover:bg-cyan-200/[0.16]">
                      <Gamepad2 className="size-7" />
                    </span>
                    <span className="max-w-full break-words text-xs font-medium leading-snug text-white/82 sm:text-sm">
                      {t(game.titleKey)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : activeGameId === "memory-match" ? (
            <PikoMemoryMatchGame onClose={onClose} />
          ) : activeGameId === "breakout" ? (
            <PikoBreakoutGame onClose={onClose} muted={isAudioMuted} />
          ) : activeGameId === "rolling-ball" ? (
            <PikoRollingBallGame onClose={onClose} muted={isAudioMuted} />
          ) : activeGameId === "flying" ? (
            <PikoFlyingGame onClose={onClose} muted={isAudioMuted} />
          ) : activeGameId === "catch" ? (
            <PikoCatchGame onClose={onClose} muted={isAudioMuted} />
          ) : activeGameId === "leap" ? (
            <PikoLeapGame onClose={onClose} muted={isAudioMuted} />
          ) : (
            <div
              ref={boardRef}
              className="relative h-[520px] overflow-hidden"
              onPointerMove={handlePointerMove}
              onPointerDown={handlePointerDown}
            >
            <div className="absolute right-4 top-4 z-10 text-sm text-white/78">
              <span>{t("pikoMiniGame.timeLeft", { seconds: timeLeft })}</span>
            </div>

            {activePowerUpLabel ? (
              <div className="pointer-events-none absolute left-1/2 top-11 z-20 -translate-x-1/2 rounded-full border border-lime-100/20 bg-lime-200/[0.08] px-3 py-1 text-xs font-medium text-lime-100/90 shadow-[0_0_18px_rgba(217,249,157,0.16)]">
                {t("pikoMiniGame.activePowerUp", { powerUp: activePowerUpLabel })}
              </div>
            ) : null}

            {energy >= ENERGY_MAX && status === "playing" ? (
              <div className="pointer-events-none absolute left-1/2 top-[17%] z-20 -translate-x-1/2 rounded-full border border-cyan-100/30 bg-cyan-200/[0.1] px-4 py-2 text-sm font-semibold text-cyan-50 shadow-[0_0_28px_rgba(103,232,249,0.22)] backdrop-blur-sm animate-[piko-mini-ready-chip_1100ms_ease-in-out_infinite]">
                {t("pikoMiniGame.ultimateReady")}
              </div>
            ) : null}

            <div
              className={cn(
                "absolute inset-0 opacity-76 transition-opacity duration-300 [background-image:linear-gradient(rgba(165,243,252,0.105)_1px,transparent_1px),linear-gradient(90deg,rgba(165,243,252,0.09)_1px,transparent_1px),linear-gradient(rgba(255,255,255,0.06)_2px,transparent_2px),linear-gradient(90deg,rgba(255,255,255,0.052)_2px,transparent_2px)] [background-size:44px_44px,44px_44px,176px_176px,176px_176px]",
                comboStage >= 2 && "opacity-86",
                comboStage >= 3 && "opacity-95",
                rushActive && "opacity-100",
              )}
            />

            {items.map((item) => (
              <span
                key={item.id}
                className={cn(
                  "absolute grid place-items-center font-semibold leading-none text-cyan-50 drop-shadow-[0_0_18px_rgba(165,243,252,0.5)]",
                  item.kind === "spark" && "text-[34px]",
                  item.kind === "crystal" && "text-[38px] text-amber-100 drop-shadow-[0_0_18px_rgba(253,230,138,0.42)]",
                  item.kind === "combo" && "text-[36px] text-lime-100 drop-shadow-[0_0_18px_rgba(217,249,157,0.38)]",
                  item.kind === "burst" && "text-[42px] text-fuchsia-100 drop-shadow-[0_0_22px_rgba(245,208,254,0.44)]",
                )}
                style={{
                  left: `${item.x}%`,
                  top: `${item.y}%`,
                  width: `${item.size}%`,
                  aspectRatio: "1",
                  transform: `translate(-50%, -50%) rotate(${item.spin}deg)`,
                }}
              >
                {KIND_LABEL[item.kind]}
              </span>
            ))}

            {powerUps.map((powerUp) => (
              <span
                key={powerUp.id}
                className={cn(
                  "absolute z-10 grid size-12 place-items-center rounded-full border text-2xl font-semibold leading-none shadow-[0_0_24px_rgba(255,255,255,0.16)] backdrop-blur-sm animate-[piko-mini-power-up_900ms_ease-in-out_infinite]",
                  powerUp.kind === "magnet" &&
                    "border-sky-100/42 bg-sky-200/[0.12] text-sky-100 drop-shadow-[0_0_18px_rgba(186,230,253,0.46)]",
                  powerUp.kind === "rapid" &&
                    "border-amber-100/42 bg-amber-200/[0.12] text-amber-100 drop-shadow-[0_0_18px_rgba(253,230,138,0.46)]",
                  powerUp.kind === "jelly" &&
                    "border-violet-100/42 bg-violet-200/[0.12] text-violet-100 drop-shadow-[0_0_18px_rgba(221,214,254,0.46)]",
                )}
                style={{
                  left: `${powerUp.x}%`,
                  top: `${powerUp.y}%`,
                  transform: `translate(-50%, -50%) rotate(${powerUp.spin}deg)`,
                }}
                aria-label={t(`pikoMiniGame.powerUps.${powerUp.kind}`)}
              >
                {POWER_UP_LABEL[powerUp.kind]}
              </span>
            ))}

            {burstEffects.map((effect) => (
              <span
                key={effect.id}
                className={cn(
                  "pointer-events-none absolute z-10 rounded-full border animate-[piko-mini-burst_620ms_cubic-bezier(0.16,1,0.3,1)_both]",
                  effect.kind === "ultimate"
                    ? "size-80 border-cyan-100/70 bg-cyan-200/[0.08] shadow-[0_0_64px_rgba(165,243,252,0.42)]"
                    : "size-20 border-fuchsia-100/70 bg-fuchsia-200/[0.08] shadow-[0_0_34px_rgba(245,208,254,0.42)]",
                )}
                style={{
                  left: `${effect.x}%`,
                  top: `${effect.y}%`,
                  transform: "translate(-50%, -50%)",
                }}
              />
            ))}

            {hitSparks.map((spark) => (
              <span
                key={spark.id}
                className={cn(
                  "pointer-events-none absolute z-20 grid size-10 place-items-center rounded-full text-xl leading-none text-cyan-100 drop-shadow-[0_0_16px_rgba(165,243,252,0.62)] animate-[piko-mini-hit-spark_460ms_cubic-bezier(0.16,1,0.3,1)_both]",
                  spark.kind === "crystal" && "text-amber-100 drop-shadow-[0_0_18px_rgba(253,230,138,0.5)]",
                  spark.kind === "combo" && "text-lime-100 drop-shadow-[0_0_18px_rgba(217,249,157,0.48)]",
                  spark.kind === "burst" && "text-fuchsia-100 drop-shadow-[0_0_20px_rgba(245,208,254,0.52)]",
                )}
                style={{
                  left: `${spark.x}%`,
                  top: `${spark.y}%`,
                  transform: "translate(-50%, -50%)",
                }}
              >
                ✦
              </span>
            ))}

            {floatingFeedback ? (
              <div
                key={floatingFeedback.id}
                className="pointer-events-none absolute left-1/2 top-[22%] z-20 -translate-x-1/2 rounded-full border border-cyan-100/18 bg-black/36 px-4 py-2 text-sm font-medium text-cyan-100/90 shadow-[0_10px_36px_rgba(0,0,0,0.26)] backdrop-blur-sm animate-[piko-mini-feedback_1050ms_ease-out_both]"
              >
                {t(floatingFeedback.key, floatingFeedback.values)}
              </div>
            ) : null}

            {bullets.map((bullet) => (
              <span
                key={bullet.id}
                className="absolute block size-1.5 rounded-[2px] bg-cyan-100 shadow-[0_0_10px_rgba(165,243,252,0.86)]"
                style={{
                  left: `${bullet.x}%`,
                  top: `${bullet.y}%`,
                  transform: "translate(-50%, -50%)",
                }}
              />
            ))}

            <div
              className={cn(
                "absolute bottom-[4%] z-20 isolate size-[62px] -translate-x-1/2",
                comboStage >= 1 && "drop-shadow-[0_0_12px_rgba(165,243,252,0.36)]",
                comboStage >= 2 && "animate-[piko-mini-combo-glow_900ms_ease-in-out_infinite]",
                activePowerUp && "drop-shadow-[0_0_18px_rgba(217,249,157,0.34)]",
              )}
              style={{ left: `${pikoX}%` }}
            >
              <PikoActionFigure
                action="typing"
                className="mybuddy-companion-anchor--preview !h-[62px]"
                style={{ transform: "scale(0.82)", transformOrigin: "center" }}
              />
            </div>

            {status !== "playing" ? (
              <div
                className={cn(
                  "absolute inset-0 z-30 flex items-center justify-center bg-black/38 px-5 backdrop-blur-[2px]",
                  (status === "idle" || status === "countdown") && "items-start pt-[152px]",
                  status === "finished" && "bg-black/58 backdrop-blur-md",
                )}
              >
                <div className={cn(
                  "max-w-sm text-center",
                  status === "finished" &&
                    "rounded-2xl border border-white/[0.22] bg-black/64 px-8 py-7 shadow-[0_24px_72px_rgba(0,0,0,0.58)] backdrop-blur-xl",
                )}>
                  {status === "finished" ? (
                    <>
                      <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl" aria-hidden="true">
                        {FINALE_CONFETTI.map((piece) => (
                          <span
                            key={piece.id}
                            className="absolute left-1/2 top-0 size-2 rounded-[2px] opacity-0 animate-[piko-mini-finale-confetti_1400ms_cubic-bezier(0.2,0.78,0.28,1)_both]"
                            style={{
                              background: piece.color,
                              animationDelay: piece.delay,
                              transform: `translate(-50%, 0) rotate(${piece.id * 17}deg)`,
                              "--piko-mini-confetti-x": piece.x,
                              "--piko-mini-confetti-y": piece.y,
                              "--piko-mini-confetti-rotate": piece.rotate,
                            } as React.CSSProperties}
                          />
                        ))}
                      </div>
                      <p className="text-sm font-medium text-cyan-100/78">
                        {t("pikoMiniGame.resultMeta", { caught })}
                      </p>
                      <h3 className="mt-2 text-2xl font-semibold text-white">
                        {t(feedbackKey, { combo: maxCombo })}
                      </h3>
                      <p className="mt-2 text-sm text-white/58">
                        {t(resultInsightKey)}
                      </p>
                      <div className="mt-5 grid grid-cols-3 gap-2 text-center">
                        <div className="rounded-xl border border-white/[0.08] bg-white/[0.04] px-2 py-2">
                          <div className="text-base font-semibold text-white">{maxCombo}</div>
                          <div className="mt-0.5 text-[11px] text-white/62">{t("pikoMiniGame.result.maxCombo")}</div>
                        </div>
                        <div className="rounded-xl border border-white/[0.08] bg-white/[0.04] px-2 py-2">
                          <div className="text-base font-semibold text-white">{powerUpsCaught}</div>
                          <div className="mt-0.5 text-[11px] text-white/62">{t("pikoMiniGame.result.powerUps")}</div>
                        </div>
                        <div className="rounded-xl border border-white/[0.08] bg-white/[0.04] px-2 py-2">
                          <div className="text-base font-semibold text-white">{score}</div>
                          <div className="mt-0.5 text-[11px] text-white/62">{t("pikoMiniGame.result.score")}</div>
                        </div>
                      </div>
                    </>
                  ) : status === "countdown" ? (
                    <>
                      <div className="font-[PikoCountdownPixel] text-7xl font-semibold leading-none text-white drop-shadow-[0_0_18px_rgba(165,243,252,0.24)]">
                        {countdown}
                      </div>
                      <p className="mt-4 text-sm text-white/68">
                        {t("pikoMiniGame.countdownHint")}
                      </p>
                    </>
                  ) : (
                    <>
                      <h3 className="text-2xl font-semibold tracking-normal text-white">
                        {t("pikoMiniGame.title")}
                      </h3>
                      <p className="mt-3 text-sm text-white/68">
                        {t("pikoMiniGame.idleHint")}
                      </p>
                    </>
                  )}
                  <div className={cn(
                    "flex justify-center gap-3",
                    status === "countdown" ? "mt-0 hidden" : "mt-6",
                  )}>
                    {status === "finished" ? (
                      <button
                        type="button"
                        className="h-10 rounded-full border border-white/[0.14] px-5 text-sm text-white/78 transition-colors hover:bg-white/[0.08] hover:text-white"
                        onClick={onClose}
                      >
                        {t("pikoMiniGame.backToWork")}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={cn(
                        "rounded-full bg-cyan-300 text-sm font-medium text-slate-950 transition-colors hover:bg-cyan-200",
                        status === "finished" ? "h-10 px-5" : "h-9 px-4",
                      )}
                      onClick={startGame}
                    >
                      {status === "finished" ? t("pikoMiniGame.playAgain") : t("pikoMiniGame.start")}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
          )}
        </div>
      </div>
    </div>
  );
}
