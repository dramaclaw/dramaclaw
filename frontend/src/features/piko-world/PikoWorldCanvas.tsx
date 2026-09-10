// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { PikoSpeechBubble } from "./PikoSpeechBubble";
import type { PikoSpeech } from "./piko-public-chat";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Application, Assets, Container, Sprite, type Texture } from "pixi.js";
import { useTranslation } from "react-i18next";

import { loadPikoMapEnvironment, loadPikoMapManifest, loadPikoMapNavigation, loadPikoMapOcclusion, resolvePikoMapAssetUrl } from "./runtime/map-package-loader";
import { createMapOccluder, createBakedActorOcclusion, isBakedOccluder, isResidentHeadOccluded } from "./runtime/map-occlusion";
import { createEnvironmentSprite } from "./runtime/environment-sprite";
import { createTreeCanopyBreeze } from "./runtime/tree-canopy-breeze";
import { createEnvironmentAudio } from "./runtime/environment-audio";
import { createResidentOcclusionSilhouette } from "./runtime/resident-occlusion-silhouette";
import { containWorldInViewport, type PikoSize } from "./runtime/viewport-fit";
import { PikoMayor } from "./PikoMayor";
import { PIKO_MAYOR_IDLE_SRC, PIKO_MAYOR_POSITION } from "./runtime/mayor-idle";
import { createMayorActor } from "./runtime/mayor-actor";
import { createResidentActor, RESIDENT_WORLD_SCALE } from "./runtime/resident-actor";
import { PikoResidentInteraction } from "./PikoResidentInteraction";
import { PikoWelcomeDialog } from "./PikoWelcomeDialog";
import { addCharacterPresentation } from "./runtime/character-presentation";
import { PIKO_DEFAULT_CURSOR } from "./piko-cursors";
import { createClickFeedback } from "./runtime/click-feedback";
import { PIKO_PLAYABLE_RESIDENTS, type PlayablePikoResidentId } from "./piko-residents";
import { PIKO_SIMULATED_RESIDENT } from "./piko-simulated-resident";
import { playPikoUiSound } from "./piko-audio";

import type { PikoNavigation } from "./runtime/map-package-schema";
const NavigationEditor = lazy(() => import("./PikoNavigationEditor"));

export type PikoMapLoadState = "loading" | "ready" | "error";

type PikoWorldCanvasProps = {
  mapId: string;
  nickname: string;
  speech?: PikoSpeech | null;
  residentId?: PlayablePikoResidentId;
  showMayorHint?: boolean;
  mayorHintVisible?: boolean;
  movementBlocked?: boolean;
  onLoadStateChange?: (loadState: PikoMapLoadState) => void;
};

export function PikoWorldCanvas({ mapId, nickname, speech, residentId = "m01", onLoadStateChange, showMayorHint = false, mayorHintVisible = showMayorHint, movementBlocked = false }: PikoWorldCanvasProps) {
  const { t } = useTranslation();
  const [debugNavigation, setDebugNavigation] = useState<PikoNavigation | null>(null);
  const debugEditingRef = useRef(false);
  const navigationRef = useRef<PikoNavigation | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const mayorActiveRef = useRef(showMayorHint);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [welcomed, setWelcomed] = useState(false);
  const blockedRef = useRef(movementBlocked);
  const socialBusyRef = useRef(false);
  const stopPlayerRef = useRef(() => {});
  const simulatedHoverRef = useRef<(hovered: boolean) => void>(() => {});
  const [playerPosition, setPlayerPosition] = useState({ x: 1190, y: 485 });
  const [playerHeadOccluded, setPlayerHeadOccluded] = useState(false);
  const [simulatedPosition, setSimulatedPosition] = useState<{ x: number; y: number }>(PIKO_SIMULATED_RESIDENT.position);
  const onSocialBusyChange = useCallback((busy: boolean) => {
    socialBusyRef.current = busy;
    if (busy) stopPlayerRef.current();
  }, []);
  const onSimulatedHover = useCallback((hovered: boolean) => simulatedHoverRef.current(hovered), []);
  const welcomeOpenRef = useRef(false);
  const interactRef = useRef<()=>void>(()=>{});
  const nicknameRef = useRef(nickname);
  const residentIdRef = useRef(residentId);
  const changeResidentRef = useRef<(id: PlayablePikoResidentId) => void>(() => {});
  useEffect(() => {
    residentIdRef.current = residentId;
    changeResidentRef.current(residentId);
  }, [residentId]);
  const residentPresentationRef = useRef<ReturnType<typeof addCharacterPresentation> | null>(null);
  useEffect(() => {
    nicknameRef.current = nickname;
    residentPresentationRef.current?.setName(nickname);
  }, [nickname]);
  const mayorHoverRef = useRef<(hovered:boolean)=>void>(()=>{});
  useEffect(()=>{blockedRef.current=movementBlocked;},[movementBlocked]);
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
    const residentTextures = new Map<PlayablePikoResidentId, Texture>();
    const occlusionTextureUrls = new Set<string>();
    const occluders: ReturnType<typeof createMapOccluder>[] = [];
    const actorOcclusion: ReturnType<typeof createBakedActorOcclusion>[] = [];
    let residentSilhouette: ReturnType<typeof createResidentOcclusionSilhouette> | null = null;
    let clickFeedback: ReturnType<typeof createClickFeedback> | null = null;
    let simulatedActor: ReturnType<typeof createResidentActor> | null = null;
    let residentActor: ReturnType<typeof createResidentActor> | null = null;
    let mayorActor: ReturnType<typeof createMayorActor> | null = null;
    const environmentTextureUrls = new Set<string>();
    const environmentEffects: ReturnType<typeof createEnvironmentSprite>[] = [];
    let treeBreeze: ReturnType<typeof createTreeCanopyBreeze> | null = null;
    let environmentAudio: ReturnType<typeof createEnvironmentAudio> | null = null;
    let disposed = false;
    let disconnectPosition = () => {};
    let disconnectResizeObserver = () => undefined;

    function disposeMap() {
      if (disposed) return;
      disposed = true;
      navigationRef.current = null;
      debugEditingRef.current = false;
      abortController.abort();
      disconnectResizeObserver();
      disconnectPosition();
      environmentAudio?.destroy();
      treeBreeze?.destroy();
      stopPlayerRef.current = () => {};
      simulatedHoverRef.current = () => {};
      environmentEffects.forEach(effect => effect.destroy());
      clickFeedback?.destroy();
      residentSilhouette?.destroy();
      actorOcclusion.forEach(item => item.destroy());
      mayorActor?.destroy();
      residentActor?.destroy();
      simulatedActor?.destroy();
      changeResidentRef.current = () => {};
      residentPresentationRef.current = null;
      interactRef.current=()=>{};
      mayorHoverRef.current=()=>{};
      occluders.forEach(occluder => occluder.destroy());
      if (app) app.destroy(true, { children: true });
      for (const url of environmentTextureUrls) void Assets.unload(url);
      for (const url of occlusionTextureUrls) void Assets.unload(url);
      if (mayorTextureLoaded) void Assets.unload(PIKO_MAYOR_IDLE_SRC);
      for (const id of residentTextures.keys()) void Assets.unload(PIKO_PLAYABLE_RESIDENTS[id]);
      if (baseTextureUrl && baseTextureLoaded) void Assets.unload(baseTextureUrl);
    }

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
        nextApp.renderer.events.cursorStyles.default = PIKO_DEFAULT_CURSOR;
        nextApp.canvas.style.cursor = PIKO_DEFAULT_CURSOR;
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
        clickFeedback = createClickFeedback(nextApp.ticker);
        world.addChild(clickFeedback.marker);
        const ground = new Sprite(texture);
        ground.eventMode = "static";
        ground.on("pointertap", event => {
          if (event.button !== 0 || event.pointerType !== "mouse") return;
          const target = world.toLocal(event.global);
          if (residentActor?.walkTo(target)) clickFeedback?.show(target);
        });
        ground.zIndex = -Infinity;
        world.addChild(ground);
        nextApp.stage.addChild(world);

        const occlusion = await loadPikoMapOcclusion(mapId, manifest.data.occlusion, abortController.signal);
        if (disposed) return;
        const animatedTree = mapId === "welcome-courtyard"
          ? occlusion.occluders.find(item => item.id === "east-canopy-tree") : undefined;
        if (animatedTree) {
          const url = resolvePikoMapAssetUrl(mapId, "effects/east-tree-clean-plate-v1.png");
          const cleanPlate = await Assets.load<Texture>(url);
          if (disposed) { void Assets.unload(url); return; }
          environmentTextureUrls.add(url);
          cleanPlate.source.scaleMode = "nearest";
          const atlasUrl = resolvePikoMapAssetUrl(mapId, "effects/east-tree-canopy-atlas-v2.png");
          const atlas = await Assets.load<Texture>(atlasUrl);
          if (disposed) { void Assets.unload(atlasUrl); return; }
          environmentTextureUrls.add(atlasUrl);
          atlas.source.scaleMode = "nearest";
          treeBreeze = createTreeCanopyBreeze(texture, cleanPlate, atlas, animatedTree, nextApp.ticker, manifest.size);
          world.addChild(treeBreeze.background, treeBreeze.container);
        }
        const bakedOccluders = occlusion.occluders.filter(item => item !== animatedTree
          && isBakedOccluder(item, manifest.baseTexture.src));
        for (const definition of occlusion.occluders) {
          if (isBakedOccluder(definition, manifest.baseTexture.src)) continue;
          const url = resolvePikoMapAssetUrl(mapId, definition.src);
          const source = url === baseTextureUrl ? texture : await Assets.load<Texture>(url);
          if (disposed) {
            if (url !== baseTextureUrl) void Assets.unload(url);
            return;
          }
          if (url !== baseTextureUrl) occlusionTextureUrls.add(url);
          source.source.scaleMode = manifest.baseTexture.sampling;
          const occluder = createMapOccluder(source, definition);
          occluders.push(occluder);
          world.addChild(occluder.container);
        }
        const environment = await loadPikoMapEnvironment(mapId, manifest.data.environment, abortController.signal);
        if (disposed) return;
        environmentAudio = createEnvironmentAudio(environment.audioZones, src => resolvePikoMapAssetUrl(mapId, src));
        for (const definition of environment.effects) {
          if (definition.kind !== "sprite" || !definition.region || !definition.src) continue;
          // Static foreground reuses original map pixels above water, below residents.
          if (!definition.animation && definition.src === manifest.baseTexture.src) {
            const points = definition.region.points;
            const x = Math.min(...points.map(point => point.x));
            const y = Math.min(...points.map(point => point.y));
            const foreground = createMapOccluder(texture, {
              id: definition.id, src: definition.src, position: { x, y }, depthY: -0.5,
              frame: { x, y, width: Math.max(...points.map(point => point.x)) - x,
                height: Math.max(...points.map(point => point.y)) - y },
              outline: points.map(point => ({ x: point.x - x, y: point.y - y })),
            });
            occluders.push(foreground);
            world.addChild(foreground.container);
            continue;
          }
          if (!definition.animation) continue;
          const url = resolvePikoMapAssetUrl(mapId, definition.src);
          const atlas = await Assets.load<Texture>(url);
          if (disposed) { void Assets.unload(url); return; }
          environmentTextureUrls.add(url);
          atlas.source.scaleMode = "nearest";
          const effect = createEnvironmentSprite(atlas, definition.region.points, definition.animation, nextApp.ticker);
          effect.container.zIndex = definition.layer === "front-scenery" ? -0.25
            : definition.layer === "behind-scenery" ? -0.75 : -1;
          environmentEffects.push(effect);
          world.addChild(effect.container, effect.mask);
        }
        setPlayerHeadOccluded(false);

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
          navigationRef.current = navigation;
          setDebugNavigation(structuredClone(navigation));
          for (const id of Object.keys(PIKO_PLAYABLE_RESIDENTS) as PlayablePikoResidentId[]) {
            const src = PIKO_PLAYABLE_RESIDENTS[id];
            const residentTexture = await Assets.load<Texture>(src);
            if (disposed) { void Assets.unload(src); return; }
            residentTextures.set(id, residentTexture);
          }
          interactRef.current = () => {
            if(!residentActor || !mayorActiveRef.current || blockedRef.current || welcomeOpenRef.current)return;
            residentActor.stop();
            playPikoUiSound("open");
            welcomeOpenRef.current=true; setWelcomeOpen(true);
          };
          residentActor = createResidentActor(residentTextures.get(residentIdRef.current)!, nextApp.ticker,
            () => mayorActiveRef.current && !blockedRef.current && !welcomeOpenRef.current && !socialBusyRef.current && !debugEditingRef.current,
            {host,navigation});
          stopPlayerRef.current = () => residentActor?.stop();
          residentActor.container.zIndex = residentActor.container.y;
          residentPresentationRef.current = addCharacterPresentation(residentActor.container, nicknameRef.current, false);
          world.addChild(residentActor.container);
          changeResidentRef.current = id => {
            residentActor?.stop();
            residentActor?.setSheet(residentTextures.get(id)!);
          };
          simulatedActor = createResidentActor(residentTextures.get(PIKO_SIMULATED_RESIDENT.residentId)!, nextApp.ticker,
            () => mayorActiveRef.current && !blockedRef.current && !welcomeOpenRef.current && !socialBusyRef.current && !debugEditingRef.current,
            { host, navigation, label: PIKO_SIMULATED_RESIDENT.id,
              position: PIKO_SIMULATED_RESIDENT.position, simulatedInput: () => ({ x: 0, y: 0 }) });
          simulatedHoverRef.current = addCharacterPresentation(simulatedActor.container, PIKO_SIMULATED_RESIDENT.nickname);
          let lastX = simulatedActor.container.x, lastY = simulatedActor.container.y;
          setSimulatedPosition({ x: lastX, y: lastY });
          let playerX = residentActor.container.x, playerY = residentActor.container.y;
          setPlayerPosition({ x: playerX, y: playerY });
          environmentAudio?.update({ x: playerX, y: playerY });
          setPlayerHeadOccluded(isResidentHeadOccluded(
            { x: playerX, y: playerY }, occlusion, RESIDENT_WORLD_SCALE,
          ));
          let lastTreeOutline = animatedTree?.outline;
          const syncPosition = () => {
            actorOcclusion.forEach(item => item.update());
            residentSilhouette?.update();
            const playerMoved = residentActor && (residentActor.container.x !== playerX || residentActor.container.y !== playerY);
            if (residentActor && playerMoved) {
              playerX = residentActor.container.x; playerY = residentActor.container.y;
              setPlayerPosition({ x: playerX, y: playerY });
              environmentAudio?.update({ x: playerX, y: playerY });
            }
            if (playerMoved || lastTreeOutline !== animatedTree?.outline) {
              lastTreeOutline = animatedTree?.outline;
              setPlayerHeadOccluded(isResidentHeadOccluded(
                { x: playerX, y: playerY }, occlusion, RESIDENT_WORLD_SCALE,
              ));
            }
            if (!simulatedActor) return;
            const { x, y } = simulatedActor.container;
            if (x === lastX && y === lastY) return;
            lastX = x; lastY = y;
            setSimulatedPosition({ x, y });
          };
          nextApp.ticker.add(syncPosition);
          disconnectPosition = () => nextApp.ticker.remove(syncPosition);
          world.addChild(simulatedActor.container);
          for (const actor of [mayorActor, residentActor, simulatedActor]) {
            const masked = createBakedActorOcclusion(actor.container, bakedOccluders, manifest.size);
            actorOcclusion.push(masked);
            world.addChild(masked.mask);
          }
          residentSilhouette = createResidentOcclusionSilhouette(residentActor.container, residentActor.body, occlusion.occluders,
            animatedTree ? new Set([animatedTree.id]) : undefined);
          world.addChild(residentSilhouette.container, residentSilhouette.mask);
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
        disposeMap();
        setLoadState("error");
      }
    }

    void mountMap();
    return disposeMap;
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
      />
      {loadState === "ready" && mapId === "welcome-courtyard" && (
        <PikoMayor fit={worldFit} showHint={mayorHintVisible && !welcomed && !welcomeOpen}
          onHover={hovered=>mayorHoverRef.current(hovered)}
          onInteract={showMayorHint && !movementBlocked ? ()=>interactRef.current() : undefined} />
      )}
      {loadState === "ready" && mapId === "welcome-courtyard" && showMayorHint && !movementBlocked && !welcomeOpen && (
        <PikoResidentInteraction key={PIKO_SIMULATED_RESIDENT.id} target={PIKO_SIMULATED_RESIDENT}
          position={simulatedPosition} fit={worldFit} onBusyChange={onSocialBusyChange} onHover={onSimulatedHover} />
      )}
      {loadState === "ready" && showMayorHint && speech && !playerHeadOccluded && <PikoSpeechBubble body={speech.body} position={playerPosition} fit={worldFit} />}
      <PikoWelcomeDialog open={welcomeOpen} onOpenChange={open=>{welcomeOpenRef.current=open;setWelcomeOpen(open);}}
        onComplete={()=>setWelcomed(true)} />
      {import.meta.env.DEV && loadState === "ready" && mapId === "welcome-courtyard" && showMayorHint && debugNavigation && worldFit.scale > 0 && !movementBlocked && (
        <Suspense fallback={null}><NavigationEditor key={mapId} navigation={debugNavigation} fit={worldFit} player={playerPosition}
          onEditing={editing => { debugEditingRef.current = editing; if(editing) stopPlayerRef.current(); }}
          onApply={next => { if(navigationRef.current) Object.assign(navigationRef.current, next); }}
          onPlay={() => hostRef.current?.focus({preventScroll:true})} /></Suspense>
      )}
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
