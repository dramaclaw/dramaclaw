// SPDX-License-Identifier: Elastic-2.0
export const PIKO_LOADING_MIN_MS = 3_500;
export const PIKO_LOADING_TIMEOUT_MS = 30_000;
const ROOT = "/piko/world/loading";

export const PIKO_LOADING_SCENES = [
  ["welcome-courtyard", "welcome-courtyard-concept-v1.png"],
  ["whispering-meadow", "whispering-meadow-concept-v1.png"],
  ["whalesong-skyport", "whalesong-skyport-concept-v2.png"],
  ["boundless-sea", "boundless-sea-concept-v1.png"],
  ["amber-wilds", "amber-wilds-concept-v1.png"],
  ["startrace-coast", "startrace-coast-concept-v1.png"],
  ["starlight-dock", "starlight-dock-concept-v1.png"],
  ["whispering-forest", "whispering-forest-concept-v1.png"],
  ["mountain-observatory", "mountain-observatory-v1.png"],
  ["amber-expedition", "amber-expedition-v1.png"],
  ["frozen-lake-rest", "frozen-lake-rest-v1.png"],
  ["tidal-discovery", "tidal-discovery-v1.png"],
].map(([id, file]) => ({ id, src: `${ROOT}/backgrounds/${file}` }));
export const PIKO_LOADING_BACKGROUNDS = PIKO_LOADING_SCENES.map((scene) => scene.src);

export const PIKO_LOADING_CONTROLS = {
  frame: `${ROOT}/controls/loading-frame-user-alpha-v1.png`,
  fill: `${ROOT}/controls/loading-fill-alpha-v1.png`,
};

export function loadingDisplayProgress(elapsed: number, ready: boolean): number {
  const fraction = Math.max(0, Math.min(1, elapsed / PIKO_LOADING_MIN_MS));
  if (ready && fraction === 1) return 100;
  // Presentation only, never a claim about downloaded byte counts.
  return Math.min(90, Math.floor(90 * (1 - (1 - fraction) ** 2)));
}

export function preloadLoadingImages(urls: string[], signal: AbortSignal): Promise<void> {
  return Promise.all(urls.map((url) => new Promise<void>((resolve, reject) => {
    const image = new Image();
    const clean = () => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      clean();
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    image.onerror = () => { clean(); reject(new Error(`Image failed: ${url}`)); };
    image.onload = async () => {
      try {
        if (image.decode) await image.decode();
        if (!signal.aborted) { clean(); resolve(); }
      } catch (error) { clean(); reject(error); }
    };
    image.src = url;
  }))).then(() => undefined);
}
