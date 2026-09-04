// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PikoActionFigure } from "@/features/companion/PikoActionFigure";
import { PikoGameHud, PikoGameOverlay } from "@/features/piko-mini-game/PikoGameChrome";
import { usePikoGameAudio } from "@/features/piko-mini-game/usePikoGameAudio";

const BOARD_WIDTH = 800;
const BOARD_HEIGHT = 520;
const ANCHOR_X = 170;
const ANCHOR_Y = 365;
const MAX_CHARGE_MS = 1_250;
const MIN_JUMP_DISTANCE = 72;
const MAX_JUMP_DISTANCE = 335;
const CAMERA_MOVE_MS = 560;

type LeapStatus = "ready" | "playing" | "charging" | "jumping" | "landed" | "lost";
type PlatformKind = "normal" | "bonus" | "spring" | "fragile";
type LandingFeedback = "perfect" | "spring" | "rescue";

type Point = {
  x: number;
  y: number;
};

type Platform = Point & {
  id: number;
  width: number;
  depth: number;
  height: number;
  bonus: boolean;
  kind: PlatformKind;
};

type JumpState = {
  startedAt: number;
  duration: number;
  start: Point;
  end: Point;
  targetId: number;
};

type CameraMove = {
  startedAt: number;
  targetId: number;
  landingPoint: Point;
  offset: Point;
};

function initialPlatforms(): Platform[] {
  const first: Platform = {
    id: 0,
    x: ANCHOR_X,
    y: ANCHOR_Y,
    width: 132,
    depth: 74,
    height: 24,
    bonus: false,
    kind: "normal",
  };
  const second = makeNextPlatform(1, first, 0);
  const third = makeNextPlatform(2, second, 1);
  return [first, second, { ...third, bonus: true, kind: "bonus" }];
}

function distanceBetween(first: Point, second: Point) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function makeNextPlatform(id: number, previous: Platform, score: number): Platform {
  const distanceRoll = Math.random();
  const longJumpChance = Math.min(0.2 + score * 0.018, 0.48);
  const distance = distanceRoll < longJumpChance
    ? 250 + Math.random() * 48
    : distanceRoll < 0.68
      ? 190 + Math.random() * 48
      : 142 + Math.random() * 38;
  let verticalDirection = Math.random() < 0.5 ? -1 : 1;
  if (previous.y < 225) verticalDirection = 1;
  if (previous.y > 405) verticalDirection = -1;
  const desiredVerticalShift = verticalDirection * (38 + Math.random() * 88);
  const nextY = Math.max(165, Math.min(425, previous.y + desiredVerticalShift));
  const verticalShift = nextY - previous.y;
  const horizontalShift = Math.sqrt(Math.max(0, distance ** 2 - verticalShift ** 2));
  const sizeVariance = Math.random() * 34;
  const kind: PlatformKind = id % 7 === 0 ? "spring" : id % 6 === 0 ? "fragile" : id % 5 === 0 ? "bonus" : "normal";
  const kindWidthPenalty = kind === "fragile" ? 18 : 0;
  return {
    id,
    x: previous.x + horizontalShift,
    y: nextY,
    width: Math.max(70, 138 - score * 1.25 - sizeVariance - kindWidthPenalty),
    depth: Math.max(46, 78 - score * 0.6 - sizeVariance * 0.45 - kindWidthPenalty * 0.4),
    height: 12 + Math.random() * 36,
    bonus: kind === "bonus",
    kind,
  };
}

function isPointOnPlatform(point: Point, platform: Platform) {
  const normalized =
    Math.abs(point.x - platform.x) / (platform.width / 2) +
    Math.abs(point.y - platform.y) / (platform.depth / 2);
  return normalized <= 1;
}

export function PikoLeapGame({ onClose, muted }: { onClose: () => void; muted: boolean }) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const statusRef = useRef<LeapStatus>("ready");
  const platformsRef = useRef<Platform[]>(initialPlatforms());
  const currentPlatformIdRef = useRef(0);
  const nextPlatformIdRef = useRef(3);
  const pikoPositionRef = useRef<Point>({ x: ANCHOR_X, y: ANCHOR_Y });
  const chargeStartedAtRef = useRef(0);
  const jumpRef = useRef<JumpState | null>(null);
  const scoreRef = useRef(0);
  const comboRef = useRef(0);
  const cameraOffsetRef = useRef<Point>({ x: 0, y: 0 });
  const cameraMoveRef = useRef<CameraMove | null>(null);
  const jumpBoostRef = useRef(1);
  const rescueAvailableRef = useRef(true);
  const feedbackTimerRef = useRef<number | null>(null);
  const [status, setStatus] = useState<LeapStatus>("ready");
  const [pikoPosition, setPikoPosition] = useState<Point>({ x: ANCHOR_X, y: ANCHOR_Y });
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [rescueAvailable, setRescueAvailable] = useState(true);
  const [landingFeedback, setLandingFeedback] = useState<LandingFeedback | null>(null);
  const playTone = usePikoGameAudio(muted);

  const setGameStatus = useCallback((next: LeapStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const playChargeSound = useCallback(() => {
    playTone(190, 0.16, 0.045, "triangle", 0, 390);
  }, [playTone]);

  const playJumpSound = useCallback((power: number) => {
    playTone(330 + power * 120, 0.11, 0.075, "triangle", 0, 760 + power * 180);
    playTone(920, 0.07, 0.035, "sine", 0.055, 1_260);
  }, [playTone]);

  const playLandSound = useCallback((centered: boolean, bonus: boolean) => {
    playTone(230, 0.075, 0.065, "sine", 0, 145);
    playTone(centered ? 880 : 620, 0.11, 0.065, "triangle", 0.04);
    if (centered || bonus) {
      playTone(1_176, 0.14, 0.05, "sine", 0.1);
      playTone(1_568, 0.16, 0.04, "sine", 0.16);
    }
  }, [playTone]);

  const playFallSound = useCallback(() => {
    playTone(260, 0.36, 0.1, "sawtooth", 0, 58);
    playTone(130, 0.3, 0.055, "square", 0.07, 44);
  }, [playTone]);

  const showLandingFeedback = useCallback((feedback: LandingFeedback) => {
    setLandingFeedback(feedback);
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = window.setTimeout(() => {
      setLandingFeedback(null);
      feedbackTimerRef.current = null;
    }, 900);
  }, []);

  useEffect(() => () => {
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
  }, []);

  const resetGame = useCallback(() => {
    const nextPlatforms = initialPlatforms();
    platformsRef.current = nextPlatforms;
    currentPlatformIdRef.current = 0;
    nextPlatformIdRef.current = 3;
    pikoPositionRef.current = { x: ANCHOR_X, y: ANCHOR_Y };
    jumpRef.current = null;
    cameraOffsetRef.current = { x: 0, y: 0 };
    cameraMoveRef.current = null;
    scoreRef.current = 0;
    comboRef.current = 0;
    jumpBoostRef.current = 1;
    rescueAvailableRef.current = true;
    setPikoPosition({ x: ANCHOR_X, y: ANCHOR_Y });
    setScore(0);
    setCombo(0);
    setRescueAvailable(true);
    setLandingFeedback(null);
    setGameStatus("ready");
  }, [setGameStatus]);

  const startGame = useCallback(() => {
    if (statusRef.current === "lost") resetGame();
    setGameStatus("playing");
    window.requestAnimationFrame(() => canvasRef.current?.focus());
  }, [resetGame, setGameStatus]);

  const beginCharge = useCallback(() => {
    if (statusRef.current === "ready") {
      startGame();
    }
    if (statusRef.current !== "playing") return;
    chargeStartedAtRef.current = performance.now();
    setGameStatus("charging");
    playChargeSound();
  }, [playChargeSound, setGameStatus, startGame]);

  const cancelCharge = useCallback(() => {
    if (statusRef.current !== "charging") return;
    setGameStatus("playing");
  }, [setGameStatus]);

  const releaseJump = useCallback(() => {
    if (statusRef.current !== "charging") return;
    const power = Math.max(0.08, Math.min(1, (performance.now() - chargeStartedAtRef.current) / MAX_CHARGE_MS));
    const currentPlatform = platformsRef.current.find(
      (platform) => platform.id === currentPlatformIdRef.current,
    );
    const targetPlatform = platformsRef.current.find(
      (platform) => platform.id === currentPlatformIdRef.current + 1,
    );
    if (!currentPlatform || !targetPlatform) return;
    const targetDistance = distanceBetween(currentPlatform, targetPlatform);
    const direction = {
      x: (targetPlatform.x - currentPlatform.x) / targetDistance,
      y: (targetPlatform.y - currentPlatform.y) / targetDistance,
    };
    const jumpDistance = (MIN_JUMP_DISTANCE + power * (MAX_JUMP_DISTANCE - MIN_JUMP_DISTANCE)) * jumpBoostRef.current;
    jumpBoostRef.current = 1;
    const end = {
      x: currentPlatform.x + direction.x * jumpDistance,
      y: currentPlatform.y + direction.y * jumpDistance,
    };
    jumpRef.current = {
      startedAt: performance.now(),
      duration: 470 + power * 210,
      start: { ...pikoPositionRef.current },
      end,
      targetId: targetPlatform.id,
    };
    setGameStatus("jumping");
    playJumpSound(power);
  }, [playJumpSound, setGameStatus]);

  const settleOnPlatform = useCallback((target: Platform, landingPoint: Point, rescued = false) => {
    const centerDistance = distanceBetween(landingPoint, target);
    const centered = !rescued && centerDistance <= Math.min(target.width, target.depth) * 0.18;
    const spring = !rescued && target.kind === "spring";
    const gained = 1 + (centered ? 2 : 0) + (target.bonus ? 2 : 0) + (spring ? 1 : 0);
    comboRef.current = centered ? comboRef.current + 1 : 0;
    if (spring) jumpBoostRef.current = 1.12;
    scoreRef.current += gained;
    setScore(scoreRef.current);
    setCombo(comboRef.current);
    setGameStatus("landed");
    playLandSound(centered, target.bonus);
    if (rescued) showLandingFeedback("rescue");
    else if (centered) showLandingFeedback("perfect");
    else if (spring) showLandingFeedback("spring");

    cameraMoveRef.current = {
      startedAt: performance.now(),
      targetId: target.id,
      landingPoint,
      offset: { x: ANCHOR_X - target.x, y: ANCHOR_Y - target.y },
    };
  }, [playLandSound, setGameStatus, showLandingFeedback]);

  const draw = useCallback(() => {
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

    const background = context.createLinearGradient(0, 0, 0, BOARD_HEIGHT);
    background.addColorStop(0, "#111827");
    background.addColorStop(1, "#070a0f");
    context.fillStyle = background;
    context.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);

    context.strokeStyle = "rgba(165,243,252,0.065)";
    context.lineWidth = 1;
    for (let x = -BOARD_HEIGHT; x < BOARD_WIDTH + BOARD_HEIGHT; x += 46) {
      context.beginPath();
      context.moveTo(x, BOARD_HEIGHT);
      context.lineTo(x + BOARD_HEIGHT, 0);
      context.stroke();
    }

    context.save();
    context.translate(cameraOffsetRef.current.x, cameraOffsetRef.current.y);
    const orderedPlatforms = [...platformsRef.current].sort((a, b) => a.y - b.y);
    for (const platform of orderedPlatforms) {
      const halfWidth = platform.width / 2;
      const halfDepth = platform.depth / 2;
      const height = platform.height;
      const spring = platform.kind === "spring";
      const fragile = platform.kind === "fragile";
      context.fillStyle = platform.bonus
        ? "rgba(101,163,13,0.52)"
        : spring
          ? "rgba(124,58,237,0.5)"
          : fragile
            ? "rgba(217,119,6,0.48)"
            : "rgba(8,145,178,0.45)";
      context.beginPath();
      context.moveTo(platform.x - halfWidth, platform.y);
      context.lineTo(platform.x, platform.y + halfDepth);
      context.lineTo(platform.x, platform.y + halfDepth + height);
      context.lineTo(platform.x - halfWidth, platform.y + height);
      context.closePath();
      context.fill();
      context.fillStyle = platform.bonus
        ? "rgba(77,124,15,0.58)"
        : spring
          ? "rgba(76,29,149,0.52)"
          : fragile
            ? "rgba(146,64,14,0.5)"
            : "rgba(30,64,175,0.42)";
      context.beginPath();
      context.moveTo(platform.x + halfWidth, platform.y);
      context.lineTo(platform.x, platform.y + halfDepth);
      context.lineTo(platform.x, platform.y + halfDepth + height);
      context.lineTo(platform.x + halfWidth, platform.y + height);
      context.closePath();
      context.fill();

      const gradient = context.createLinearGradient(
        platform.x - halfWidth,
        platform.y - halfDepth,
        platform.x + halfWidth,
        platform.y + halfDepth,
      );
      gradient.addColorStop(0, platform.bonus ? "#d9f99d" : spring ? "#ddd6fe" : fragile ? "#fde68a" : "#cffafe");
      gradient.addColorStop(1, platform.bonus ? "#84cc16" : spring ? "#8b5cf6" : fragile ? "#f59e0b" : "#22d3ee");
      context.fillStyle = gradient;
      context.shadowColor = platform.bonus ? "rgba(190,242,100,0.4)" : "rgba(103,232,249,0.34)";
      context.shadowBlur = 16;
      context.beginPath();
      context.moveTo(platform.x, platform.y - halfDepth);
      context.lineTo(platform.x + halfWidth, platform.y);
      context.lineTo(platform.x, platform.y + halfDepth);
      context.lineTo(platform.x - halfWidth, platform.y);
      context.closePath();
      context.fill();
      context.shadowBlur = 0;

      context.strokeStyle = "rgba(255,255,255,0.62)";
      context.lineWidth = 2;
      context.beginPath();
      context.ellipse(platform.x, platform.y, 7, 4, 0, 0, Math.PI * 2);
      context.stroke();
      if (spring) {
        context.strokeStyle = "rgba(255,255,255,0.76)";
        context.lineWidth = 3;
        context.beginPath();
        context.moveTo(platform.x - 12, platform.y - 3);
        context.lineTo(platform.x - 5, platform.y + 4);
        context.lineTo(platform.x + 2, platform.y - 3);
        context.lineTo(platform.x + 9, platform.y + 4);
        context.stroke();
      } else if (fragile) {
        context.strokeStyle = "rgba(120,53,15,0.7)";
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(platform.x - 10, platform.y - 5);
        context.lineTo(platform.x, platform.y + 2);
        context.lineTo(platform.x + 8, platform.y - 4);
        context.stroke();
      }
    }
    context.restore();
  }, []);

  useEffect(() => {
    const tick = (now: number) => {
      if (statusRef.current === "charging") {
        // The charge bar runs on the browser compositor; jump power is calculated on release.
      } else if (statusRef.current === "jumping" && jumpRef.current) {
        const jump = jumpRef.current;
        const progress = Math.min(1, (now - jump.startedAt) / jump.duration);
        const arc = Math.sin(progress * Math.PI) * (75 + distanceBetween(jump.start, jump.end) * 0.14);
        const position = {
          x: jump.start.x + (jump.end.x - jump.start.x) * progress,
          y: jump.start.y + (jump.end.y - jump.start.y) * progress - arc,
        };
        pikoPositionRef.current = position;
        setPikoPosition(position);
        if (progress >= 1) {
          const target = platformsRef.current.find((platform) => platform.id === jump.targetId);
          jumpRef.current = null;
          if (target && isPointOnPlatform(jump.end, target)) {
            pikoPositionRef.current = jump.end;
            setPikoPosition(jump.end);
            settleOnPlatform(target, jump.end);
          } else if (target && rescueAvailableRef.current) {
            rescueAvailableRef.current = false;
            setRescueAvailable(false);
            comboRef.current = 0;
            setCombo(0);
            const rescuePoint = { x: target.x + target.width * 0.26, y: target.y };
            pikoPositionRef.current = rescuePoint;
            setPikoPosition(rescuePoint);
            settleOnPlatform(target, rescuePoint, true);
          } else {
            setGameStatus("lost");
            comboRef.current = 0;
            setCombo(0);
            playFallSound();
          }
        }
      } else if (statusRef.current === "landed" && cameraMoveRef.current) {
        const cameraMove = cameraMoveRef.current;
        const progress = Math.min(1, (now - cameraMove.startedAt) / CAMERA_MOVE_MS);
        const eased = 1 - Math.pow(1 - progress, 3);
        const offset = {
          x: cameraMove.offset.x * eased,
          y: cameraMove.offset.y * eased,
        };
        cameraOffsetRef.current = offset;
        const position = {
          x: cameraMove.landingPoint.x + offset.x +
            (ANCHOR_X - cameraMove.landingPoint.x - cameraMove.offset.x) * eased,
          y: cameraMove.landingPoint.y + offset.y +
            (ANCHOR_Y - cameraMove.landingPoint.y - cameraMove.offset.y) * eased,
        };
        pikoPositionRef.current = position;
        setPikoPosition(position);

        if (progress >= 1) {
          let nextPlatforms = platformsRef.current
            .filter((platform) => platform.id >= cameraMove.targetId)
            .map((platform) => ({
              ...platform,
              x: platform.x + cameraMove.offset.x,
              y: platform.y + cameraMove.offset.y,
            }));
          while (nextPlatforms.length < 3) {
            const previous = nextPlatforms[nextPlatforms.length - 1];
            nextPlatforms.push(
              makeNextPlatform(nextPlatformIdRef.current++, previous, scoreRef.current),
            );
          }
          platformsRef.current = nextPlatforms;
          currentPlatformIdRef.current = cameraMove.targetId;
          cameraOffsetRef.current = { x: 0, y: 0 };
          cameraMoveRef.current = null;
          pikoPositionRef.current = { x: ANCHOR_X, y: ANCHOR_Y };
          setPikoPosition({ x: ANCHOR_X, y: ANCHOR_Y });
          setGameStatus("playing");
        }
      }
      draw();
      frameRef.current = window.requestAnimationFrame(tick);
    };
    frameRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    };
  }, [draw, playFallSound, setGameStatus, settleOnPlatform]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== " " || event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      beginCharge();
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      releaseJump();
    };
    const handleVisibilityChange = () => {
      if (document.hidden) cancelCharge();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", cancelCharge);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", cancelCharge);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [beginCharge, cancelCharge, releaseJump]);

  const pikoAction =
    status === "charging" ? "stretch" : status === "jumping" ? "watch-meteor" : status === "landed" ? "flag" : "idle";

  return (
    <div
      className="relative h-[520px] select-none overflow-hidden border border-white/[0.08] bg-[#070a0f]"
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        beginCharge();
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        releaseJump();
      }}
      onPointerCancel={cancelCharge}
    >
      <canvas
        ref={canvasRef}
        className="h-full w-full touch-none outline-none"
        tabIndex={0}
        aria-label={t("pikoMiniGame.leap.canvasLabel")}
      />

      <style>{`
        @keyframes piko-leap-energy-ring {
          0% { opacity: 0.2; transform: scale(0.68); }
          100% { opacity: 0.9; transform: scale(1.14); }
        }
        @keyframes piko-leap-energy-tick {
          0%, 99% { background: rgba(255,255,255,0.16); box-shadow: none; transform: scale(0.72); }
          100% { background: #67e8f9; box-shadow: 0 0 12px rgba(103,232,249,0.95); transform: scale(1); }
        }
        @keyframes piko-leap-compress {
          0% { transform: scaleX(1) scaleY(1); }
          100% { transform: scaleX(1.18) scaleY(0.72); }
        }
      `}</style>

      <div
        className="pointer-events-none absolute size-[62px]"
        style={{
          left: `${(pikoPosition.x / BOARD_WIDTH) * 100}%`,
          top: `${(pikoPosition.y / BOARD_HEIGHT) * 100}%`,
          transform: "translate(-50%, -78%)",
        }}
      >
        {status === "charging" ? (
          <div
            className="absolute -inset-7 rounded-full border-2 border-cyan-300/55"
            style={{ animation: `piko-leap-energy-ring ${MAX_CHARGE_MS}ms linear forwards` }}
          >
            {Array.from({ length: 10 }, (_, index) => (
              <span
                key={index}
                className="absolute left-1/2 top-1/2 size-2"
                style={{ transform: `translate(-50%, -50%) rotate(${index * 36}deg) translateY(-47px)` }}
              >
                <span
                  className="block size-2 rounded-full bg-white/15"
                  style={{
                    animation: "piko-leap-energy-tick 1ms linear forwards",
                    animationDelay: `${index * (MAX_CHARGE_MS / 10)}ms`,
                  }}
                />
              </span>
            ))}
          </div>
        ) : null}
        <div
          className="relative size-full"
          style={status === "charging" ? {
            animation: `piko-leap-compress ${MAX_CHARGE_MS}ms linear forwards`,
            transformOrigin: "center bottom",
          } : undefined}
        >
          <PikoActionFigure
            action={pikoAction}
            className="mybuddy-companion-anchor--preview !h-[62px]"
            style={{ transform: "scale(0.82)", transformOrigin: "center" }}
          />
        </div>
      </div>

      <PikoGameHud
        left={t("pikoMiniGame.leap.score", { score })}
        center={landingFeedback ? t(`pikoMiniGame.leap.feedback.${landingFeedback}`) : undefined}
        right={combo > 0
          ? t("pikoMiniGame.leap.combo", { combo })
          : rescueAvailable
            ? t("pikoMiniGame.leap.rescueReady")
            : t("pikoMiniGame.leap.centerHint")}
      />

      {status === "playing" ? (
        <div className="pointer-events-none absolute bottom-5 left-1/2 -translate-x-1/2 text-center text-xs text-white/48">
          {t("pikoMiniGame.leap.chargeHint")}
        </div>
      ) : null}

      {status === "ready" || status === "lost" ? (
        <PikoGameOverlay
          title={t(status === "lost" ? "pikoMiniGame.leap.lost" : "pikoMiniGame.leap.ready")}
          description={status === "lost" ? t("pikoMiniGame.leap.result", { score }) : t("pikoMiniGame.leap.hint")}
          primaryLabel={status === "lost" ? t("pikoMiniGame.playAgain") : t("pikoMiniGame.leap.start")}
          onPrimary={startGame}
          secondaryLabel={status === "lost" ? t("pikoMiniGame.backToWork") : undefined}
          onSecondary={status === "lost" ? onClose : undefined}
          accent="lime"
        />
      ) : null}
    </div>
  );
}
