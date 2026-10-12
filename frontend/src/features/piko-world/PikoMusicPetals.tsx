// SPDX-License-Identifier: Elastic-2.0
import { useEffect, useRef } from "react";
import styles from "./piko-music.module.css";

type Petal = { born: number; dx: number; dy: number; size: number; phase: number };
const LIFETIME = 2600;

/** Small petals leave the needle while playing; existing petals finish after pause. */
export function PikoMusicPetals({ emitting }: { emitting: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const emittingRef = useRef(emitting);
  useEffect(() => { emittingRef.current = emitting; }, [emitting]);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sheet = new Image();
    let disposed = false;
    let frame = 0;
    let lastSpawn = 0;
    let petals: Petal[] = [];
    const draw = (now: number) => {
      if (disposed) return;
      context.clearRect(0, 0, 600, 600);
      if (reduced.matches || document.hidden) { petals = []; lastSpawn = now; }
      else {
        if (emittingRef.current && now - lastSpawn >= 420) {
          lastSpawn = now;
          const angle = Math.random() * Math.PI * 2;
          const distance = 65 + Math.random() * 65;
          petals.push({ born: now, dx: Math.cos(angle) * distance, dy: Math.sin(angle) * distance,
            size: 22 + Math.random() * 10, phase: Math.floor(Math.random() * 16) });
        }
        petals = petals.filter(petal => now - petal.born < LIFETIME);
        for (const petal of petals) {
          const progress = (now - petal.born) / LIFETIME;
          const cell = (Math.floor(progress * 24) + petal.phase) % 16;
          const width = sheet.naturalWidth / 4;
          const height = sheet.naturalHeight / 4;
          context.globalAlpha = Math.min(1, progress * 8) * Math.min(1, (1 - progress) * 3) * 0.85;
          context.save();
          context.translate(414 + petal.dx * progress + Math.sin(progress * Math.PI * 2 + petal.phase) * 8 * progress,
            361 + petal.dy * progress + 18 * progress * progress);
          context.rotate(progress * 0.7);
          context.drawImage(sheet, (cell % 4) * width, Math.floor(cell / 4) * height, width, height,
            -petal.size / 2, -petal.size / 2, petal.size, petal.size);
          context.restore();
        }
        context.globalAlpha = 1;
      }
      frame = requestAnimationFrame(draw);
    };
    sheet.onload = () => { if (!disposed) frame = requestAnimationFrame(draw); };
    sheet.src = "/piko/world/ui/music-player/pink-petal-sequence-v1.png";
    return () => { disposed = true; cancelAnimationFrame(frame); sheet.onload = null; };
  }, []);
  return <canvas ref={canvasRef} className={styles.petals} width={600} height={600} aria-hidden="true" />;
}
