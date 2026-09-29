// SPDX-License-Identifier: Elastic-2.0
import { Container, Rectangle, Sprite, Texture, type Ticker } from "pixi.js";
import { createContactShadow, type CharacterShadowProfile } from "./character-shadow";
import { SEATED_POSE } from "./seated-pose";
export interface CharacterActorProfile {
  label: string;
  frameSize: number;
  frameCount: number;
  columns?: number;
  manual?: boolean;
  pivot: { x: number; y: number };
  position: { x: number; y: number };
  scale: number;
  shadow: CharacterShadowProfile;
  durationMs: number;
  frameAt: (elapsedMs: number) => number;
}

export function createCharacterActor(sheet: Texture, ticker: Ticker, isActive: () => boolean, profile: CharacterActorProfile) {
  const columns = profile.columns ?? profile.frameCount;
  // Keep actor coordinates in logical pixels while sampling the full-size artwork.
  const sliceSheet = (atlas: Texture) => {
    const size = atlas.width / columns;
    const resolution = size / profile.frameSize;
    if (!Number.isInteger(resolution) || resolution < 1 || atlas.height !== Math.ceil(profile.frameCount / columns) * size) {
      throw new Error("Invalid character motion sheet dimensions");
    }
    atlas.source.scaleMode = resolution > 1 ? "linear" : "nearest";
    return Array.from({ length: profile.frameCount }, (_, index) => new Texture({
      source: atlas.source,
      frame: new Rectangle((index % columns) * size, Math.floor(index / columns) * size, size, size),
      orig: new Rectangle(0, 0, profile.frameSize, profile.frameSize),
    }));
  };
  let frames = sliceSheet(sheet);
  const shadowTexture = createContactShadow(profile.shadow);
  const container = new Container({ label: profile.label });
  container.position.set(profile.position.x, profile.position.y);
  const shadow = new Sprite({ texture: shadowTexture, roundPixels: true });
  shadow.anchor.set(0.5, 0.5);
  shadow.scale.set(profile.scale);
  const seatShadow = new Sprite({ texture: shadowTexture, roundPixels: true });
  seatShadow.anchor.set(0.5, 0.5);
  seatShadow.scale.set(0.65, 0.45);
  seatShadow.alpha = 0.9;
  seatShadow.visible = false;
  shadow.addChild(seatShadow);
  const body = new Sprite({ texture: frames[0], roundPixels: true });
  body.anchor.set(profile.pivot.x / profile.frameSize, profile.pivot.y / profile.frameSize);
  body.scale.set(profile.scale);
  container.addChild(shadow, body);

  const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  let elapsed = 0;
  let frame = 0;
  let staticTexture: Texture | null = null;
  const staticFrames = new Map<Texture, Texture>();
  const reset = () => { elapsed = 0; frame = 0; body.texture = staticTexture ?? frames[0]; };
  const tick = (time: Ticker) => {
    if (profile.manual) return;
    if (document.hidden) return;
    if (motion?.matches || !isActive()) { reset(); return; }
    elapsed = (elapsed + time.deltaMS) % profile.durationMs;
    const next = profile.frameAt(elapsed);
    if (next !== frame) { body.texture = frames[next]; frame = next; }
  };
  motion?.addEventListener("change", reset);
  ticker.add(tick);
  return {
    container,
    body,
    shadow,
    setFrame(index: number) {
      if (!Number.isInteger(index) || !frames[index]) throw new Error("Invalid character frame");
      frame = index; body.texture = staticTexture ?? frames[index];
    },
    setSheet(nextSheet: Texture) {
      const nextFrames = sliceSheet(nextSheet);
      const previous = frames;
      frames = nextFrames;
      body.texture = staticTexture ?? frames[frame];
      previous.forEach(texture => texture.destroy(false));
    },
    setStaticTexture(texture: Texture | null, pivot?: { x: number; y: number }) {
      if (texture) {
        const resolution = texture.width / profile.frameSize;
        if (!Number.isInteger(resolution) || resolution < 1 || texture.height !== texture.width) {
          throw new Error("Invalid character static texture dimensions");
        }
        texture.source.scaleMode = resolution > 1 ? "linear" : "nearest";
        let logical = staticFrames.get(texture);
        if (!logical) {
          logical = new Texture({ source: texture.source, frame: texture.frame.clone(),
            orig: new Rectangle(0, 0, profile.frameSize, profile.frameSize) });
          staticFrames.set(texture, logical);
        }
        staticTexture = logical;
        body.anchor.set((pivot?.x ?? profile.pivot.x) / profile.frameSize, (pivot?.y ?? profile.pivot.y) / profile.frameSize);
      } else {
        staticTexture = null;
        body.anchor.set(profile.pivot.x / profile.frameSize, profile.pivot.y / profile.frameSize);
      }
      const sittingScale = profile.scale * SEATED_POSE.scale;
      const footOffset = SEATED_POSE.footY - (pivot?.y ?? profile.pivot.y);
      shadow.scale.set(texture ? sittingScale : profile.scale);
      shadow.y = texture ? footOffset * sittingScale : 0;
      shadow.alpha = 1;
      seatShadow.visible = Boolean(texture);
      seatShadow.y = -footOffset;
      body.texture = staticTexture ?? frames[frame];
    },
    destroy() {
      ticker.remove(tick);
      motion?.removeEventListener("change", reset);
      container.destroy({ children: true });
      frames.forEach(texture => texture.destroy(false));
      staticFrames.forEach(texture => texture.destroy(false));
      staticFrames.clear();
      shadowTexture.destroy(true);
    },
  };
}
