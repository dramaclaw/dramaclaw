// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
import { Application, Assets, Container, Sprite, type Texture } from "pixi.js";
import { useTranslation } from "react-i18next";

import { loadPikoMapManifest, loadPikoMapNavigation, resolvePikoMapAssetUrl } from "./runtime/map-package-loader";
import { containWorldInViewport, type PikoSize } from "./runtime/viewport-fit";
import { PikoMayor } from "./PikoMayor";
import { PIKO_MAYOR_IDLE_SRC, PIKO_MAYOR_POSITION } from "./runtime/mayor-idle";
import { createMayorActor } from "./runtime/mayor-actor";
import { createResidentActor, RESIDENT_MOTION_SRC } from "./runtime/resident-actor";
import { canTalkTo } from "./runtime/character-movement";
import { PikoWelcomeDialog } from "./PikoWelcomeDialog";
import { addCharacterPresentation } from "./runtime/character-presentation";
import { playPikoUiSound } from "./piko-audio";

export type PikoMapLoadState = "loading" | "ready" | "error";

type PikoWorldCanvasProps = {
  mapId: string;
  showMayorHint?: boolean;
  mayorHintVisible?: boolean;
  movementBlocked?: boolean;
  onLoadStateChange?: (loadState: PikoMapLoadState) => void;
};

export function PikoWorldCanvas({ mapId, onLoadStateChange, showMayorHint = false, mayorHintVisible = showMayorHint, movementBlocked = false }: PikoWorldCanvasProps) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const mayorActiveRef = useRef(showMayorHint);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [welcomed, setWelcomed] = useState(false);
  const [tooFar, setTooFar] = useState(false);
  const blockedRef = useRef(movementBlocked);
  const welcomeOpenRef = useRef(false);
  const interactRef = useRef<(fromClick?:boolean)=>void>(()=>{});
  const mayorHoverRef = useRef<(hovered:boolean)=>void>(()=>{});
  useEffect(()=>{blockedRef.current=movementBlocked;},[movementBlocked]);
  useEffect(()=>{if(!tooFar)return;const timer=window.setTimeout(()=>setTooFar(false),2500);return()=>window.clearTimeout(timer);},[tooFar]);
  useEffect(() => { mayorActiveRef.current = showMayorHint; }, [showMayorHint]);
  useEffect(() => {
    if (showMayorHint && !blockedRef.current) hostRef.current?.focus({preventScroll:true});
  }, [showMayorHint]);
  const [loadState, setLoadState] = useState<PikoMapLoadState>("loading");
  const [worldFit, setWorldFit] = useState({ x: 0, y: 0, scale: 0 });

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
    let mayorTextureLoaded = false;
    let residentTextureLoaded = false;
    let residentActor: ReturnType<typeof createResidentActor> | null = null;
    let mayorActor: ReturnType<typeof createMayorActor> | null = null;
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
        world.sortableChildren = true;
        world.addChild(new Sprite(texture));
        nextApp.stage.addChild(world);

        if (mapId === "welcome-courtyard") {
          const mayorTexture = await Assets.load<Texture>(PIKO_MAYOR_IDLE_SRC);
          if (disposed) {
            void Assets.unload(PIKO_MAYOR_IDLE_SRC);
            return;
          }
          mayorTextureLoaded = true;
          mayorActor = createMayorActor(mayorTexture, nextApp.ticker, () => mayorActiveRef.current);
          mayorActor.container.zIndex = PIKO_MAYOR_POSITION.y;
          mayorHoverRef.current = addCharacterPresentation(mayorActor.container);
          world.addChild(mayorActor.container);
          const navigation = await loadPikoMapNavigation(mapId,manifest.data.navigation,abortController.signal);
          if(disposed)return;
          const residentTexture = await Assets.load<Texture>(RESIDENT_MOTION_SRC);
          if (disposed) { void Assets.unload(RESIDENT_MOTION_SRC); return; }
          residentTextureLoaded = true;
          interactRef.current = (fromClick = false) => {
            if(!residentActor || !mayorActiveRef.current || blockedRef.current || welcomeOpenRef.current)return;
            residentActor.stop();
            if(!fromClick && !canTalkTo(residentActor.container.position,PIKO_MAYOR_POSITION,navigation)){setTooFar(true);return;}
            playPikoUiSound("open");
            setTooFar(false); welcomeOpenRef.current=true; setWelcomeOpen(true);
          };
          residentActor = createResidentActor(residentTexture, nextApp.ticker,
            () => mayorActiveRef.current && !blockedRef.current && !welcomeOpenRef.current,
            {host,navigation,onInteract:()=>interactRef.current()});
          residentActor.container.zIndex = residentActor.container.y;
          addCharacterPresentation(residentActor.container, "居民 · 你");
          world.addChild(residentActor.container);
        }

        const worldSize: PikoSize = manifest.size;
        const fitWorld = () => {
          const viewport = { width: host.clientWidth, height: host.clientHeight };
          const fit = containWorldInViewport(viewport, worldSize);
          world.scale.set(fit.scale);
          world.position.set(fit.x, fit.y);
          setWorldFit(fit);
        };
        const resizeObserver = new ResizeObserver(() => {
          fitWorld();
        });
        resizeObserver.observe(host);
        disconnectResizeObserver = () => {
          resizeObserver.disconnect();
        };
        fitWorld();
        nextApp.render();
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
      mayorActor?.destroy();
      residentActor?.destroy();
      interactRef.current=()=>{};
      mayorHoverRef.current=()=>{};
      if (app) app.destroy(true, { children: true });
      if (mayorTextureLoaded) void Assets.unload(PIKO_MAYOR_IDLE_SRC);
      if (residentTextureLoaded) void Assets.unload(RESIDENT_MOTION_SRC);
      if (baseTextureUrl && baseTextureLoaded) void Assets.unload(baseTextureUrl);
    };
  }, [mapId]);

  return (
    <div className="absolute inset-0 bg-background">
      <div
        ref={hostRef}
        id="piko-map-control"
        tabIndex={0}
        className="absolute inset-0 focus-visible:outline-none"
        role="group"
        aria-label={t("pikoWorld.mapAriaLabel")}
        aria-describedby={showMayorHint && mapId === "welcome-courtyard" ? "piko-movement-help" : undefined}
      />
      {loadState === "ready" && mapId === "welcome-courtyard" && (
        <PikoMayor fit={worldFit} showHint={mayorHintVisible && !welcomed && !welcomeOpen}
          onHover={hovered=>mayorHoverRef.current(hovered)}
          onInteract={showMayorHint && !movementBlocked ? ()=>interactRef.current(true) : undefined} />
      )}
      {showMayorHint && mapId === "welcome-courtyard" && <p id="piko-movement-help" className="pointer-events-none absolute bottom-3 right-3 m-0 max-w-[calc(100%-1.5rem)] rounded-full bg-background/45 px-3 py-1 text-right text-[11px] leading-4 text-foreground/60 backdrop-blur-[4px]">
        <span role="status">{t(tooFar?"pikoWorld.mayorTooFar":"pikoWorld.movementHelp")}</span>
      </p>}
      <PikoWelcomeDialog open={welcomeOpen} onOpenChange={open=>{welcomeOpenRef.current=open;setWelcomeOpen(open);}}
        onComplete={()=>setWelcomed(true)} />
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
