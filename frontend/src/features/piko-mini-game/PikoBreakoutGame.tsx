// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PikoGameHud, PikoGameOverlay } from "@/features/piko-mini-game/PikoGameChrome";
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

type BreakoutStatus = "ready" | "playing" | "paused" | "wave" | "won" | "lost";
type BrickKind = "normal" | "armored" | "blast";

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
  kind: BrickKind;
  hits: number;
};

function makeBricks(wave = 1): Brick[] {
  return Array.from({ length: BRICK_ROWS * BRICK_COLUMNS }, (_, id) => ({
    id,
    row: Math.floor(id / BRICK_COLUMNS),
    column: id % BRICK_COLUMNS,
    alive: true,
    kind:
      wave >= 2 && (id + wave) % 7 === 0
        ? "armored"
        : (id + wave * 3) % 13 === 0
          ? "blast"
          : "normal",
    hits: wave >= 2 && (id + wave) % 7 === 0 ? 2 : 1,
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
  const waveRef = useRef(1);
  const [status, setStatus] = useState<BreakoutStatus>("ready");
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(STARTING_LIVES);
  const [wave, setWave] = useState(1);
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
    bricksRef.current = makeBricks(1);
    scoreRef.current = 0;
    livesRef.current = STARTING_LIVES;
    waveRef.current = 1;
    setScore(0);
    setLives(STARTING_LIVES);
    setWave(1);
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
      context.fillStyle = brick.kind === "armored" ? "#94a3b8" : brick.kind === "blast" ? "#fb7185" : rowColors[brick.row];
      context.globalAlpha = 0.82;
      context.beginPath();
      context.roundRect(x, y, brickWidth, BRICK_HEIGHT, 4);
      context.fill();
      context.globalAlpha = 1;
      if (brick.kind !== "normal") {
        context.strokeStyle = brick.kind === "blast" ? "rgba(255,255,255,0.72)" : "rgba(255,255,255,0.46)";
        context.lineWidth = brick.hits > 1 ? 2 : 1;
        context.beginPath();
        if (brick.kind === "blast") {
          context.moveTo(x + brickWidth / 2, y + 5);
          context.lineTo(x + brickWidth / 2, y + BRICK_HEIGHT - 5);
          context.moveTo(x + brickWidth / 2 - 7, y + BRICK_HEIGHT / 2);
          context.lineTo(x + brickWidth / 2 + 7, y + BRICK_HEIGHT / 2);
        } else {
          context.roundRect(x + 5, y + 5, brickWidth - 10, BRICK_HEIGHT - 10, 2);
        }
        context.stroke();
      }
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

    const pikoCenterX = paddleXRef.current + PADDLE_WIDTH / 2;
    context.shadowBlur = 8;
    context.fillStyle = "#f8fafc";
    context.beginPath();
    context.roundRect(pikoCenterX - 13, PADDLE_Y - 22, 26, 18, 6);
    context.fill();
    context.shadowBlur = 0;
    context.fillStyle = "#0f172a";
    context.fillRect(pikoCenterX - 7, PADDLE_Y - 16, 3, 6);
    context.fillRect(pikoCenterX + 4, PADDLE_Y - 16, 3, 6);
    context.fillStyle = "#84cc16";
    context.fillRect(pikoCenterX + 2, PADDLE_Y - 28, 8, 5);

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

          brick.hits -= 1;
          const destroyed = brick.hits <= 0;
          brick.alive = !destroyed;
          scoreRef.current += destroyed ? (BRICK_ROWS - brick.row) * 10 : 5;
          if (destroyed && brick.kind === "blast") {
            for (const neighbor of bricksRef.current) {
              if (
                neighbor.alive &&
                Math.abs(neighbor.row - brick.row) <= 1 &&
                Math.abs(neighbor.column - brick.column) <= 1
              ) {
                neighbor.alive = false;
                scoreRef.current += 8;
              }
            }
          }
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
          if (waveRef.current < 3) {
            const nextWave = waveRef.current + 1;
            waveRef.current = nextWave;
            setWave(nextWave);
            bricksRef.current = makeBricks(nextWave);
            resetBall();
            setGameStatus("wave");
            playWinSound();
          } else {
            setGameStatus("won");
            playWinSound();
          }
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

  const overlayKey = status === "won"
    ? "won"
    : status === "lost"
      ? "lost"
      : status === "paused"
        ? "lifeLost"
        : status === "wave"
          ? "waveClear"
          : "ready";

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

      <PikoGameHud
        left={t("pikoMiniGame.breakout.score", { score })}
        center={t("pikoMiniGame.breakout.wave", { wave, total: 3 })}
        right={t("pikoMiniGame.breakout.lives", { lives })}
      />

      {status !== "playing" ? (
        <PikoGameOverlay
          title={t(`pikoMiniGame.breakout.${overlayKey}`)}
          description={t("pikoMiniGame.breakout.hint")}
          primaryLabel={status === "won" || status === "lost" ? t("pikoMiniGame.playAgain") : t("pikoMiniGame.breakout.start")}
          onPrimary={startGame}
          secondaryLabel={status === "won" || status === "lost" ? t("pikoMiniGame.backToWork") : undefined}
          onSecondary={status === "won" || status === "lost" ? onClose : undefined}
        />
      ) : null}
    </div>
  );
}
