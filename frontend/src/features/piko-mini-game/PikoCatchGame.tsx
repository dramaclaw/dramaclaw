// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PikoActionFigure } from "@/features/companion/PikoActionFigure";
import { usePikoGameAudio } from "@/features/piko-mini-game/usePikoGameAudio";

const BOARD_WIDTH = 800;
const BOARD_HEIGHT = 520;
const GAME_DURATION_MS = 45_000;
const PIKO_Y = 458;
const CATCH_X_RANGE = 42;
const CATCH_Y_RANGE = 34;
const STARTING_LIVES = 3;

type CatchStatus = "ready" | "playing" | "finished" | "lost";
type FallingKind = "spark" | "crystal" | "glitch";

type FallingItem = {
  id: number;
  x: number;
  y: number;
  speed: number;
  size: number;
  rotation: number;
  kind: FallingKind;
};

function makeItem(id: number, elapsed: number, forcedKind?: FallingKind): FallingItem {
  const roll = Math.random();
  const progress = Math.min(1, elapsed / GAME_DURATION_MS);
  const glitchChance = 0.22 + progress * 0.16;
  const crystalChance = 0.15;
  const kind: FallingKind = forcedKind ?? (
    roll < glitchChance ? "glitch" : roll < glitchChance + crystalChance ? "crystal" : "spark"
  );
  return {
    id,
    x: 36 + Math.random() * (BOARD_WIDTH - 72),
    y: -24,
    speed: 135 + Math.min(elapsed / 220, 125) + Math.random() * 75,
    size: kind === "crystal" ? 15 : kind === "glitch" ? 14 : 11,
    rotation: Math.random() * Math.PI * 2,
    kind,
  };
}

export function PikoCatchGame({ onClose, muted }: { onClose: () => void; muted: boolean }) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const previousTimeRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const lastSpawnRef = useRef(0);
  const statusRef = useRef<CatchStatus>("ready");
  const pikoXRef = useRef(BOARD_WIDTH / 2);
  const itemsRef = useRef<FallingItem[]>([]);
  const nextItemIdRef = useRef(0);
  const heldKeysRef = useRef({ left: false, right: false });
  const pointerTargetRef = useRef<number | null>(null);
  const scoreRef = useRef(0);
  const livesRef = useRef(STARTING_LIVES);
  const hurtTimerRef = useRef<number | null>(null);
  const [status, setStatus] = useState<CatchStatus>("ready");
  const [pikoX, setPikoX] = useState(BOARD_WIDTH / 2);
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(STARTING_LIVES);
  const [timeLeft, setTimeLeft] = useState(GAME_DURATION_MS / 1000);
  const [isHurt, setIsHurt] = useState(false);
  const playTone = usePikoGameAudio(muted);

  const setGameStatus = useCallback((next: CatchStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const playStartSound = useCallback(() => {
    playTone(392, 0.08, 0.06, "triangle");
    playTone(587.33, 0.09, 0.065, "triangle", 0.08);
    playTone(783.99, 0.12, 0.07, "triangle", 0.17);
  }, [playTone]);

  const playCatchSound = useCallback((kind: FallingKind) => {
    if (kind === "crystal") {
      playTone(880, 0.08, 0.08, "triangle");
      playTone(1_318.5, 0.13, 0.06, "sine", 0.05);
      return;
    }
    playTone(660, 0.06, 0.06, "sine", 0, 880);
  }, [playTone]);

  const playHurtSound = useCallback(() => {
    playTone(210, 0.22, 0.1, "sawtooth", 0, 68);
    playTone(120, 0.2, 0.055, "square", 0.05, 52);
  }, [playTone]);

  const playFinishSound = useCallback((lost: boolean) => {
    if (lost) {
      playTone(220, 0.3, 0.09, "sawtooth", 0, 55);
      return;
    }
    playTone(523.25, 0.18, 0.065, "triangle");
    playTone(659.25, 0.2, 0.06, "triangle", 0.1);
    playTone(783.99, 0.26, 0.055, "triangle", 0.2);
  }, [playTone]);

  useEffect(() => {
    return () => {
      if (hurtTimerRef.current !== null) window.clearTimeout(hurtTimerRef.current);
    };
  }, []);

  const resetGame = useCallback(() => {
    pikoXRef.current = BOARD_WIDTH / 2;
    itemsRef.current = [];
    nextItemIdRef.current = 0;
    scoreRef.current = 0;
    livesRef.current = STARTING_LIVES;
    heldKeysRef.current = { left: false, right: false };
    pointerTargetRef.current = null;
    setPikoX(BOARD_WIDTH / 2);
    setScore(0);
    setLives(STARTING_LIVES);
    setTimeLeft(GAME_DURATION_MS / 1000);
    if (hurtTimerRef.current !== null) window.clearTimeout(hurtTimerRef.current);
    hurtTimerRef.current = null;
    setIsHurt(false);
    setGameStatus("ready");
  }, [setGameStatus]);

  const startGame = useCallback(() => {
    if (statusRef.current === "finished" || statusRef.current === "lost") resetGame();
    const now = performance.now();
    startedAtRef.current = now;
    lastSpawnRef.current = now - 400;
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
    background.addColorStop(0, "#101722");
    background.addColorStop(1, "#070a0f");
    context.fillStyle = background;
    context.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);

    context.strokeStyle = "rgba(165,243,252,0.065)";
    context.lineWidth = 1;
    for (let x = 20; x < BOARD_WIDTH; x += 44) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, BOARD_HEIGHT);
      context.stroke();
    }

    for (const item of itemsRef.current) {
      context.save();
      context.translate(item.x, item.y);
      context.rotate(item.rotation);
      context.shadowBlur = 16;
      if (item.kind === "glitch") {
        context.fillStyle = "#fb7185";
        context.shadowColor = "rgba(251,113,133,0.55)";
        context.fillRect(-item.size, -item.size, item.size * 2, item.size * 2);
        context.fillStyle = "#111827";
        context.fillRect(-item.size * 0.55, -2, item.size * 1.1, 4);
      } else if (item.kind === "crystal") {
        context.fillStyle = "#bef264";
        context.shadowColor = "rgba(190,242,100,0.65)";
        context.beginPath();
        context.moveTo(0, -item.size);
        context.lineTo(item.size * 0.78, 0);
        context.lineTo(0, item.size);
        context.lineTo(-item.size * 0.78, 0);
        context.closePath();
        context.fill();
      } else {
        context.fillStyle = "#a5f3fc";
        context.shadowColor = "rgba(165,243,252,0.7)";
        context.beginPath();
        for (let point = 0; point < 8; point += 1) {
          const angle = -Math.PI / 2 + point * Math.PI / 4;
          const radius = point % 2 === 0 ? item.size : item.size * 0.38;
          const x = Math.cos(angle) * radius;
          const y = Math.sin(angle) * radius;
          if (point === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.closePath();
        context.fill();
      }
      context.restore();
    }
  }, []);

  useEffect(() => {
    const tick = (now: number) => {
      const previous = previousTimeRef.current ?? now;
      previousTimeRef.current = now;
      const delta = Math.min((now - previous) / 1000, 0.025);

      if (statusRef.current === "playing") {
        const elapsed = now - startedAtRef.current;
        const remaining = Math.max(0, GAME_DURATION_MS - elapsed);
        const spawnInterval = Math.max(235, 570 - elapsed / 120);
        let direction = Number(heldKeysRef.current.right) - Number(heldKeysRef.current.left);
        const pointerTarget = pointerTargetRef.current;
        if (direction === 0 && pointerTarget !== null) {
          const distance = pointerTarget - pikoXRef.current;
          direction = Math.abs(distance) < 7 ? 0 : Math.sign(distance);
        }
        pikoXRef.current = Math.max(34, Math.min(BOARD_WIDTH - 34, pikoXRef.current + direction * 345 * delta));

        if (now - lastSpawnRef.current >= spawnInterval) {
          lastSpawnRef.current = now;
          itemsRef.current.push(makeItem(nextItemIdRef.current++, elapsed));
          if (Math.random() < 0.6) {
            const bonusKind: FallingKind = Math.random() < 0.3 ? "crystal" : "spark";
            itemsRef.current.push(makeItem(nextItemIdRef.current++, elapsed, bonusKind));
          }
        }

        const caughtIds = new Set<number>();
        for (const item of itemsRef.current) {
          item.y += item.speed * delta;
          item.rotation += delta * (item.kind === "glitch" ? 3.8 : 2.2);
          const caught =
            Math.abs(item.x - pikoXRef.current) <= CATCH_X_RANGE + item.size / 2 &&
            Math.abs(item.y - PIKO_Y) <= CATCH_Y_RANGE;
          if (!caught) continue;
          caughtIds.add(item.id);
          if (item.kind === "glitch") {
            livesRef.current -= 1;
            setLives(livesRef.current);
            setIsHurt(true);
            if (hurtTimerRef.current !== null) window.clearTimeout(hurtTimerRef.current);
            hurtTimerRef.current = window.setTimeout(() => {
              setIsHurt(false);
              hurtTimerRef.current = null;
            }, 280);
            playHurtSound();
          } else {
            const points = item.kind === "crystal" ? 3 : 1;
            scoreRef.current += points;
            setScore(scoreRef.current);
            playCatchSound(item.kind);
          }
        }
        itemsRef.current = itemsRef.current.filter((item) => !caughtIds.has(item.id) && item.y < BOARD_HEIGHT + 30);

        setPikoX(pikoXRef.current);
        setTimeLeft(Math.ceil(remaining / 1000));
        if (livesRef.current <= 0) {
          setGameStatus("lost");
          playFinishSound(true);
        } else if (remaining <= 0) {
          setGameStatus("finished");
          playFinishSound(false);
        }
      }

      draw();
      frameRef.current = window.requestAnimationFrame(tick);
    };
    frameRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    };
  }, [draw, playCatchSound, playFinishSound, playHurtSound, setGameStatus]);

  useEffect(() => {
    const setKeyState = (event: KeyboardEvent, pressed: boolean) => {
      const key = event.key.toLowerCase();
      if (key === "arrowleft" || key === "a") {
        event.preventDefault();
        heldKeysRef.current.left = pressed;
        pointerTargetRef.current = null;
      } else if (key === "arrowright" || key === "d") {
        event.preventDefault();
        heldKeysRef.current.right = pressed;
        pointerTargetRef.current = null;
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
    pointerTargetRef.current = ((clientX - rect.left) / rect.width) * BOARD_WIDTH;
  };

  return (
    <div className="relative h-[520px] overflow-hidden border border-white/[0.08] bg-[#070a0f]">
      <canvas
        ref={canvasRef}
        className="h-full w-full touch-none outline-none"
        tabIndex={0}
        aria-label={t("pikoMiniGame.catch.canvasLabel")}
        onPointerMove={(event) => setPointerTarget(event.clientX)}
        onPointerDown={(event) => {
          setPointerTarget(event.clientX);
          if (statusRef.current !== "playing") startGame();
        }}
        onPointerLeave={() => {
          pointerTargetRef.current = null;
        }}
      />

      <div
        className="pointer-events-none absolute size-[62px]"
        style={{
          left: `${(pikoX / BOARD_WIDTH) * 100}%`,
          top: `${(PIKO_Y / BOARD_HEIGHT) * 100}%`,
          transform: `translate(-50%, -50%) ${isHurt ? "rotate(8deg) scale(0.88)" : ""}`,
        }}
      >
        <PikoActionFigure
          action={isHurt ? "repair" : "idle"}
          className="mybuddy-companion-anchor--preview !h-[62px]"
          style={{ transform: "scale(0.82)", transformOrigin: "center" }}
        />
      </div>

      <div className="pointer-events-none absolute inset-x-4 top-4 flex justify-between text-sm font-medium text-white/78">
        <span>{t("pikoMiniGame.catch.score", { score })}</span>
        <span>{t("pikoMiniGame.catch.status", { lives, seconds: timeLeft })}</span>
      </div>

      {status !== "playing" ? (
        <div className="absolute inset-0 grid place-items-center bg-black/52 px-5 backdrop-blur-[2px]">
          <div className="max-w-sm rounded-2xl border border-white/[0.14] bg-black/68 px-7 py-6 text-center shadow-[0_24px_72px_rgba(0,0,0,0.48)]">
            <h3 className="text-2xl font-semibold text-white">
              {t(
                status === "finished"
                  ? "pikoMiniGame.catch.finished"
                  : status === "lost"
                    ? "pikoMiniGame.catch.lost"
                    : "pikoMiniGame.catch.ready",
              )}
            </h3>
            <p className="mt-2 text-sm leading-6 text-white/58">
              {status === "ready"
                ? t("pikoMiniGame.catch.hint")
                : t("pikoMiniGame.catch.result", { score })}
            </p>
            <div className="mt-6 flex justify-center gap-3">
              {status === "finished" || status === "lost" ? (
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
                {status === "ready" ? t("pikoMiniGame.catch.start") : t("pikoMiniGame.playAgain")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
