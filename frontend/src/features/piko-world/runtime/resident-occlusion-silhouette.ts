// SPDX-License-Identifier: Elastic-2.0
import { Container, Graphics, GraphicsContext, type Sprite, type Texture } from "pixi.js";
import type { PikoOccluder } from "./map-package-schema";

/** Group opaque pixels into horizontal runs, preserving transparent gaps between limbs. */
export function alphaSilhouetteRuns(pixels: ArrayLike<number>, width: number, height: number) {
  const runs: number[][] = [];
  for (let y = 0; y < height; y++) {
    let start = -1;
    for (let x = 0; x <= width; x++) {
      const opaque = x < width && pixels[(y * width + x) * 4 + 3] >= 128;
      if (opaque && start < 0) start = x;
      if (!opaque && start >= 0) {
        runs.push([start, y, x - start]);
        start = -1;
      }
    }
  }
  return runs;
}

/** Local-player locator, clipped to only the scenery currently covering the body. */
export function createResidentOcclusionSilhouette(actor: Container, body: Sprite, definitions: PikoOccluder[], dynamicIds: ReadonlySet<string> = new Set()) {
  const container = new Container({ label: "local-player-occlusion-silhouette", eventMode: "none", zIndex: Infinity });
  const mask = new Graphics({ label: "local-player-occlusion-silhouette-mask", eventMode: "none" });
  const silhouette = new Graphics();
  const emptyContext = silhouette.context;
  silhouette.alpha = 0.8;
  container.addChild(silhouette);
  container.mask = mask;
  const contexts = new Map<string, GraphicsContext>();
  const canvas = document.createElement("canvas");
  let activeKey = "";
  const toRegion = (item: PikoOccluder, revision = 0) => ({
    key: `${item.id}:${revision}`,
    ...item,
    points: item.outline!.flatMap(point => [point.x + item.position.x, point.y + item.position.y]),
    left: item.position.x + Math.min(...item.outline!.map(point => point.x)),
    right: item.position.x + Math.max(...item.outline!.map(point => point.x)),
    top: item.position.y + Math.min(...item.outline!.map(point => point.y)),
    bottom: item.position.y + Math.max(...item.outline!.map(point => point.y)),
  });
  const regions = definitions.filter(item => item.outline && !dynamicIds.has(item.id)).map(item => toRegion(item));
  const dynamic = definitions.filter(item => item.outline && dynamicIds.has(item.id)).map(item => ({
    definition: item, outline: item.outline, region: toRegion(item), revision: 0,
  }));
  const dynamicRegions = () => dynamic.map(entry => {
    if (entry.outline !== entry.definition.outline) {
      entry.outline = entry.definition.outline;
      entry.region = toRegion(entry.definition, ++entry.revision);
    }
    return entry.region;
  });

  const frameContext = (texture: Texture) => {
    const frame = texture.frame;
    const key = `${texture.source.uid}:${frame.x}:${frame.y}:${frame.width}:${frame.height}`;
    const cached = contexts.get(key);
    if (cached) return cached;
    canvas.width = frame.width;
    canvas.height = frame.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return emptyContext;
    context.drawImage(texture.source.resource as CanvasImageSource,
      frame.x, frame.y, frame.width, frame.height, 0, 0, frame.width, frame.height);
    const pixels = context.getImageData(0, 0, frame.width, frame.height).data;
    const result = new GraphicsContext();
    for (const [x, y, width] of alphaSilhouetteRuns(pixels, frame.width, frame.height)) {
      result.rect(x, y, width, 1);
    }
    result.fill({ color: 0x080c0c });
    contexts.set(key, result);
    return result;
  };

  const update = () => {
    const left = actor.x + body.x - body.anchor.x * body.width;
    const top = actor.y + body.y - body.anchor.y * body.height;
    const active = [...regions, ...dynamicRegions()].filter(item => actor.y < item.depthY && item.right >= left
      && item.left <= left + body.width && item.bottom >= top && item.top <= top + body.height);
    container.visible = actor.visible && active.length > 0;
    if (!container.visible) return;
    container.position.copyFrom(actor.position);
    silhouette.position.copyFrom(body.position);
    silhouette.scale.copyFrom(body.scale);
    silhouette.pivot.set(body.anchor.x * body.texture.orig.width, body.anchor.y * body.texture.orig.height);
    const context = frameContext(body.texture);
    if (silhouette.context !== context) silhouette.context = context;
    const key = active.map(item => item.key).join("|");
    if (key === activeKey) return;
    activeKey = key;
    mask.clear();
    for (const item of active) mask.poly(item.points);
    mask.fill(0xffffff);
  };
  update();
  return { container, mask, update, destroy() {
    container.mask = null;
    container.destroy({ children: true, context: false });
    mask.destroy();
    emptyContext.destroy();
    contexts.forEach(context => context.destroy());
    canvas.width = canvas.height = 0;
  } };
}
