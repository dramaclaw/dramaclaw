// SPDX-License-Identifier: Elastic-2.0
import { Rectangle, Sprite, Texture } from "pixi.js";
import { PLAYER_ACCESSORIES, accessoryPose, type PlayerAccessoryId, type PlayerAccessorySelection } from "../piko-player-accessories";
import { FACINGS, type Facing } from "./character-movement";
import type { PikoPlayerGender } from "../piko-player";
import headAnchors from "./player-head-anchors.json";

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
    destroy() { sprite.destroy(); frames.forEach(texture => texture.destroy(false)); },
  };
}
