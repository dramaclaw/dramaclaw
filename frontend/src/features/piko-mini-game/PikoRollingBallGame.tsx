// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePikoGameAudio } from "@/features/piko-mini-game/usePikoGameAudio";

const BOARD_WIDTH = 800;
const BOARD_HEIGHT = 520;
const BALL_RADIUS = 10;
const GRAVITY = 920;
const MOVE_ACCELERATION = 820;
const MAX_HORIZONTAL_SPEED = 310;
const PLATFORM_HEIGHT = 12;
const PLATFORM_GAP = 82;

type RollingBallStatus = "ready" | "playing" | "lost";

type Ball = {
  x: number;
  y: number;
  vx: number;
  vy: number;
};

type Platform = {
  id: number;
  x: number;
  y: number;
  width: number;
  scored: boolean;
};

function makePlatform(id: number, y: number, x?: number, width?: number): Platform {
  const platformWidth = width ?? 112 + Math.random() * 90;
  return {
    id,
    x: x ?? 28 + Math.random() * (BOARD_WIDTH - platformWidth - 56),
    y,
    width: platformWidth,
    scored: id === 0,
  };
}

function makeInitialPlatforms() {
  const platforms = [makePlatform(0, 420, BOARD_WIDTH / 2 - 82, 164)];
  for (let index = 1; index < 7; index += 1) {
    platforms.push(makePlatform(index, 420 + index * PLATFORM_GAP));
  }
  return platforms;
}

function initialBall(): Ball {
  return { x: BOARD_WIDTH / 2, y: 388, vx: 0, vy: 0 };
}

export function PikoRollingBallGame({ onClose, muted }: { onClose: () => void; muted: boolean }) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const previousTimeRef = useRef<number | null>(null);
  const statusRef = useRef<RollingBallStatus>("ready");
  const ballRef = useRef<Ball>(initialBall());
  const platformsRef = useRef<Platform[]>(makeInitialPlatforms());
  const nextPlatformIdRef = useRef(7);
  const scoreRef = useRef(0);
  const heldKeysRef = useRef({ left: false, right: false });
  const pointerTargetXRef = useRef<number | null>(null);
  const [status, setStatus] = useState<RollingBallStatus>("ready");
  const [score, setScore] = useState(0);
  const playTone = usePikoGameAudio(muted);

  const playStartSound = useCallback(() => {
    playTone(330, 0.08, 0.065, "triangle");
    playTone(440, 0.09, 0.07, "triangle", 0.08);
    playTone(659.25, 0.12, 0.075, "triangle", 0.17);
  }, [playTone]);

  const playLandingSound = useCallback(() => {
    playTone(190, 0.075, 0.065, "sine", 0, 120);
    playTone(430, 0.055, 0.035, "triangle", 0.025, 560);
  }, [playTone]);

  const playScoreSound = useCallback((nextScore: number) => {
    const lift = Math.min(nextScore, 12) * 10;
    playTone(520 + lift, 0.08, 0.075, "triangle", 0, 720 + lift);
    playTone(860 + lift, 0.1, 0.05, "sine", 0.055);
    if (nextScore % 5 === 0) {
      playTone(523.25, 0.2, 0.055, "triangle", 0.12);
      playTone(659.25, 0.2, 0.05, "triangle", 0.17);
      playTone(783.99, 0.24, 0.045, "triangle", 0.22);
    }
  }, [playTone]);

  const playFallSound = useCallback(() => {
    playTone(260, 0.34, 0.1, "sawtooth", 0, 62);
    playTone(150, 0.3, 0.06, "square", 0.06, 48);
  }, [playTone]);

  const setGameStatus = useCallback((next: RollingBallStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const resetGame = useCallback(() => {
    ballRef.current = initialBall();
    platformsRef.current = makeInitialPlatforms();
    nextPlatformIdRef.current = 7;
    scoreRef.current = 0;
    heldKeysRef.current = { left: false, right: false };
    pointerTargetXRef.current = null;
    setScore(0);
    setGameStatus("ready");
  }, [setGameStatus]);

  const startGame = useCallback(() => {
    if (statusRef.current === "lost") resetGame();
    previousTimeRef.current = null;
    ballRef.current.vy = 70;
    setGameStatus("playing");
    playStartSound();
    canvasRef.current?.focus();
  }, [playStartSound, resetGame, setGameStatus]);

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
    background.addColorStop(0, "#10151f");
    background.addColorStop(1, "#070a0f");
    context.fillStyle = background;
    context.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);

    context.strokeStyle = "rgba(165, 243, 252, 0.075)";
    context.lineWidth = 1;
    for (let y = 28; y < BOARD_HEIGHT; y += 42) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(BOARD_WIDTH, y);
      context.stroke();
    }

    for (const platform of platformsRef.current) {
      const gradient = context.createLinearGradient(platform.x, 0, platform.x + platform.width, 0);
      gradient.addColorStop(0, "rgba(103, 232, 249, 0.45)");
      gradient.addColorStop(0.5, "rgba(236, 254, 255, 0.92)");
      gradient.addColorStop(1, "rgba(190, 242, 100, 0.5)");
      context.fillStyle = gradient;
      context.shadowColor = "rgba(103, 232, 249, 0.22)";
      context.shadowBlur = 12;
      context.beginPath();
      context.roundRect(platform.x, platform.y, platform.width, PLATFORM_HEIGHT, 6);
      context.fill();
    }

    const ball = ballRef.current;
    const ballGradient = context.createRadialGradient(ball.x - 3, ball.y - 4, 1, ball.x, ball.y, BALL_RADIUS);
    ballGradient.addColorStop(0, "#ffffff");
    ballGradient.addColorStop(0.38, "#a5f3fc");
    ballGradient.addColorStop(1, "#0891b2");
    context.fillStyle = ballGradient;
    context.shadowColor = "rgba(103, 232, 249, 0.8)";
    context.shadowBlur = 18;
    context.beginPath();
    context.arc(ball.x, ball.y, BALL_RADIUS, 0, Math.PI * 2);
    context.fill();
    context.shadowBlur = 0;
  }, []);

  useEffect(() => {
    const tick = (time: number) => {
      const previousTime = previousTimeRef.current ?? time;
      previousTimeRef.current = time;
      const delta = Math.min((time - previousTime) / 1000, 0.025);

      if (statusRef.current === "playing") {
        const ball = ballRef.current;
        const previousBottom = ball.y + BALL_RADIUS;
        const scrollSpeed = Math.min(62 + scoreRef.current * 1.5, 145);
        const pointerTarget = pointerTargetXRef.current;
        let direction = Number(heldKeysRef.current.right) - Number(heldKeysRef.current.left);
        if (direction === 0 && pointerTarget !== null) {
          const distance = pointerTarget - ball.x;
          direction = Math.abs(distance) < 8 ? 0 : Math.sign(distance);
        }

        if (direction !== 0) ball.vx += direction * MOVE_ACCELERATION * delta;
        else ball.vx *= Math.pow(0.12, delta);
        ball.vx = Math.max(-MAX_HORIZONTAL_SPEED, Math.min(MAX_HORIZONTAL_SPEED, ball.vx));
        ball.vy += GRAVITY * delta;
        ball.x += ball.vx * delta;
        ball.y += ball.vy * delta;

        if (ball.x - BALL_RADIUS < 0) {
          ball.x = BALL_RADIUS;
          ball.vx = Math.abs(ball.vx) * 0.65;
        } else if (ball.x + BALL_RADIUS > BOARD_WIDTH) {
          ball.x = BOARD_WIDTH - BALL_RADIUS;
          ball.vx = -Math.abs(ball.vx) * 0.65;
        }

        for (const platform of platformsRef.current) platform.y -= scrollSpeed * delta;

        if (ball.vy >= 0) {
          for (const platform of platformsRef.current) {
            const platformTopBeforeScroll = platform.y + scrollSpeed * delta;
            if (
              previousBottom <= platformTopBeforeScroll + 3 &&
              ball.y + BALL_RADIUS >= platform.y &&
              ball.y - BALL_RADIUS <= platform.y + PLATFORM_HEIGHT &&
              ball.x + BALL_RADIUS >= platform.x &&
              ball.x - BALL_RADIUS <= platform.x + platform.width
            ) {
              ball.y = platform.y - BALL_RADIUS;
              ball.vy = -410;
              if (!platform.scored) {
                platform.scored = true;
                scoreRef.current += 1;
                setScore(scoreRef.current);
                playScoreSound(scoreRef.current);
              } else {
                playLandingSound();
              }
              break;
            }
          }
        }

        platformsRef.current = platformsRef.current.filter((platform) => platform.y + PLATFORM_HEIGHT > -8);
        let lowestY = Math.max(...platformsRef.current.map((platform) => platform.y), 0);
        while (lowestY < BOARD_HEIGHT + PLATFORM_GAP) {
          lowestY += PLATFORM_GAP;
          platformsRef.current.push(makePlatform(nextPlatformIdRef.current++, lowestY));
        }

        if (ball.y - BALL_RADIUS > BOARD_HEIGHT) {
          setGameStatus("lost");
          playFallSound();
        }
      }

      draw();
      frameRef.current = window.requestAnimationFrame(tick);
    };
    frameRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    };
  }, [draw, playFallSound, playLandingSound, playScoreSound, setGameStatus]);

  useEffect(() => {
    const setKeyState = (event: KeyboardEvent, pressed: boolean) => {
      const key = event.key.toLowerCase();
      if (key === "arrowleft" || key === "a") {
        event.preventDefault();
        heldKeysRef.current.left = pressed;
        pointerTargetXRef.current = null;
      } else if (key === "arrowright" || key === "d") {
        event.preventDefault();
        heldKeysRef.current.right = pressed;
        pointerTargetXRef.current = null;
      } else if (pressed && (key === " " || key === "enter") && statusRef.current !== "playing") {
        event.preventDefault();
        startGame();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => setKeyState(event, true);
    const handleKeyUp = (event: KeyboardEvent) => setKeyState(event, false);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [startGame]);

  const setPointerTarget = (clientX: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    pointerTargetXRef.current = ((clientX - rect.left) / rect.width) * BOARD_WIDTH;
  };

  return (
    <div className="relative h-[520px] overflow-hidden border border-white/[0.08] bg-[#070a0f]">
      <canvas
        ref={canvasRef}
        className="h-full w-full touch-none outline-none"
        tabIndex={0}
        aria-label={t("pikoMiniGame.rollingBall.canvasLabel")}
        onPointerMove={(event) => setPointerTarget(event.clientX)}
        onPointerDown={(event) => {
          setPointerTarget(event.clientX);
          if (statusRef.current !== "playing") startGame();
        }}
        onPointerLeave={() => {
          pointerTargetXRef.current = null;
        }}
      />

      <div className="pointer-events-none absolute left-4 top-4 text-sm font-medium text-white/78">
        {t("pikoMiniGame.rollingBall.score", { score })}
      </div>

      {status !== "playing" ? (
        <div className="absolute inset-0 grid place-items-center bg-black/52 px-5 backdrop-blur-[2px]">
          <div className="max-w-sm rounded-2xl border border-white/[0.14] bg-black/68 px-7 py-6 text-center shadow-[0_24px_72px_rgba(0,0,0,0.48)]">
            <h3 className="text-2xl font-semibold text-white">
              {t(status === "lost" ? "pikoMiniGame.rollingBall.lost" : "pikoMiniGame.rollingBall.ready")}
            </h3>
            <p className="mt-2 text-sm leading-6 text-white/58">{t("pikoMiniGame.rollingBall.hint")}</p>
            <div className="mt-6 flex justify-center gap-3">
              {status === "lost" ? (
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
                className="h-10 rounded-full bg-cyan-300 px-5 text-sm font-medium text-slate-950 transition-colors hover:bg-cyan-200"
                onClick={startGame}
              >
                {status === "lost" ? t("pikoMiniGame.playAgain") : t("pikoMiniGame.rollingBall.start")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
