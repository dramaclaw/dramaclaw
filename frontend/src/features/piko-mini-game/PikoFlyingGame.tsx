// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PikoActionFigure } from "@/features/companion/PikoActionFigure";
import { usePikoGameAudio } from "@/features/piko-mini-game/usePikoGameAudio";

const BOARD_WIDTH = 800;
const BOARD_HEIGHT = 520;
const PIKO_X = 172;
const PIKO_RADIUS = 18;
const GRAVITY = 1_180;
const FLAP_VELOCITY = -390;
const GATE_WIDTH = 76;
const GATE_GAP = 168;
const GATE_SPACING = 285;

type FlyingStatus = "ready" | "playing" | "lost";

type Gate = {
  id: number;
  x: number;
  gapY: number;
  scored: boolean;
};

function randomGapY() {
  return 135 + Math.random() * 250;
}

function makeGates(): Gate[] {
  return Array.from({ length: 4 }, (_, index) => ({
    id: index,
    x: 650 + index * GATE_SPACING,
    gapY: randomGapY(),
    scored: false,
  }));
}

export function PikoFlyingGame({ onClose, muted }: { onClose: () => void; muted: boolean }) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const previousTimeRef = useRef<number | null>(null);
  const statusRef = useRef<FlyingStatus>("ready");
  const yRef = useRef(BOARD_HEIGHT / 2);
  const velocityRef = useRef(0);
  const gatesRef = useRef<Gate[]>(makeGates());
  const nextGateIdRef = useRef(4);
  const scoreRef = useRef(0);
  const [status, setStatus] = useState<FlyingStatus>("ready");
  const [pikoY, setPikoY] = useState(BOARD_HEIGHT / 2);
  const [velocity, setVelocity] = useState(0);
  const [score, setScore] = useState(0);
  const playTone = usePikoGameAudio(muted);

  const playFlapSound = useCallback(() => {
    playTone(420, 0.075, 0.075, "triangle", 0, 760);
    playTone(920, 0.045, 0.035, "sine", 0.04, 1_180);
  }, [playTone]);

  const playStartSound = useCallback(() => {
    playTone(392, 0.08, 0.07, "triangle");
    playTone(523.25, 0.09, 0.075, "triangle", 0.085);
    playTone(783.99, 0.12, 0.08, "triangle", 0.18);
  }, [playTone]);

  const playScoreSound = useCallback((nextScore: number) => {
    const lift = Math.min(nextScore, 12) * 12;
    playTone(760 + lift, 0.07, 0.075, "sine");
    playTone(1_120 + lift, 0.09, 0.055, "triangle", 0.045);
    if (nextScore % 5 === 0) {
      playTone(523.25, 0.18, 0.06, "triangle", 0.12);
      playTone(659.25, 0.18, 0.055, "triangle", 0.17);
      playTone(783.99, 0.22, 0.05, "triangle", 0.22);
    }
  }, [playTone]);

  const playCollisionSound = useCallback(() => {
    playTone(220, 0.24, 0.11, "sawtooth", 0, 72);
    playTone(130, 0.28, 0.07, "square", 0.04, 55);
  }, [playTone]);

  const setGameStatus = useCallback((next: FlyingStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const resetGame = useCallback(() => {
    yRef.current = BOARD_HEIGHT / 2;
    velocityRef.current = 0;
    gatesRef.current = makeGates();
    nextGateIdRef.current = 4;
    scoreRef.current = 0;
    setPikoY(BOARD_HEIGHT / 2);
    setVelocity(0);
    setScore(0);
    setGameStatus("ready");
  }, [setGameStatus]);

  const flap = useCallback(() => {
    if (statusRef.current !== "playing") return;
    velocityRef.current = FLAP_VELOCITY;
    setVelocity(FLAP_VELOCITY);
    playFlapSound();
  }, [playFlapSound]);

  const startGame = useCallback(() => {
    if (statusRef.current === "lost") resetGame();
    previousTimeRef.current = null;
    setGameStatus("playing");
    velocityRef.current = FLAP_VELOCITY;
    setVelocity(FLAP_VELOCITY);
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
    background.addColorStop(0, "#111827");
    background.addColorStop(0.58, "#0b1220");
    background.addColorStop(1, "#070a0f");
    context.fillStyle = background;
    context.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);

    for (let index = 0; index < 38; index += 1) {
      const x = (index * 137 + 41) % BOARD_WIDTH;
      const y = (index * 79 + 27) % BOARD_HEIGHT;
      context.fillStyle = index % 4 === 0 ? "rgba(190,242,100,0.38)" : "rgba(165,243,252,0.28)";
      context.fillRect(x, y, index % 5 === 0 ? 2 : 1, index % 5 === 0 ? 2 : 1);
    }

    for (const gate of gatesRef.current) {
      const gapTop = gate.gapY - GATE_GAP / 2;
      const gapBottom = gate.gapY + GATE_GAP / 2;
      const gradient = context.createLinearGradient(gate.x, 0, gate.x + GATE_WIDTH, 0);
      gradient.addColorStop(0, "rgba(8,145,178,0.48)");
      gradient.addColorStop(0.5, "rgba(103,232,249,0.82)");
      gradient.addColorStop(1, "rgba(30,64,175,0.45)");
      context.fillStyle = gradient;
      context.shadowColor = "rgba(103,232,249,0.32)";
      context.shadowBlur = 18;
      context.fillRect(gate.x, 0, GATE_WIDTH, gapTop);
      context.fillRect(gate.x, gapBottom, GATE_WIDTH, BOARD_HEIGHT - gapBottom);

      context.fillStyle = "rgba(236,254,255,0.92)";
      context.shadowBlur = 22;
      context.fillRect(gate.x - 7, gapTop - 8, GATE_WIDTH + 14, 8);
      context.fillRect(gate.x - 7, gapBottom, GATE_WIDTH + 14, 8);
      context.shadowBlur = 0;

      context.strokeStyle = "rgba(236,254,255,0.18)";
      context.lineWidth = 1;
      for (let y = 18; y < gapTop - 12; y += 28) {
        context.beginPath();
        context.moveTo(gate.x + 12, y);
        context.lineTo(gate.x + GATE_WIDTH - 12, y);
        context.stroke();
      }
      for (let y = gapBottom + 20; y < BOARD_HEIGHT; y += 28) {
        context.beginPath();
        context.moveTo(gate.x + 12, y);
        context.lineTo(gate.x + GATE_WIDTH - 12, y);
        context.stroke();
      }
    }
  }, []);

  useEffect(() => {
    const tick = (time: number) => {
      const previousTime = previousTimeRef.current ?? time;
      previousTimeRef.current = time;
      const delta = Math.min((time - previousTime) / 1000, 0.025);

      if (statusRef.current === "playing") {
        velocityRef.current += GRAVITY * delta;
        yRef.current += velocityRef.current * delta;
        const gateSpeed = Math.min(190 + scoreRef.current * 5, 310);
        for (const gate of gatesRef.current) gate.x -= gateSpeed * delta;

        for (const gate of gatesRef.current) {
          if (!gate.scored && gate.x + GATE_WIDTH < PIKO_X - PIKO_RADIUS) {
            gate.scored = true;
            scoreRef.current += 1;
            setScore(scoreRef.current);
            playScoreSound(scoreRef.current);
          }
        }

        const passedGates = gatesRef.current.filter((gate) => gate.x + GATE_WIDTH < -10);
        if (passedGates.length > 0) {
          gatesRef.current = gatesRef.current.filter((gate) => gate.x + GATE_WIDTH >= -10);
          let nextX = Math.max(...gatesRef.current.map((gate) => gate.x), BOARD_WIDTH) + GATE_SPACING;
          for (let index = 0; index < passedGates.length; index += 1) {
            gatesRef.current.push({
              id: nextGateIdRef.current++,
              x: nextX,
              gapY: randomGapY(),
              scored: false,
            });
            nextX += GATE_SPACING;
          }
        }

        const hitGate = gatesRef.current.some((gate) => {
          const overlapsX =
            PIKO_X + PIKO_RADIUS > gate.x && PIKO_X - PIKO_RADIUS < gate.x + GATE_WIDTH;
          if (!overlapsX) return false;
          return (
            yRef.current - PIKO_RADIUS < gate.gapY - GATE_GAP / 2 ||
            yRef.current + PIKO_RADIUS > gate.gapY + GATE_GAP / 2
          );
        });
        const outsideBoard =
          yRef.current - PIKO_RADIUS <= 0 || yRef.current + PIKO_RADIUS >= BOARD_HEIGHT;
        if (hitGate || outsideBoard) {
          setGameStatus("lost");
          playCollisionSound();
        }

        setPikoY(yRef.current);
        setVelocity(velocityRef.current);
      }

      draw();
      frameRef.current = window.requestAnimationFrame(tick);
    };
    frameRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    };
  }, [draw, playCollisionSound, playScoreSound, setGameStatus]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== " " && event.key !== "ArrowUp") return;
      event.preventDefault();
      if (statusRef.current === "playing") flap();
      else startGame();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [flap, startGame]);

  const pikoRotation = Math.max(-18, Math.min(28, velocity / 18));

  return (
    <div className="relative h-[520px] overflow-hidden border border-white/[0.08] bg-[#070a0f]">
      <canvas
        ref={canvasRef}
        className="h-full w-full touch-none outline-none"
        tabIndex={0}
        aria-label={t("pikoMiniGame.flying.canvasLabel")}
        onPointerDown={() => {
          if (statusRef.current === "playing") flap();
          else startGame();
        }}
      />

      <div
        className="pointer-events-none absolute size-[58px]"
        style={{
          left: `${(PIKO_X / BOARD_WIDTH) * 100}%`,
          top: `${(pikoY / BOARD_HEIGHT) * 100}%`,
          transform: `translate(-50%, -50%) rotate(${pikoRotation}deg)`,
        }}
      >
        <PikoActionFigure
          action="idle"
          className="mybuddy-companion-anchor--preview !h-[58px]"
          style={{ transform: "scale(0.78)", transformOrigin: "center" }}
        />
      </div>

      <div className="pointer-events-none absolute left-4 top-4 text-sm font-medium text-white/78">
        {t("pikoMiniGame.flying.score", { score })}
      </div>

      {status !== "playing" ? (
        <div className="absolute inset-0 grid place-items-center bg-black/52 px-5 backdrop-blur-[2px]">
          <div className="max-w-sm rounded-2xl border border-white/[0.14] bg-black/68 px-7 py-6 text-center shadow-[0_24px_72px_rgba(0,0,0,0.48)]">
            <h3 className="text-2xl font-semibold text-white">
              {t(status === "lost" ? "pikoMiniGame.flying.lost" : "pikoMiniGame.flying.ready")}
            </h3>
            <p className="mt-2 text-sm leading-6 text-white/58">{t("pikoMiniGame.flying.hint")}</p>
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
                {status === "lost" ? t("pikoMiniGame.playAgain") : t("pikoMiniGame.flying.start")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
