// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePikoGameAudio } from "@/features/piko-mini-game/usePikoGameAudio";

const BOARD_WIDTH = 800;
const BOARD_HEIGHT = 520;
const PADDLE_WIDTH = 112;
const PADDLE_HEIGHT = 14;
const PADDLE_Y = 476;
const BALL_RADIUS = 7;
const BRICK_ROWS = 6;
const BRICK_COLUMNS = 10;
const BRICK_GAP = 6;
const BRICK_HEIGHT = 22;
const BRICK_TOP = 62;
const BRICK_SIDE = 32;
const STARTING_LIVES = 3;

type BreakoutStatus = "ready" | "playing" | "paused" | "won" | "lost";

type Ball = {
  x: number;
  y: number;
  vx: number;
  vy: number;
};

type Brick = {
  id: number;
  row: number;
  column: number;
  alive: boolean;
};

function makeBricks(): Brick[] {
  return Array.from({ length: BRICK_ROWS * BRICK_COLUMNS }, (_, id) => ({
    id,
    row: Math.floor(id / BRICK_COLUMNS),
    column: id % BRICK_COLUMNS,
    alive: true,
  }));
}

function initialBall(): Ball {
  return { x: BOARD_WIDTH / 2, y: PADDLE_Y - 18, vx: 250, vy: -310 };
}

export function PikoBreakoutGame({ onClose, muted }: { onClose: () => void; muted: boolean }) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const previousTimeRef = useRef<number | null>(null);
  const statusRef = useRef<BreakoutStatus>("ready");
  const ballRef = useRef<Ball>(initialBall());
  const paddleXRef = useRef((BOARD_WIDTH - PADDLE_WIDTH) / 2);
  const bricksRef = useRef<Brick[]>(makeBricks());
  const scoreRef = useRef(0);
  const livesRef = useRef(STARTING_LIVES);
  const [status, setStatus] = useState<BreakoutStatus>("ready");
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(STARTING_LIVES);
  const playTone = usePikoGameAudio(muted);

  const playStartSound = useCallback(() => {
    playTone(392, 0.07, 0.06, "triangle");
    playTone(523.25, 0.08, 0.065, "triangle", 0.075);
    playTone(783.99, 0.11, 0.07, "triangle", 0.155);
  }, [playTone]);

  const playWallSound = useCallback(() => {
    playTone(310, 0.035, 0.025, "square", 0, 360);
  }, [playTone]);

  const playPaddleSound = useCallback(() => {
    playTone(250, 0.065, 0.06, "triangle", 0, 520);
    playTone(720, 0.05, 0.035, "sine", 0.035);
  }, [playTone]);

  const playBrickSound = useCallback((row: number) => {
    const frequency = 540 + (BRICK_ROWS - row) * 74;
    playTone(frequency, 0.055, 0.07, "square");
    playTone(frequency * 1.5, 0.075, 0.038, "triangle", 0.028);
  }, [playTone]);

  const playLifeLostSound = useCallback(() => {
    playTone(240, 0.24, 0.085, "sawtooth", 0, 85);
  }, [playTone]);

  const playWinSound = useCallback(() => {
    playTone(523.25, 0.18, 0.07, "triangle");
    playTone(659.25, 0.2, 0.065, "triangle", 0.1);
    playTone(783.99, 0.22, 0.06, "triangle", 0.2);
    playTone(1_046.5, 0.3, 0.055, "sine", 0.3);
  }, [playTone]);

  const playGameOverSound = useCallback(() => {
    playTone(220, 0.3, 0.1, "sawtooth", 0, 62);
    playTone(110, 0.34, 0.06, "square", 0.08, 44);
  }, [playTone]);

  const setGameStatus = useCallback((next: BreakoutStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const resetBall = useCallback(() => {
    ballRef.current = initialBall();
    paddleXRef.current = (BOARD_WIDTH - PADDLE_WIDTH) / 2;
  }, []);

  const resetGame = useCallback(() => {
    bricksRef.current = makeBricks();
    scoreRef.current = 0;
    livesRef.current = STARTING_LIVES;
    setScore(0);
    setLives(STARTING_LIVES);
    resetBall();
    setGameStatus("ready");
  }, [resetBall, setGameStatus]);

  const startGame = useCallback(() => {
    if (statusRef.current === "won" || statusRef.current === "lost") {
      resetGame();
    }
    previousTimeRef.current = null;
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
    background.addColorStop(0, "#121823");
    background.addColorStop(1, "#080b10");
    context.fillStyle = background;
    context.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);

    context.strokeStyle = "rgba(165, 243, 252, 0.07)";
    context.lineWidth = 1;
    for (let x = 0; x <= BOARD_WIDTH; x += 40) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, BOARD_HEIGHT);
      context.stroke();
    }
    for (let y = 0; y <= BOARD_HEIGHT; y += 40) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(BOARD_WIDTH, y);
      context.stroke();
    }

    const brickWidth = (BOARD_WIDTH - BRICK_SIDE * 2 - BRICK_GAP * (BRICK_COLUMNS - 1)) / BRICK_COLUMNS;
    const rowColors = ["#67e8f9", "#a5f3fc", "#bef264", "#fde047", "#f9a8d4", "#c4b5fd"];
    for (const brick of bricksRef.current) {
      if (!brick.alive) continue;
      const x = BRICK_SIDE + brick.column * (brickWidth + BRICK_GAP);
      const y = BRICK_TOP + brick.row * (BRICK_HEIGHT + BRICK_GAP);
      context.fillStyle = rowColors[brick.row];
      context.globalAlpha = 0.82;
      context.beginPath();
      context.roundRect(x, y, brickWidth, BRICK_HEIGHT, 4);
      context.fill();
      context.globalAlpha = 1;
    }

    const paddleGradient = context.createLinearGradient(paddleXRef.current, 0, paddleXRef.current + PADDLE_WIDTH, 0);
    paddleGradient.addColorStop(0, "#67e8f9");
    paddleGradient.addColorStop(0.5, "#ecfeff");
    paddleGradient.addColorStop(1, "#67e8f9");
    context.fillStyle = paddleGradient;
    context.shadowColor = "rgba(103, 232, 249, 0.45)";
    context.shadowBlur = 16;
    context.beginPath();
    context.roundRect(paddleXRef.current, PADDLE_Y, PADDLE_WIDTH, PADDLE_HEIGHT, 7);
    context.fill();

    const ball = ballRef.current;
    context.fillStyle = "#ffffff";
    context.shadowColor = "rgba(165, 243, 252, 0.85)";
    context.shadowBlur = 14;
    context.beginPath();
    context.arc(ball.x, ball.y, BALL_RADIUS, 0, Math.PI * 2);
    context.fill();
    context.shadowBlur = 0;
  }, []);

  useEffect(() => {
    const tick = (time: number) => {
      const previous = previousTimeRef.current ?? time;
      previousTimeRef.current = time;
      const delta = Math.min((time - previous) / 1000, 0.025);

      if (statusRef.current === "playing") {
        const ball = ballRef.current;
        ball.x += ball.vx * delta;
        ball.y += ball.vy * delta;

        if (ball.x - BALL_RADIUS <= 0 && ball.vx < 0) {
          ball.vx *= -1;
          playWallSound();
        }
        if (ball.x + BALL_RADIUS >= BOARD_WIDTH && ball.vx > 0) {
          ball.vx *= -1;
          playWallSound();
        }
        if (ball.y - BALL_RADIUS <= 0 && ball.vy < 0) {
          ball.vy *= -1;
          playWallSound();
        }

        const paddleX = paddleXRef.current;
        if (
          ball.vy > 0 &&
          ball.y + BALL_RADIUS >= PADDLE_Y &&
          ball.y - BALL_RADIUS <= PADDLE_Y + PADDLE_HEIGHT &&
          ball.x >= paddleX - BALL_RADIUS &&
          ball.x <= paddleX + PADDLE_WIDTH + BALL_RADIUS
        ) {
          const hitOffset = (ball.x - (paddleX + PADDLE_WIDTH / 2)) / (PADDLE_WIDTH / 2);
          const speed = Math.min(Math.hypot(ball.vx, ball.vy) * 1.025, 540);
          ball.vx = speed * Math.sin(hitOffset * 1.05);
          ball.vy = -Math.max(220, speed * Math.cos(hitOffset * 1.05));
          ball.y = PADDLE_Y - BALL_RADIUS - 1;
          playPaddleSound();
        }

        const brickWidth = (BOARD_WIDTH - BRICK_SIDE * 2 - BRICK_GAP * (BRICK_COLUMNS - 1)) / BRICK_COLUMNS;
        for (const brick of bricksRef.current) {
          if (!brick.alive) continue;
          const x = BRICK_SIDE + brick.column * (brickWidth + BRICK_GAP);
          const y = BRICK_TOP + brick.row * (BRICK_HEIGHT + BRICK_GAP);
          if (
            ball.x + BALL_RADIUS < x ||
            ball.x - BALL_RADIUS > x + brickWidth ||
            ball.y + BALL_RADIUS < y ||
            ball.y - BALL_RADIUS > y + BRICK_HEIGHT
          ) continue;

          brick.alive = false;
          scoreRef.current += (BRICK_ROWS - brick.row) * 10;
          setScore(scoreRef.current);
          playBrickSound(brick.row);
          const overlapLeft = ball.x + BALL_RADIUS - x;
          const overlapRight = x + brickWidth - (ball.x - BALL_RADIUS);
          const overlapTop = ball.y + BALL_RADIUS - y;
          const overlapBottom = y + BRICK_HEIGHT - (ball.y - BALL_RADIUS);
          if (Math.min(overlapLeft, overlapRight) < Math.min(overlapTop, overlapBottom)) ball.vx *= -1;
          else ball.vy *= -1;
          break;
        }

        if (bricksRef.current.every((brick) => !brick.alive)) {
          setGameStatus("won");
          playWinSound();
        } else if (ball.y - BALL_RADIUS > BOARD_HEIGHT) {
          livesRef.current -= 1;
          setLives(livesRef.current);
          if (livesRef.current <= 0) {
            setGameStatus("lost");
            playGameOverSound();
          } else {
            resetBall();
            setGameStatus("paused");
            playLifeLostSound();
          }
        }
      }

      draw();
      frameRef.current = window.requestAnimationFrame(tick);
    };
    frameRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    };
  }, [
    draw,
    playBrickSound,
    playGameOverSound,
    playLifeLostSound,
    playPaddleSound,
    playWallSound,
    playWinSound,
    resetBall,
    setGameStatus,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft" || event.key.toLowerCase() === "a") {
        event.preventDefault();
        paddleXRef.current = Math.max(0, paddleXRef.current - 42);
      } else if (event.key === "ArrowRight" || event.key.toLowerCase() === "d") {
        event.preventDefault();
        paddleXRef.current = Math.min(BOARD_WIDTH - PADDLE_WIDTH, paddleXRef.current + 42);
      } else if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        if (statusRef.current !== "playing") startGame();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [startGame]);

  const movePaddle = (clientX: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const boardX = ((clientX - rect.left) / rect.width) * BOARD_WIDTH;
    paddleXRef.current = Math.max(0, Math.min(BOARD_WIDTH - PADDLE_WIDTH, boardX - PADDLE_WIDTH / 2));
  };

  const overlayKey = status === "won" ? "won" : status === "lost" ? "lost" : status === "paused" ? "lifeLost" : "ready";

  return (
    <div className="relative h-[520px] overflow-hidden border border-white/[0.08] bg-[#080b10]">
      <canvas
        ref={canvasRef}
        className="h-full w-full touch-none outline-none"
        tabIndex={0}
        aria-label={t("pikoMiniGame.breakout.canvasLabel")}
        onPointerMove={(event) => movePaddle(event.clientX)}
        onPointerDown={(event) => {
          movePaddle(event.clientX);
          if (statusRef.current !== "playing") startGame();
        }}
      />

      <div className="pointer-events-none absolute inset-x-4 top-4 flex items-center justify-between text-sm font-medium text-white/78">
        <span>{t("pikoMiniGame.breakout.score", { score })}</span>
        <span>{t("pikoMiniGame.breakout.lives", { lives })}</span>
      </div>

      {status !== "playing" ? (
        <div className="absolute inset-0 grid place-items-center bg-black/52 px-5 backdrop-blur-[2px]">
          <div className="max-w-sm rounded-2xl border border-white/[0.14] bg-black/68 px-7 py-6 text-center shadow-[0_24px_72px_rgba(0,0,0,0.48)]">
            <h3 className="text-2xl font-semibold text-white">{t(`pikoMiniGame.breakout.${overlayKey}`)}</h3>
            <p className="mt-2 text-sm leading-6 text-white/58">{t("pikoMiniGame.breakout.hint")}</p>
            <div className="mt-6 flex justify-center gap-3">
              {(status === "won" || status === "lost") ? (
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
                {status === "won" || status === "lost" ? t("pikoMiniGame.playAgain") : t("pikoMiniGame.breakout.start")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
