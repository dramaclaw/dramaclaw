// SPDX-License-Identifier: Elastic-2.0
import { Assets, type Texture } from "pixi.js";

type Entry = { users: number; texture: Promise<Texture>; closing?: Promise<void> };
const entries = new Map<string, Entry>();

/** Serialize unload/reload for textures shared by consecutive map instances. */
export async function acquireSharedTexture(url: string) {
  let entry = entries.get(url);
  if (!entry || entry.closing) {
    const previous = entry?.closing;
    entry = { users: 0, texture: Promise.resolve(previous).then(() => Assets.load<Texture>(url)) };
    entries.set(url, entry);
  }
  const owned = entry;
  owned.users++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (--owned.users !== 0) return;
    owned.closing = owned.texture.then(() => Assets.unload(url), () => {}).then(() => {
      if (entries.get(url) === owned) entries.delete(url);
    });
    // A failed renderer cleanup must not leave an unhandled rejection or a poisoned cache entry.
    owned.closing = owned.closing.catch(() => { if (entries.get(url) === owned) entries.delete(url); });
  };
  try { return { texture: await owned.texture, release }; }
  catch (error) { release(); throw error; }
}
