// SPDX-License-Identifier: Elastic-2.0
import { Graphics, Rectangle, Sprite, Texture } from "pixi.js";
import { PLAYER_ACCESSORIES, accessoryPose, type PlayerAccessoryId, type PlayerAccessorySelection } from "../piko-player-accessories";
import { FACINGS, type Facing } from "./character-movement";
import { PIKO_PLAYER_IDLE_CYCLE_MS, type PikoPlayerGender } from "../piko-player";
import headAnchors from "./player-head-anchors.json";

const SPARKLE_CYCLE_MS = PIKO_PLAYER_IDLE_CYCLE_MS;
const SPARKLE_START_MS = 3040;

/** Child of the body: inherits movement, scale and the actor's scenery mask. */
export function createPlayerAccessory(body: Sprite, sources: Map<PlayerAccessoryId, Texture>, selected: () => PlayerAccessorySelection, gender: PikoPlayerGender) {
  const frames = new Map<PlayerAccessoryId, Texture>();
  for (const item of PLAYER_ACCESSORIES) {
    const source = sources.get(item.id);
    if (!source) continue;
    const [x,y,width,height] = item.crop;
    frames.set(item.id, new Texture({ source: source.source, frame: new Rectangle(x,y,width,height) }));
  }
  const sprite = new Sprite({ label: "player-head-accessory", roundPixels: true });
  sprite.anchor.set(0.5, 0);
  sprite.eventMode = "none";
  body.addChild(sprite);
  // A small cluster around the accessory; its original pixels stay unchanged.
  const sparkles = [
    { x: 0.45, y: 0.12, size: 1.1, delay: 0 },
    { x: -0.45, y: 0.28, size: 1, delay: 160 },
    { x: 0.05, y: -0.08, size: 1.2, delay: 320 },
  ].map(spec => {
    const star = new Graphics({ label: "accessory-sparkle" });
    star.rect(-0.5, -0.5, 1, 1).fill(0xffffff)
      .rect(0.5, -0.5, 1, 1).fill(0x58e1ff)
      .rect(-0.5, 0.5, 1, 1).fill(0xffed84)
      .rect(-1.5, -0.5, 1, 1).fill({ color: 0xffffff, alpha: 0.85 })
      .rect(-0.5, -1.5, 1, 1).fill({ color: 0xffffff, alpha: 0.85 });
    star.scale.set(spec.size);
    star.eventMode = "none";
    star.visible = false;
    body.addChild(star);
    return { ...spec, star };
  });
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let lastId: PlayerAccessorySelection | undefined;
  let lastFrame = -1;
  return {
    update(facing: Facing, column: number) {
      const id = selected();
      const frame = FACINGS.indexOf(facing) * 11 + column;
      if (id === lastId && frame === lastFrame) return;
      lastId = id;
      lastFrame = frame;
      const texture = id ? frames.get(id) : null;
      if (!id || !texture) { sprite.visible = false; return; }
      const pose = accessoryPose(id, facing);
      sprite.visible = pose.visible;
      sprite.texture = texture;
      // Crown anchors measured from each atlas frame, relative to foot (32,57).
      const [headX, headY] = headAnchors[gender][frame];
      sprite.position.set(headX + pose.x, headY + pose.y);
      sprite.scale.set((pose.flip ? -1 : 1) * pose.width / texture.width, pose.height / texture.height);
    },
    animate(idleElapsedMs: number | null) {
      for (const { star, x, y, delay } of sparkles) {
        const elapsed = (((idleElapsedMs ?? 0) - SPARKLE_START_MS - delay) % SPARKLE_CYCLE_MS + SPARKLE_CYCLE_MS) % SPARKLE_CYCLE_MS;
        star.visible = idleElapsedMs !== null && lastFrame % 11 === 0 && sprite.visible && !reducedMotion.matches && elapsed < 480;
        if (!star.visible) continue;
        star.alpha = elapsed < 240 ? 1 : 0.65;
        star.position.set(sprite.x + sprite.width * x,
          sprite.y + sprite.height * y - (elapsed < 240 ? 0.5 : 1.5));
      }
    },
    destroy() { sparkles.forEach(({ star }) => star.destroy()); sprite.destroy(); frames.forEach(texture => texture.destroy(false)); },
  };
}
