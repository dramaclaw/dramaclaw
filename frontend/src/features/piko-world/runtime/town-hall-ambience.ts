// SPDX-License-Identifier: Elastic-2.0
import { createLamp } from "./courtyard-lamp";
import { Container, Graphics, Rectangle, Sprite, Texture, type Ticker } from "pixi.js";

const FIRE_SEQUENCE = [0, 1, 2, 3, 2, 1] as const;

/** The clean plate is clipped to the hearth; the approved v2 room stays unchanged. */
export function createTownHallAmbience(ticker: Ticker, clean: Texture, atlas: Texture) {
  const container = new Container({ label: "town-hall-ambience", eventMode: "none", zIndex: -0.5 });
  clean.source.scaleMode = atlas.source.scaleMode = "linear";
  const hearth = new Container({ eventMode: "none" });
  const plate = new Sprite({ texture: clean, eventMode: "none" });
  plate.width = 2048; plate.height = 1152;
  const mask = new Graphics({ eventMode: "none" });
  mask.poly([1855, 450, 1890, 458, 1918, 489, 1918, 596, 1855, 555]).fill(0xffffff);
  hearth.addChild(plate, mask); plate.mask = mask;
  const frames = Array.from({ length: 4 }, (_, i) => new Texture({ source: atlas.source,
    frame: new Rectangle(i * atlas.width / 4, 0, atlas.width / 4, atlas.height) }));
  const fire = new Sprite({ texture: frames[0], label: "hearth-fire", eventMode: "none" });
  fire.anchor.set(0.5, 0.68); fire.position.set(1890, 548);
  fire.width = 68; fire.height = 90;
  hearth.addChild(fire); fire.mask = mask;
  container.addChild(hearth);

  const lamps = [[245, 168], [1795, 177], [1390, 263], [44, 916], [2008, 916]].map(([x, y], index) => {
    const lamp = createLamp({ id: `hall-light-${index}`, x, y, baseY: y,
      width: index === 2 ? 0.7 : 0.85, height: 1, haloScale: 0.75, clipBottom: 44 }, index, Math.random);
    container.addChild(lamp.container);
    return lamp;
  });
  const hearthLights = [[1890, 533, 70, 65]];
  const lights = hearthLights.map(([x, y, w, h]) => {
    const light = new Graphics({ eventMode: "none", blendMode: "add" });
    for (let ring = 6; ring > 0; ring--) light.ellipse(0, 0, w * ring / 6, h * ring / 6)
      .fill({ color: 0xffc779, alpha: 0.012 });
    light.position.set(x, y); container.addChild(light); return light;
  });
  const dust = Array.from({ length: 30 }, (_, i) => {
    const mote = new Graphics({ eventMode: "none", blendMode: "add" });
    mote.circle(0, 0, 3.5).fill({ color: 0xffe6b0, alpha: 0.08 });
    mote.circle(0, 0, i % 3 === 0 ? 1.8 : 1.1).fill(0xfff0c9);
    container.addChild(mote); return mote;
  });
  let elapsed = 0, attached = false, destroyed = false;
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  function render() {
    fire.texture = frames[FIRE_SEQUENCE[Math.floor(elapsed / 0.4) % FIRE_SEQUENCE.length]];
    lights.forEach((light, i) => { light.alpha = 0.65 + 0.035 * Math.sin(elapsed * 0.65 + i); });
    dust.forEach((mote, i) => {
      const t = (elapsed / (15 + i % 5) + i / 30) % 1;
      mote.position.set(535 + (i * 67 % 420) + 18 * Math.sin(t * Math.PI * 2 + i), 380 + (i * 43 % 215) - t * 100);
      mote.alpha = Math.sin(t * Math.PI) * 0.58;
      mote.visible = !motion.matches;
    });
  }
  const tick = (clock: Ticker) => {
    const delta = Math.min(100, Math.max(0, clock.deltaMS)) / 1000;
    elapsed += delta; lamps.forEach(lamp => lamp.update(delta)); render();
  };
  const sync = () => {
    const active = !destroyed && !document.hidden && document.hasFocus() && !motion.matches;
    if (active && !attached) { ticker.add(tick); attached = true; }
    if (!active && attached) { ticker.remove(tick); attached = false; }
    if (motion.matches) { elapsed = 0; lamps.forEach(lamp => lamp.reset()); render(); }
  };
  render();
  motion.addEventListener("change", sync);
  document.addEventListener("visibilitychange", sync);
  window.addEventListener("focus", sync); window.addEventListener("blur", sync);
  sync();
  return { container, destroy() {
    if (destroyed) return;
    destroyed = true;
    if (attached) ticker.remove(tick);
    motion.removeEventListener("change", sync);
    document.removeEventListener("visibilitychange", sync);
    window.removeEventListener("focus", sync); window.removeEventListener("blur", sync);
    container.destroy({ children: true }); frames.forEach(frame => frame.destroy(false));
  } };
}
