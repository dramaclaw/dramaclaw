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
  if (sheet.width !== columns * profile.frameSize || sheet.height !== Math.ceil(profile.frameCount / columns) * profile.frameSize) {
    throw new Error("Invalid character idle sheet dimensions");
  }
  sheet.source.scaleMode = "nearest";
  const shadowTexture = createContactShadow(profile.shadow);
  let frames = Array.from({ length: profile.frameCount }, (_, index) => new Texture({
    source: sheet.source,
    frame: new Rectangle((index % columns) * profile.frameSize, Math.floor(index / columns) * profile.frameSize, profile.frameSize, profile.frameSize),
  }));
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
      if (nextSheet.width !== columns * profile.frameSize || nextSheet.height !== Math.ceil(profile.frameCount / columns) * profile.frameSize) {
        throw new Error("Invalid character motion sheet dimensions");
      }
      nextSheet.source.scaleMode = "nearest";
      const previous = frames;
      frames = Array.from({ length: profile.frameCount }, (_, index) => new Texture({
        source: nextSheet.source,
        frame: new Rectangle((index % columns) * profile.frameSize, Math.floor(index / columns) * profile.frameSize, profile.frameSize, profile.frameSize),
      }));
      body.texture = staticTexture ?? frames[frame];
      previous.forEach(texture => texture.destroy(false));
    },
    setStaticTexture(texture: Texture | null, pivot?: { x: number; y: number }) {
      staticTexture = texture;
      if (texture) {
        texture.source.scaleMode = "nearest";
        body.anchor.set((pivot?.x ?? profile.pivot.x) / texture.width, (pivot?.y ?? profile.pivot.y) / texture.height);
      } else body.anchor.set(profile.pivot.x / profile.frameSize, profile.pivot.y / profile.frameSize);
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
      shadowTexture.destroy(true);
    },
  };
}
