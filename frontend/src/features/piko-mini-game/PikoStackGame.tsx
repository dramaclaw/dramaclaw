// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PikoGameHud, PikoGameOverlay } from "@/features/piko-mini-game/PikoGameChrome";
import { usePikoGameAudio } from "@/features/piko-mini-game/usePikoGameAudio";

const BOARD_WIDTH = 800;
const BOARD_HEIGHT = 520;
const PLATFORM_Y = 430;
const LEVEL_COUNT = 3;

type StackStatus = "ready" | "playing" | "levelClear" | "won" | "lost";
type PropKind = "jelly" | "bulb" | "gear" | "bottle" | "spring" | "critter";
type FeedbackKind = "perfect" | "steady" | "assist" | "danger" | null;

type StackProp = {
  id: number;
  kind: PropKind;
  x: number;
  y: number;
  width: number;
  height: number;
  mass: number;
  velocityY: number;
  rotation: number;
  dropping: boolean;
  landed: boolean;
};

type LevelConfig = {
  target: number;
  platformWidth: number;
  fallSpeed: number;
  wind: number;
  sequence: readonly PropKind[];
};

const PROP_SPECS: Record<PropKind, Pick<StackProp, "width" | "height" | "mass">> = {
  jelly: { width: 64, height: 48, mass: 1 },
  bulb: { width: 48, height: 58, mass: 0.8 },
  gear: { width: 66, height: 62, mass: 1.65 },
  bottle: { width: 40, height: 72, mass: 0.85 },
  spring: { width: 56, height: 44, mass: 0.7 },
  critter: { width: 72, height: 50, mass: 1.1 },
};

const STACK_LEVELS: readonly LevelConfig[] = [
  {
    target: 6,
    platformWidth: 360,
    fallSpeed: 172,
    wind: 0,
    sequence: ["jelly", "gear", "bulb", "jelly", "bottle", "critter"],
  },
  {
    target: 8,
    platformWidth: 320,
    fallSpeed: 188,
    wind: 12,
    sequence: ["jelly", "spring", "gear", "bulb", "critter", "bottle", "jelly", "gear"],
  },
  {
    target: 10,
    platformWidth: 286,
    fallSpeed: 206,
    wind: 22,
    sequence: ["gear", "bottle", "spring", "critter", "bulb", "jelly", "gear", "bottle", "critter", "spring"],
  },
];

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function drawPixelFace(context: CanvasRenderingContext2D, width: number, worried = false) {
  context.fillStyle = "#071018";
  context.fillRect(-width * 0.18, -3, 5, worried ? 8 : 6);
  context.fillRect(width * 0.18 - 5, -3, 5, worried ? 8 : 6);
  context.strokeStyle = "rgba(7,16,24,0.78)";
  context.lineWidth = 2;
  context.beginPath();
  if (worried) context.arc(0, 13, 5, Math.PI, 0);
  else context.arc(0, 7, 6, 0.18, Math.PI - 0.18);
  context.stroke();
}

function drawStackProp(context: CanvasRenderingContext2D, prop: StackProp, now: number, ghost = false) {
  const alpha = ghost ? 0.72 : 1;
  const wobble = prop.kind === "critter" && prop.landed ? Math.sin(now / 170 + prop.id) * 1.5 : 0;
  context.save();
  context.translate(prop.x + wobble, prop.y);
  context.rotate(prop.rotation);
  context.globalAlpha = alpha;
  context.shadowColor = ghost ? "rgba(165,243,252,0.32)" : "rgba(103,232,249,0.2)";
  context.shadowBlur = ghost ? 18 : 10;

  if (prop.kind === "jelly") {
    const gradient = context.createLinearGradient(-32, -24, 32, 24);
    gradient.addColorStop(0, "#a3e635");
    gradient.addColorStop(1, "#22d3ee");
    context.fillStyle = gradient;
    roundedRect(context, -32, -24, 64, 48, 13);
    context.fill();
    drawPixelFace(context, 64);
  } else if (prop.kind === "bulb") {
    context.fillStyle = "#fde047";
    context.beginPath();
    context.arc(0, -7, 22, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#67e8f9";
    roundedRect(context, -11, 13, 22, 14, 4);
    context.fill();
    context.fillStyle = "rgba(255,255,255,0.8)";
    context.beginPath();
    context.arc(-7, -14, 5, 0, Math.PI * 2);
    context.fill();
    drawPixelFace(context, 44);
  } else if (prop.kind === "gear") {
    context.fillStyle = "#fb7185";
    for (let index = 0; index < 10; index += 1) {
      context.save();
      context.rotate((index / 10) * Math.PI * 2);
      context.fillRect(-6, -35, 12, 13);
      context.restore();
    }
    context.beginPath();
    context.arc(0, 0, 27, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#5b2140";
    context.beginPath();
    context.arc(0, 0, 9, 0, Math.PI * 2);
    context.fill();
  } else if (prop.kind === "bottle") {
    context.fillStyle = "rgba(167,139,250,0.88)";
    roundedRect(context, -20, -27, 40, 58, 9);
    context.fill();
    context.fillStyle = "#fbbf24";
    roundedRect(context, -11, -36, 22, 13, 4);
    context.fill();
    context.fillStyle = "rgba(255,255,255,0.78)";
    context.fillRect(-11, -16, 5, 24);
    context.fillStyle = "#fde047";
    context.beginPath();
    context.arc(5, 8, 6, 0, Math.PI * 2);
    context.fill();
  } else if (prop.kind === "spring") {
    context.strokeStyle = "#67e8f9";
    context.lineWidth = 7;
    context.beginPath();
    context.moveTo(-20, -17);
    context.lineTo(20, -9);
    context.lineTo(-20, 0);
    context.lineTo(20, 9);
    context.lineTo(-20, 17);
    context.stroke();
    context.fillStyle = "#c4b5fd";
    roundedRect(context, -28, 17, 56, 8, 3);
    context.fill();
    roundedRect(context, -28, -25, 56, 8, 3);
    context.fill();
  } else {
    context.fillStyle = "#f9a8d4";
    roundedRect(context, -36, -22, 72, 44, 16);
    context.fill();
    context.strokeStyle = "#f9a8d4";
    context.lineWidth = 4;
    context.beginPath();
    context.moveTo(-19, -20);
    context.lineTo(-25, -31);
    context.moveTo(19, -20);
    context.lineTo(25, -31);
    context.stroke();
    context.fillStyle = "#fde047";
    context.beginPath();
    context.arc(-25, -32, 3, 0, Math.PI * 2);
    context.arc(25, -32, 3, 0, Math.PI * 2);
    context.fill();
    drawPixelFace(context, 72);
  }

  context.restore();
}

function drawPiko(context: CanvasRenderingContext2D, x: number, feetY: number, balance: number, now: number) {
  const sway = Math.sin(now / 150) * Math.min(balance * 4, 2.5);
  context.save();
  context.translate(x + sway, feetY - 27);
  context.rotate(clamp((x - BOARD_WIDTH / 2) / 620, -0.08, 0.08));
  context.shadowColor = "rgba(165,243,252,0.52)";
  context.shadowBlur = 15;
  context.fillStyle = "#f8fafc";
  roundedRect(context, -17, -18, 34, 39, 12);
  context.fill();
  context.shadowBlur = 0;
  context.fillStyle = "#10202a";
  context.fillRect(-8, -4, 4, balance > 0.68 ? 8 : 5);
  context.fillRect(4, -4, 4, balance > 0.68 ? 8 : 5);
  context.strokeStyle = "#f8fafc";
  context.lineWidth = 5;
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(-14, 2);
  context.lineTo(-27 - balance * 5, balance > 0.68 ? -9 : 8);
  context.moveTo(14, 2);
  context.lineTo(27 + balance * 5, balance > 0.68 ? -9 : 8);
  context.stroke();
  context.fillStyle = "#a3e635";
  context.beginPath();
  context.ellipse(3, -23, 8, 4, -0.55, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

export function PikoStackGame({ onClose, muted }: { onClose: () => void; muted: boolean }) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const previousTimeRef = useRef<number | null>(null);
  const spawnTimerRef = useRef<number | null>(null);
  const feedbackTimerRef = useRef<number | null>(null);
  const feedbackRef = useRef<FeedbackKind>(null);
  const statusRef = useRef<StackStatus>("ready");
  const levelIndexRef = useRef(0);
  const propsRef = useRef<StackProp[]>([]);
  const activePropRef = useRef<StackProp | null>(null);
  const cursorXRef = useRef(BOARD_WIDTH / 2);
  const propIdRef = useRef(1);
  const placedRef = useRef(0);
  const scoreRef = useRef(0);
  const streakRef = useRef(0);
  const assistRef = useRef(true);
  const dangerTimeRef = useRef(0);
  const heldKeysRef = useRef({ left: false, right: false });
  const [status, setStatus] = useState<StackStatus>("ready");
  const [levelIndex, setLevelIndex] = useState(0);
  const [placed, setPlaced] = useState(0);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [assist, setAssist] = useState(true);
  const [feedback, setFeedback] = useState<FeedbackKind>(null);
  const playTone = usePikoGameAudio(muted);

  const setGameStatus = useCallback((next: StackStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const showFeedback = useCallback((next: Exclude<FeedbackKind, null>) => {
    feedbackRef.current = next;
    setFeedback(next);
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = window.setTimeout(() => {
      feedbackRef.current = null;
      setFeedback(null);
      feedbackTimerRef.current = null;
    }, next === "danger" ? 900 : 1_100);
  }, []);

  const spawnProp = useCallback(() => {
    if (statusRef.current !== "playing") return;
    const level = STACK_LEVELS[levelIndexRef.current];
    const kind = level.sequence[placedRef.current % level.sequence.length];
    const spec = PROP_SPECS[kind];
    activePropRef.current = {
      id: propIdRef.current++,
      kind,
      x: cursorXRef.current,
      y: 74,
      ...spec,
      velocityY: 0,
      rotation: 0,
      dropping: false,
      landed: false,
    };
  }, []);

  const scheduleSpawn = useCallback(() => {
    if (spawnTimerRef.current !== null) window.clearTimeout(spawnTimerRef.current);
    spawnTimerRef.current = window.setTimeout(() => {
      spawnTimerRef.current = null;
      spawnProp();
    }, 430);
  }, [spawnProp]);

  const prepareLevel = useCallback((nextLevelIndex: number, resetScore: boolean) => {
    if (spawnTimerRef.current !== null) window.clearTimeout(spawnTimerRef.current);
    spawnTimerRef.current = null;
    levelIndexRef.current = nextLevelIndex;
    propsRef.current = [];
    activePropRef.current = null;
    placedRef.current = 0;
    streakRef.current = 0;
    assistRef.current = true;
    dangerTimeRef.current = 0;
    cursorXRef.current = BOARD_WIDTH / 2;
    if (resetScore) scoreRef.current = 0;
    setLevelIndex(nextLevelIndex);
    setPlaced(0);
    setStreak(0);
    setAssist(true);
    setScore(scoreRef.current);
    feedbackRef.current = null;
    setFeedback(null);
    previousTimeRef.current = null;
    setGameStatus("playing");
    spawnProp();
  }, [setGameStatus, spawnProp]);

  const startOrContinue = useCallback(() => {
    if (statusRef.current === "levelClear") prepareLevel(levelIndexRef.current + 1, false);
    else prepareLevel(0, true);
    playTone(330, 0.08, 0.055, "triangle", 0, 520);
    playTone(660, 0.12, 0.045, "triangle", 0.08, 920);
    canvasRef.current?.focus();
  }, [playTone, prepareLevel]);

  const dropActiveProp = useCallback(() => {
    const active = activePropRef.current;
    if (statusRef.current !== "playing" || !active || active.dropping) return;
    active.dropping = true;
    active.velocityY = STACK_LEVELS[levelIndexRef.current].fallSpeed;
    playTone(440, 0.07, 0.04, "triangle", 0, 300);
  }, [playTone]);

  const rescueOrLose = useCallback((missedProp: StackProp | null) => {
    if (assistRef.current) {
      assistRef.current = false;
      setAssist(false);
      dangerTimeRef.current = 0;
      if (missedProp) {
        propsRef.current = propsRef.current.filter((prop) => prop.id !== missedProp.id);
        if (missedProp.landed) {
          placedRef.current = Math.max(0, placedRef.current - 1);
          setPlaced(placedRef.current);
        }
      }
      activePropRef.current = null;
      streakRef.current = 0;
      setStreak(0);
      showFeedback("assist");
      playTone(260, 0.16, 0.065, "triangle", 0, 920);
      scheduleSpawn();
      return;
    }
    activePropRef.current = null;
    setGameStatus("lost");
    playTone(220, 0.32, 0.085, "sawtooth", 0, 62);
  }, [playTone, scheduleSpawn, setGameStatus, showFeedback]);

  const towerBalance = useCallback(() => {
    if (propsRef.current.length === 0) return 0;
    const totalMass = propsRef.current.reduce((sum, prop) => sum + prop.mass, 0);
    const centerOfMass = propsRef.current.reduce((sum, prop) => sum + prop.x * prop.mass, 0) / totalMass;
    return Math.abs(centerOfMass - BOARD_WIDTH / 2) / (STACK_LEVELS[levelIndexRef.current].platformWidth * 0.37);
  }, []);

  const settleProp = useCallback((prop: StackProp, landingY: number, supportX: number, supportWidth: number) => {
    prop.y = landingY - prop.height / 2;
    prop.velocityY = 0;
    prop.dropping = false;
    prop.landed = true;
    const offset = (prop.x - supportX) / Math.max(supportWidth, 1);
    prop.rotation = clamp(offset * 0.18, -0.11, 0.11);
    propsRef.current.push(prop);
    activePropRef.current = null;
    placedRef.current += 1;
    setPlaced(placedRef.current);

    const centered = Math.abs(prop.x - supportX) < Math.min(20, supportWidth * 0.12);
    streakRef.current = centered ? streakRef.current + 1 : 0;
    setStreak(streakRef.current);
    const gained = 100 + (centered ? 50 + streakRef.current * 15 : 0);
    scoreRef.current += gained;
    setScore(scoreRef.current);
    showFeedback(centered ? "perfect" : "steady");
    playTone(centered ? 760 : 520, 0.1, 0.055, "triangle", 0, centered ? 1_180 : 720);

    const level = STACK_LEVELS[levelIndexRef.current];
    if (placedRef.current >= level.target) {
      const isLastLevel = levelIndexRef.current === LEVEL_COUNT - 1;
      setGameStatus(isLastLevel ? "won" : "levelClear");
      playTone(660, 0.12, 0.06, "triangle", 0, 990);
      playTone(990, 0.16, 0.055, "triangle", 0.11, 1_320);
    } else {
      scheduleSpawn();
    }
  }, [playTone, scheduleSpawn, setGameStatus, showFeedback]);

  const draw = useCallback((now: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const pixelWidth = Math.round(rect.width * dpr);
    const pixelHeight = Math.round(rect.height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    context.setTransform(pixelWidth / BOARD_WIDTH, 0, 0, pixelHeight / BOARD_HEIGHT, 0, 0);
    context.clearRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);

    const background = context.createRadialGradient(400, 310, 50, 400, 310, 520);
    background.addColorStop(0, "#112237");
    background.addColorStop(0.58, "#081320");
    background.addColorStop(1, "#050812");
    context.fillStyle = background;
    context.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);

    for (let index = 0; index < 58; index += 1) {
      const x = (index * 149 + 31) % BOARD_WIDTH;
      const y = (index * 79 + 19) % BOARD_HEIGHT;
      const pulse = 0.18 + ((Math.sin(now / 650 + index) + 1) / 2) * 0.28;
      context.fillStyle = index % 7 === 0 ? `rgba(190,242,100,${pulse})` : `rgba(165,243,252,${pulse * 0.7})`;
      context.fillRect(x, y, index % 6 === 0 ? 2 : 1, index % 6 === 0 ? 2 : 1);
    }

    const level = STACK_LEVELS[levelIndexRef.current];
    if (level.wind > 0 && statusRef.current === "playing") {
      context.strokeStyle = "rgba(165,243,252,0.16)";
      context.lineWidth = 2;
      for (let index = 0; index < 7; index += 1) {
        const y = 118 + index * 42;
        const shift = ((now * 0.045 + index * 97) % 170) - 85;
        context.beginPath();
        context.moveTo(400 + shift - 34, y);
        context.lineTo(400 + shift + 34, y - 5);
        context.stroke();
      }
    }

    const balance = towerBalance();
    const platformAngle = clamp((propsRef.current.reduce((sum, prop) => sum + (prop.x - 400) * prop.mass, 0) /
      Math.max(1, propsRef.current.reduce((sum, prop) => sum + prop.mass, 0))) / 1_900, -0.1, 0.1);
    context.save();
    context.translate(BOARD_WIDTH / 2, PLATFORM_Y + 12);
    context.rotate(platformAngle);
    const platformGradient = context.createLinearGradient(-level.platformWidth / 2, 0, level.platformWidth / 2, 0);
    platformGradient.addColorStop(0, "#164e63");
    platformGradient.addColorStop(0.5, balance > 0.72 ? "#f59e0b" : "#0891b2");
    platformGradient.addColorStop(1, "#155e75");
    context.fillStyle = platformGradient;
    context.shadowColor = balance > 0.72 ? "rgba(251,191,36,0.42)" : "rgba(103,232,249,0.34)";
    context.shadowBlur = 18;
    roundedRect(context, -level.platformWidth / 2, -12, level.platformWidth, 24, 10);
    context.fill();
    context.shadowBlur = 0;
    context.strokeStyle = "rgba(207,250,254,0.38)";
    context.lineWidth = 2;
    context.stroke();
    context.fillStyle = "rgba(34,211,238,0.14)";
    context.beginPath();
    context.moveTo(-82, 12);
    context.lineTo(82, 12);
    context.lineTo(52, 64);
    context.lineTo(-52, 64);
    context.closePath();
    context.fill();
    context.restore();

    for (const prop of [...propsRef.current].sort((a, b) => b.y - a.y)) drawStackProp(context, prop, now);
    if (activePropRef.current) {
      const active = activePropRef.current;
      if (!active.dropping) {
        context.setLineDash([6, 9]);
        context.strokeStyle = "rgba(165,243,252,0.22)";
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(active.x, active.y + active.height / 2 + 8);
        context.lineTo(active.x, PLATFORM_Y - 24);
        context.stroke();
        context.setLineDash([]);
      }
      drawStackProp(context, active, now, !active.dropping);
    }

    const highest = propsRef.current.reduce<StackProp | null>((result, prop) =>
      !result || prop.y - prop.height / 2 < result.y - result.height / 2 ? prop : result, null);
    drawPiko(context, highest?.x ?? BOARD_WIDTH / 2, highest ? highest.y - highest.height / 2 : PLATFORM_Y, balance, now);

    const meterWidth = 176;
    context.fillStyle = "rgba(0,0,0,0.32)";
    roundedRect(context, BOARD_WIDTH / 2 - meterWidth / 2, 487, meterWidth, 8, 4);
    context.fill();
    context.fillStyle = balance > 0.78 ? "#fb7185" : balance > 0.56 ? "#fbbf24" : "#a3e635";
    roundedRect(context, BOARD_WIDTH / 2 - meterWidth / 2, 487, Math.max(8, meterWidth * clamp(balance, 0, 1)), 8, 4);
    context.fill();
  }, [towerBalance]);

  useEffect(() => {
    const tick = (now: number) => {
      const previous = previousTimeRef.current ?? now;
      previousTimeRef.current = now;
      const delta = Math.min((now - previous) / 1000, 0.025);

      if (statusRef.current === "playing") {
        const direction = Number(heldKeysRef.current.right) - Number(heldKeysRef.current.left);
        if (direction !== 0 && activePropRef.current && !activePropRef.current.dropping) {
          cursorXRef.current = clamp(cursorXRef.current + direction * 285 * delta, 72, BOARD_WIDTH - 72);
        }
        const active = activePropRef.current;
        if (active && !active.dropping) active.x = cursorXRef.current;
        if (active?.dropping) {
          const level = STACK_LEVELS[levelIndexRef.current];
          const previousBottom = active.y + active.height / 2;
          active.velocityY += 380 * delta;
          active.y += active.velocityY * delta;
          active.x += Math.sin(now / 420 + levelIndexRef.current * 1.7) * level.wind * delta;
          active.rotation += Math.sin(now / 310 + active.id) * 0.08 * delta;
          const currentBottom = active.y + active.height / 2;
          const supports = [
            { y: PLATFORM_Y, x: BOARD_WIDTH / 2, width: level.platformWidth },
            ...propsRef.current.map((prop) => ({ y: prop.y - prop.height / 2, x: prop.x, width: prop.width })),
          ].filter((support) => {
            const overlap = Math.min(active.x + active.width / 2, support.x + support.width / 2) -
              Math.max(active.x - active.width / 2, support.x - support.width / 2);
            return overlap > Math.min(18, active.width * 0.24) && previousBottom <= support.y && currentBottom >= support.y;
          }).sort((a, b) => a.y - b.y);
          const support = supports[0];
          if (support) settleProp(active, support.y, support.x, support.width);
          else if (active.y - active.height / 2 > BOARD_HEIGHT + 20) rescueOrLose(active);
        }

        const balance = towerBalance();
        if (balance > 0.72 && feedbackRef.current !== "danger") showFeedback("danger");
        if (balance > 0.95) dangerTimeRef.current += delta;
        else dangerTimeRef.current = Math.max(0, dangerTimeRef.current - delta * 2);
        if (dangerTimeRef.current > 0.8) {
          const outermost = [...propsRef.current].sort((a, b) => Math.abs(b.x - 400) - Math.abs(a.x - 400))[0] ?? null;
          rescueOrLose(outermost);
        }
      }

      draw(now);
      frameRef.current = window.requestAnimationFrame(tick);
    };
    frameRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    };
  }, [draw, rescueOrLose, settleProp, showFeedback, towerBalance]);

  useEffect(() => {
    const setKey = (event: KeyboardEvent, pressed: boolean) => {
      const key = event.key.toLowerCase();
      if (key === "arrowleft" || key === "a") {
        event.preventDefault();
        heldKeysRef.current.left = pressed;
      } else if (key === "arrowright" || key === "d") {
        event.preventDefault();
        heldKeysRef.current.right = pressed;
      } else if (pressed && (key === " " || key === "enter")) {
        event.preventDefault();
        if (statusRef.current === "playing") dropActiveProp();
        else startOrContinue();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => setKey(event, true);
    const handleKeyUp = (event: KeyboardEvent) => setKey(event, false);
    const releaseKeys = () => {
      heldKeysRef.current.left = false;
      heldKeysRef.current.right = false;
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", releaseKeys);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", releaseKeys);
    };
  }, [dropActiveProp, startOrContinue]);

  useEffect(() => () => {
    if (spawnTimerRef.current !== null) window.clearTimeout(spawnTimerRef.current);
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
  }, []);

  const moveCursor = (clientX: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || activePropRef.current?.dropping) return;
    cursorXRef.current = clamp(((clientX - rect.left) / rect.width) * BOARD_WIDTH, 72, BOARD_WIDTH - 72);
    if (activePropRef.current) activePropRef.current.x = cursorXRef.current;
  };

  const level = STACK_LEVELS[levelIndex];
  const overlayTitle = status === "lost"
    ? t("pikoMiniGame.stackGame.lost")
    : status === "won"
      ? t("pikoMiniGame.stackGame.won")
      : status === "levelClear"
        ? t("pikoMiniGame.stackGame.levelClear")
        : t("pikoMiniGame.stackGame.ready");

  return (
    <div className="relative h-[520px] overflow-hidden border border-white/[0.08] bg-[#050812]">
      <canvas
        ref={canvasRef}
        className="h-full w-full touch-none outline-none"
        tabIndex={0}
        aria-label={t("pikoMiniGame.stackGame.canvasLabel")}
        onPointerMove={(event) => moveCursor(event.clientX)}
        onPointerDown={(event) => {
          moveCursor(event.clientX);
          if (statusRef.current === "playing") dropActiveProp();
        }}
      />

      <PikoGameHud
        left={t("pikoMiniGame.stackGame.score", { score })}
        center={feedback ? t(`pikoMiniGame.stackGame.feedback.${feedback}`, { streak }) : undefined}
        right={t("pikoMiniGame.stackGame.progress", { current: placed, target: level.target })}
      />
      <div className="pointer-events-none absolute bottom-5 left-5 rounded-full border border-white/10 bg-black/28 px-3 py-1.5 text-xs font-medium text-white/68 backdrop-blur-md">
        {t(assist ? "pikoMiniGame.stackGame.assistReady" : "pikoMiniGame.stackGame.assistUsed")}
      </div>

      {status !== "playing" ? (
        <PikoGameOverlay
          title={overlayTitle}
          description={t(status === "won" ? "pikoMiniGame.stackGame.wonHint" : "pikoMiniGame.stackGame.hint")}
          meta={status === "won"
            ? t("pikoMiniGame.stackGame.result", { score })
            : t("pikoMiniGame.stackGame.level", { level: levelIndex + 1, total: LEVEL_COUNT })}
          primaryLabel={status === "levelClear"
            ? t("pikoMiniGame.stackGame.nextLevel")
            : status === "ready"
              ? t("pikoMiniGame.stackGame.start")
              : t("pikoMiniGame.playAgain")}
          onPrimary={startOrContinue}
          secondaryLabel={status === "lost" || status === "won" ? t("pikoMiniGame.backToWork") : undefined}
          onSecondary={status === "lost" || status === "won" ? onClose : undefined}
          accent="lime"
        />
      ) : null}
    </div>
  );
}
