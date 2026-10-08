// SPDX-License-Identifier: Elastic-2.0
import { createLamp } from "./courtyard-lamp";
import { Container, Graphics, Rectangle, Sprite, Texture, type Ticker } from "pixi.js";

const FIRE_SEQUENCE = [0, 1, 2, 3, 2, 1] as const;
const CAT_SEQUENCE = [0, 1, 2, 3, 2, 1] as const;
const DUST_BOUNDS = { left: 515, right: 965, top: 170, bottom: 480 } as const;

/** The clean plate is clipped to the hearth; the approved v2 room stays unchanged. */
export function createTownHallAmbience(ticker: Ticker, clean: Texture, atlas: Texture, catAtlas: Texture,
  random: () => number = Math.random) {
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
  fire.width = 90; fire.height = 118;
  fire.rotation = 16 * Math.PI / 180;
  hearth.addChild(fire); fire.mask = mask;
  container.addChild(hearth);

  catAtlas.source.scaleMode = "linear";
  const catFrameSize = catAtlas.width / 2;
  const catFrames = Array.from({ length: 4 }, (_, i) => new Texture({ source: catAtlas.source,
    frame: new Rectangle(i % 2 * catFrameSize, Math.floor(i / 2) * catFrameSize, catFrameSize, catAtlas.height / 2) }));
  const cat = new Sprite({ texture: catFrames[0], label: "hall-sleeping-cat", eventMode: "none", zIndex: 425 });
  // All four generated frames share the cushion's centre and floor-contact anchor.
  cat.anchor.set(314.5 / 627, 498 / 627);
  cat.position.set(740, 425);
  cat.width = cat.height = 125;

  const lamps = [[245, 168], [1795, 177], [1390, 263], [44, 916], [2008, 916]].map(([x, y], index) => {
    const lamp = createLamp({ id: `hall-light-${index}`, x, y, baseY: y,
      width: index === 2 ? 0.7 : 0.85, height: 1, haloScale: 0.75, clipBottom: 44 }, index, random);
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
  const between = (min: number, max: number) => min + random() * (max - min);
  const dustLayer = new Container({ label: "hall-window-dust", eventMode: "none" });
  container.addChild(dustLayer);
  const dust = Array.from({ length: 60 }, () => {
    const sprite = new Graphics({ eventMode: "none", blendMode: "add" });
    sprite.circle(0, 0, 2.2).fill({ color: 0xffe6b0, alpha: 0.06 });
    sprite.circle(0, 0, between(0.7, 1.1)).fill(0xfff0c9);
    dustLayer.addChild(sprite);
    const lifetime = between(18, 34);
    return { sprite, x: between(DUST_BOUNDS.left, DUST_BOUNDS.right),
      y: between(DUST_BOUNDS.top, DUST_BOUNDS.bottom), age: random() * lifetime, lifetime,
      vx: between(-3.5, 3.5), vy: between(-2.5, 2.5), targetVx: between(-3.5, 3.5), targetVy: between(-2.5, 2.5),
      turnIn: between(2, 6), gain: between(0.25, 0.5) };
  });
  let elapsed = 0, attached = false, destroyed = false;
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  function render() {
    fire.texture = frames[FIRE_SEQUENCE[Math.floor(elapsed / 0.4) % FIRE_SEQUENCE.length]];
    cat.texture = catFrames[CAT_SEQUENCE[Math.floor(elapsed / 0.75) % CAT_SEQUENCE.length]];
    lights.forEach((light, i) => { light.alpha = 0.65 + 0.035 * Math.sin(elapsed * 0.65 + i); });
    dust.forEach(mote => {
      mote.sprite.position.set(mote.x, mote.y);
      const edge = Math.min(1, (mote.x - DUST_BOUNDS.left) / 12, (DUST_BOUNDS.right - mote.x) / 12,
        (mote.y - DUST_BOUNDS.top) / 12, (DUST_BOUNDS.bottom - mote.y) / 12);
      mote.sprite.alpha = Math.sin(mote.age / mote.lifetime * Math.PI) * mote.gain * Math.max(0, edge);
      mote.sprite.visible = !motion.matches;
    });
  }
  const tick = (clock: Ticker) => {
    const delta = Math.min(100, Math.max(0, clock.deltaMS)) / 1000;
    elapsed += delta;
    lamps.forEach(lamp => lamp.update(delta));
    dust.forEach(mote => {
      mote.age += delta;
      mote.turnIn -= delta;
      if (mote.turnIn <= 0) {
        mote.targetVx = between(-3.5, 3.5); mote.targetVy = between(-2.5, 2.5); mote.turnIn = between(2, 6);
      }
      mote.vx += (mote.targetVx - mote.vx) * Math.min(1, delta * 0.8);
      mote.vy += (mote.targetVy - mote.vy) * Math.min(1, delta * 0.8);
      mote.x += mote.vx * delta; mote.y += mote.vy * delta;
      if (mote.age >= mote.lifetime || mote.x < DUST_BOUNDS.left || mote.x > DUST_BOUNDS.right
        || mote.y < DUST_BOUNDS.top || mote.y > DUST_BOUNDS.bottom) {
        mote.x = between(DUST_BOUNDS.left, DUST_BOUNDS.right);
        mote.y = between(DUST_BOUNDS.top, DUST_BOUNDS.bottom); mote.age = 0; mote.lifetime = between(18, 34);
      }
    });
    render();
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
  return { container, cat, destroy() {
    if (destroyed) return;
    destroyed = true;
    if (attached) ticker.remove(tick);
    motion.removeEventListener("change", sync);
    document.removeEventListener("visibilitychange", sync);
    window.removeEventListener("focus", sync); window.removeEventListener("blur", sync);
    container.destroy({ children: true }); cat.destroy();
    [...frames, ...catFrames].forEach(frame => frame.destroy(false));
  } };
}
