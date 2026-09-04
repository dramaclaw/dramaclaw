// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
import { Application, Assets, Container, Sprite, type Texture } from "pixi.js";
import { useTranslation } from "react-i18next";

import { loadPikoMapManifest, resolvePikoMapAssetUrl } from "./runtime/map-package-loader";
import { containWorldInViewport, type PikoSize } from "./runtime/viewport-fit";

export type PikoMapLoadState = "loading" | "ready" | "error";

type PikoWorldCanvasProps = {
  mapId: string;
  onLoadStateChange?: (loadState: PikoMapLoadState) => void;
};

export function PikoWorldCanvas({ mapId, onLoadStateChange }: PikoWorldCanvasProps) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const [loadState, setLoadState] = useState<PikoMapLoadState>("loading");

  useEffect(() => {
    onLoadStateChange?.(loadState);
  }, [loadState, onLoadStateChange]);

  useEffect(() => {
    const hostElement = hostRef.current;
    if (!hostElement) return;
    const host: HTMLDivElement = hostElement;

    const abortController = new AbortController();
    let app: Application | null = null;
    let baseTextureUrl: string | null = null;
    let baseTextureLoaded = false;
    let disposed = false;
    let disconnectResizeObserver = () => undefined;

    async function mountMap() {
      setLoadState("loading");
      try {
        const manifest = await loadPikoMapManifest(mapId, abortController.signal);
        if (disposed) return;

        const nextApp = new Application();
        await nextApp.init({
          antialias: false,
          autoDensity: true,
          backgroundAlpha: 0,
          preference: "webgl",
          resolution: Math.min(window.devicePixelRatio || 1, 2),
          resizeTo: host,
        });
        if (disposed) {
          nextApp.destroy(true, { children: true });
          return;
        }
        app = nextApp;
        nextApp.canvas.setAttribute("aria-hidden", "true");
        nextApp.canvas.style.display = "block";
        host.appendChild(nextApp.canvas);

        baseTextureUrl = resolvePikoMapAssetUrl(mapId, manifest.baseTexture.src);
        const texture = await Assets.load<Texture>(baseTextureUrl);
        if (disposed) {
          void Assets.unload(baseTextureUrl);
          baseTextureUrl = null;
          return;
        }
        baseTextureLoaded = true;
        texture.source.scaleMode = manifest.baseTexture.sampling;

        const world = new Container();
        world.addChild(new Sprite(texture));
        nextApp.stage.addChild(world);

        const worldSize: PikoSize = manifest.size;
        const fitWorld = () => {
          const viewport = { width: host.clientWidth, height: host.clientHeight };
          const fit = containWorldInViewport(viewport, worldSize);
          world.scale.set(fit.scale);
          world.position.set(fit.x, fit.y);
        };
        const resizeObserver = new ResizeObserver(() => {
          fitWorld();
        });
        resizeObserver.observe(host);
        disconnectResizeObserver = () => {
          resizeObserver.disconnect();
        };
        fitWorld();
        setLoadState("ready");
      } catch (error) {
        if (abortController.signal.aborted) return;
        // eslint-disable-next-line no-console
        console.error("[piko-world] map load failed", error);
        setLoadState("error");
      }
    }

    void mountMap();
    return () => {
      disposed = true;
      abortController.abort();
      disconnectResizeObserver();
      if (app) app.destroy(true, { children: true });
      if (baseTextureUrl && baseTextureLoaded) void Assets.unload(baseTextureUrl);
    };
  }, [mapId]);

  return (
    <div className="absolute inset-0 bg-background">
      <div
        ref={hostRef}
        className="absolute inset-0"
        role="img"
        aria-label={t("pikoWorld.mapAriaLabel")}
      />
      {loadState !== "ready" ? (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/80 text-sm text-muted-foreground"
          role="status"
        >
          {loadState === "loading"
            ? t("pikoWorld.mapLoading")
            : t("pikoWorld.mapLoadError")}
        </div>
      ) : null}
    </div>
  );
}
