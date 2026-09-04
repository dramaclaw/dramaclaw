// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PikoActionFigure } from "@/features/companion/PikoActionFigure";
import { PikoGameHud, PikoGameOverlay } from "@/features/piko-mini-game/PikoGameChrome";
import { usePikoGameAudio } from "@/features/piko-mini-game/usePikoGameAudio";

const BOARD_WIDTH = 800;
const BOARD_HEIGHT = 520;
const PIKO_X = 172;
const PIKO_RADIUS = 18;
const GRAVITY = 1_180;
const FLAP_VELOCITY = -390;
const GATE_WIDTH = 76;
const GATE_GAP = 172;
const GATE_SPACING = 285;

type FlyingStatus = "ready" | "playing" | "lost";
type GateKind = "beam" | "gear" | "pulse";

type Gate = {
  id: number;
  x: number;
  gapY: number;
  gapSize: number;
  kind: GateKind;
  hasShield: boolean;
  scored: boolean;
};

const GATE_PATTERNS = [185, 330, 245, 365, 155, 285] as const;

function makeGate(id: number, x: number): Gate {
  const kind: GateKind = id % 3 === 1 ? "gear" : id % 3 === 2 ? "pulse" : "beam";
  return {
    id,
    x,
    gapY: GATE_PATTERNS[id % GATE_PATTERNS.length],
    gapSize: Math.max(142, GATE_GAP - Math.floor(id / 6) * 4),
    kind,
    hasShield: id > 0 && id % 7 === 0,
    scored: false,
  };
}

function makeGates(): Gate[] {
  return Array.from({ length: 4 }, (_, index) => makeGate(index, 650 + index * GATE_SPACING));
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
  const passCountRef = useRef(0);
  const precisionStreakRef = useRef(0);
  const shieldAvailableRef = useRef(true);
  const [status, setStatus] = useState<FlyingStatus>("ready");
  const [pikoY, setPikoY] = useState(BOARD_HEIGHT / 2);
  const [velocity, setVelocity] = useState(0);
  const [score, setScore] = useState(0);
  const [precisionStreak, setPrecisionStreak] = useState(0);
  const [shieldAvailable, setShieldAvailable] = useState(true);
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
    passCountRef.current = 0;
    precisionStreakRef.current = 0;
    shieldAvailableRef.current = true;
    setPikoY(BOARD_HEIGHT / 2);
    setVelocity(0);
    setScore(0);
    setPrecisionStreak(0);
    setShieldAvailable(true);
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
    for (let index = 0; index < 12; index += 1) {
      const y = 34 + index * 41;
      const length = 24 + (index % 4) * 18;
      context.strokeStyle = `rgba(103,232,249,${0.035 + (index % 3) * 0.018})`;
      context.lineWidth = 2;
      context.beginPath();
      context.moveTo((index * 93 + scoreRef.current * 9) % BOARD_WIDTH, y);
      context.lineTo(((index * 93 + scoreRef.current * 9) % BOARD_WIDTH) + length, y);
      context.stroke();
    }

    for (const gate of gatesRef.current) {
      const gapTop = gate.gapY - gate.gapSize / 2;
      const gapBottom = gate.gapY + gate.gapSize / 2;
      const gradient = context.createLinearGradient(gate.x, 0, gate.x + GATE_WIDTH, 0);
      gradient.addColorStop(0, gate.kind === "gear" ? "rgba(190,24,93,0.52)" : "rgba(8,145,178,0.48)");
      gradient.addColorStop(0.5, gate.kind === "pulse" ? "rgba(167,139,250,0.86)" : "rgba(103,232,249,0.82)");
      gradient.addColorStop(1, gate.kind === "gear" ? "rgba(244,63,94,0.5)" : "rgba(30,64,175,0.45)");
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

      if (gate.kind === "gear") {
        context.fillStyle = "rgba(251,113,133,0.78)";
        for (let tooth = 0; tooth < 5; tooth += 1) {
          context.fillRect(gate.x - 7, tooth * 34 + 8, 9, 14);
          context.fillRect(gate.x + GATE_WIDTH - 2, BOARD_HEIGHT - tooth * 34 - 24, 9, 14);
        }
      }

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

      if (gate.hasShield) {
        context.fillStyle = "rgba(190,242,100,0.92)";
        context.shadowColor = "rgba(190,242,100,0.7)";
        context.shadowBlur = 16;
        context.beginPath();
        context.moveTo(gate.x + GATE_WIDTH / 2, gate.gapY - 12);
        context.lineTo(gate.x + GATE_WIDTH / 2 + 10, gate.gapY);
        context.lineTo(gate.x + GATE_WIDTH / 2, gate.gapY + 12);
        context.lineTo(gate.x + GATE_WIDTH / 2 - 10, gate.gapY);
        context.closePath();
        context.fill();
        context.shadowBlur = 0;
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
        const gateSpeed = Math.min(190 + passCountRef.current * 7, 310);
        for (const gate of gatesRef.current) gate.x -= gateSpeed * delta;

        for (const gate of gatesRef.current) {
          if (!gate.scored && gate.x + GATE_WIDTH < PIKO_X - PIKO_RADIUS) {
            gate.scored = true;
            passCountRef.current += 1;
            const centerOffset = Math.abs(yRef.current - gate.gapY);
            const edgeClearance = gate.gapSize / 2 - centerOffset - PIKO_RADIUS;
            const centered = centerOffset <= 22;
            const nearMiss = !centered && edgeClearance <= 14;
            const gained = centered ? 3 : nearMiss ? 2 : 1;
            scoreRef.current += gained;
            precisionStreakRef.current = centered ? precisionStreakRef.current + 1 : 0;
            if (gate.hasShield && centered) {
              shieldAvailableRef.current = true;
              setShieldAvailable(true);
            }
            setScore(scoreRef.current);
            setPrecisionStreak(precisionStreakRef.current);
            playScoreSound(scoreRef.current);
          }
        }

        const passedGates = gatesRef.current.filter((gate) => gate.x + GATE_WIDTH < -10);
        if (passedGates.length > 0) {
          gatesRef.current = gatesRef.current.filter((gate) => gate.x + GATE_WIDTH >= -10);
          let nextX = Math.max(...gatesRef.current.map((gate) => gate.x), BOARD_WIDTH) + GATE_SPACING;
          for (let index = 0; index < passedGates.length; index += 1) {
            gatesRef.current.push(makeGate(nextGateIdRef.current++, nextX));
            nextX += GATE_SPACING;
          }
        }

        const hitGate = gatesRef.current.find((gate) => {
          const overlapsX =
            PIKO_X + PIKO_RADIUS > gate.x && PIKO_X - PIKO_RADIUS < gate.x + GATE_WIDTH;
          if (!overlapsX) return false;
          return (
            yRef.current - PIKO_RADIUS < gate.gapY - gate.gapSize / 2 ||
            yRef.current + PIKO_RADIUS > gate.gapY + gate.gapSize / 2
          );
        });
        const outsideBoard =
          yRef.current - PIKO_RADIUS <= 0 || yRef.current + PIKO_RADIUS >= BOARD_HEIGHT;
        if (hitGate || outsideBoard) {
          if (shieldAvailableRef.current) {
            shieldAvailableRef.current = false;
            setShieldAvailable(false);
            precisionStreakRef.current = 0;
            setPrecisionStreak(0);
            yRef.current = hitGate ? hitGate.gapY : BOARD_HEIGHT / 2;
            velocityRef.current = -80;
            if (hitGate) {
              hitGate.x = PIKO_X - GATE_WIDTH - PIKO_RADIUS - 4;
              hitGate.scored = true;
            }
            playTone(260, 0.18, 0.07, "triangle", 0, 1_120);
          } else {
            setGameStatus("lost");
            playCollisionSound();
          }
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
  }, [draw, playCollisionSound, playScoreSound, playTone, setGameStatus]);

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
        className="pointer-events-none absolute size-[66px]"
        style={{
          left: `${(PIKO_X / BOARD_WIDTH) * 100}%`,
          top: `${(pikoY / BOARD_HEIGHT) * 100}%`,
          transform: `translate(-50%, -50%) rotate(${pikoRotation}deg)`,
        }}
      >
        <span className="absolute inset-[8px_2px_7px] rounded-[45%_55%_52%_48%] border border-cyan-100/34 bg-cyan-300/24 shadow-[0_0_20px_rgba(103,232,249,0.26)]" />
        <span className="absolute -left-4 bottom-[15px] h-3 w-7 rounded-full bg-gradient-to-l from-cyan-200/80 to-transparent blur-[1px]" />
        <PikoActionFigure
          action="idle"
          className="mybuddy-companion-anchor--preview !h-[60px]"
          style={{ transform: "scale(0.68)", transformOrigin: "center" }}
        />
      </div>

      <PikoGameHud
        left={t("pikoMiniGame.flying.score", { score })}
        center={precisionStreak > 1 ? t("pikoMiniGame.flying.precision", { streak: precisionStreak }) : undefined}
        right={t(shieldAvailable ? "pikoMiniGame.flying.shieldReady" : "pikoMiniGame.flying.shieldUsed")}
      />

      {status !== "playing" ? (
        <PikoGameOverlay
          title={t(status === "lost" ? "pikoMiniGame.flying.lost" : "pikoMiniGame.flying.ready")}
          description={t("pikoMiniGame.flying.hint")}
          primaryLabel={status === "lost" ? t("pikoMiniGame.playAgain") : t("pikoMiniGame.flying.start")}
          onPrimary={startGame}
          secondaryLabel={status === "lost" ? t("pikoMiniGame.backToWork") : undefined}
          onSecondary={status === "lost" ? onClose : undefined}
          accent="violet"
        />
      ) : null}
    </div>
  );
}
