// SPDX-License-Identifier: Elastic-2.0
import { Container, Graphics, type Ticker } from "pixi.js";

/** Coordinates and glass proportions are in the 2048 × 1152 master map. */
export const COURTYARD_LAMPS = [
  { id: "west-noticeboard", x: 257, y: 354, baseY: 440, width: 1, height: 1, haloScale: 1, clipBottom: 44 },
  { id: "west-tree", x: 547, y: 535, baseY: 570, width: 1, height: 1.1, haloScale: 0.9, clipBottom: 13 },
  { id: "west-fence", x: 375, y: 838, baseY: 893, width: 0.65, height: 0.75, haloScale: 0.85, clipBottom: 44 },
  { id: "east-noticeboard", x: 1568, y: 846, baseY: 924, width: 0.8, height: 0.8, haloScale: 0.9, clipBottom: 44 },
  { id: "entrance-west", x: 878, y: 1053, baseY: 1114, width: 0.55, height: 0.65, haloScale: 0.8, clipBottom: 44 },
  { id: "entrance-east", x: 1234, y: 1053, baseY: 1114, width: 0.65, height: 0.85, haloScale: 0.85, clipBottom: 44 },
  { id: "hall-emblem", x: 1058, y: 216, baseY: 390, width: 1, height: 1.6, haloScale: 1.1, clipBottom: 44 },
  { id: "gate-west", x: 900, y: 875, baseY: 977, width: 1, height: 1, haloScale: 0.9, clipBottom: 44 },
  { id: "gate-east", x: 1217, y: 875, baseY: 977, width: 1, height: 1, haloScale: 0.9, clipBottom: 44 },
] as const;

function createLamp(config: typeof COURTYARD_LAMPS[number], index: number, random: () => number) {
  const container = new Container({ label: `${config.id}-lamp-light`, eventMode: "none", zIndex: config.baseY });
  container.position.set(config.x, config.y);
  // Nested translucent ellipses brighten the baked map without a hard halo edge.
  const halo = new Graphics({ label: "lamp-halo", eventMode: "none", blendMode: "add" });
  for (let radius = 40; radius >= 6; radius -= 2) {
    halo.ellipse(0, 0, radius, radius * 1.1).fill({ color: 0xffbc53, alpha: 0.019 });
  }
  halo.scale.set(config.haloScale);
  // The tree is baked into the master: clip the halo above its foreground edge.
  if (config.clipBottom < 44) {
    const mask = new Graphics({ eventMode: "none" });
    mask.rect(-44, -48, 88, 48 + config.clipBottom).fill(0xffffff);
    container.addChild(mask);
    halo.mask = mask;
  }
  container.addChild(halo);
  // Separate glass panes preserve the baked dark metal mullions and roof.
  const core = new Graphics({ label: "lamp-core", eventMode: "none", blendMode: "add" });
  if (config.id === "hall-emblem") {
      core.poly([0, -15, 6, 0, 0, 11, -5, 0]).fill(0xffdf86);
  } else {
    core.poly([-8, -9, -4, -8, -3, 8, -6, 6]).fill(0xffd777);
    core.poly([-2, -8, 3, -8, 2, 9, -1, 9]).fill(0xffefae);
    core.poly([5, -8, 8, -9, 6, 6, 4, 8]).fill(0xffd777);
  }
  core.scale.set(config.width, config.height);
  container.addChild(core);
  const particleLayer = new Container({ label: "lamp-particles", eventMode: "none" });
  container.addChild(particleLayer);
  const particles = Array.from({ length: 4 }, () => {
    const sprite = new Graphics({ eventMode: "none", blendMode: "add" });
    sprite.circle(0, 0, 5).fill({ color: 0xffbf51, alpha: 0.08 });
    sprite.rect(-2, -2, 4, 4).fill({ color: 0xffd777, alpha: 0.4 });
    sprite.rect(-1, -1, 2, 2).fill(0xfff3c4);
    sprite.visible = false;
    particleLayer.addChild(sprite);
    return { sprite, age: 0, duration: 0, x: 0, y: 0, drift: 0, phase: 0 };
  });
  let elapsed = index * 1.37, remaining = 0.25 + index * 0.23;
  core.alpha = 0.5;
  halo.alpha = 0.85;
  const update = (delta: number) => {
    elapsed += delta;
    const pulse = Math.sin(elapsed * 1.7) + 0.3 * Math.sin(elapsed * 3.13 + 0.8);
    core.alpha = 0.5 + 0.1 * pulse;
    halo.alpha = 0.85 + 0.1 * pulse;
    remaining -= delta;
    if (remaining <= 0) {
      const particle = particles.find(item => !item.sprite.visible);
      if (particle) {
        Object.assign(particle, { age: 0, duration: 3.2 + random() * 1.2,
          x: (random() < 0.5 ? -1 : 1) * (9 + random() * 4), y: -3 - random() * 8,
          drift: (random() - 0.5) * 20, phase: random() * Math.PI * 2 });
        particle.sprite.visible = true;
      }
      remaining = 0.85 + random() * 0.55;
    }
    for (const particle of particles) {
      if (!particle.sprite.visible) continue;
      particle.age += delta;
      const progress = particle.age / particle.duration;
      if (progress >= 1) { particle.sprite.visible = false; continue; }
      particle.sprite.position.set(particle.x + particle.drift * progress
        + 3 * (Math.sin(progress * Math.PI * 2 + particle.phase) - Math.sin(particle.phase)),
      particle.y - 40 * progress);
      particle.sprite.alpha = Math.min(1, progress / 0.12, (1 - progress) / 0.3);
    }
  };
  return { container, update, reset() {
    core.alpha = 0.5;
    halo.alpha = 0.85;
    particles.forEach(item => { item.sprite.visible = false; });
    remaining = 0.25 + index * 0.23;
  } };
}

/** One ticker and lifecycle for courtyard lights; containers retain world depth sorting. */
export function createCourtyardLampRuntime(ticker: Ticker, random: () => number = Math.random) {
  const lamps = COURTYARD_LAMPS.map((config, index) => createLamp(config, index, random));
  let destroyed = false, attached = false;
  const update = (clock: Ticker) => {
    const delta = Math.max(0, Math.min(clock.deltaMS, 100)) / 1000;
    lamps.forEach(lamp => lamp.update(delta));
  };
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  const sync = () => {
    const active = !destroyed && !media.matches && !document.hidden;
    if (active && !attached) { ticker.add(update); attached = true; }
    if (!active && attached) { ticker.remove(update); attached = false; }
    if (media.matches) {
      lamps.forEach(lamp => lamp.reset());
    }
  };
  media.addEventListener("change", sync);
  document.addEventListener("visibilitychange", sync);
  sync();
  return { containers: lamps.map(lamp => lamp.container), destroy() {
    if (destroyed) return;
    destroyed = true;
    if (attached) ticker.remove(update);
    attached = false;
    media.removeEventListener("change", sync);
    document.removeEventListener("visibilitychange", sync);
    lamps.forEach(lamp => lamp.container.destroy({ children: true }));
  } };
}
