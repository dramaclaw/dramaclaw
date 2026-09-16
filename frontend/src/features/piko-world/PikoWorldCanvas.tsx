// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { PIKO_MAP_TRAVEL_TIMING } from "./piko-map-timing";
import { PikoSpeechBubble } from "./PikoSpeechBubble";
import { PikoMapExitMarker } from "./PikoMapExitMarker";
import { MAP_EXIT_MARKERS } from "./piko-map-connections";
import { acquireSharedTexture } from "./runtime/shared-texture";
import { createMapExitMarker } from "./runtime/map-exit-marker";
import type { PikoSpeech } from "./piko-public-chat";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Application, Container, Sprite, type Texture } from "pixi.js";
import { useTranslation } from "react-i18next";

import { loadPikoMapEnvironment, loadPikoMapManifest, loadPikoMapNavigation, loadPikoMapOcclusion, resolvePikoMapAssetUrl } from "./runtime/map-package-loader";
import { createMapOccluder, createBakedActorOcclusion, isBakedOccluder, isResidentHeadOccluded } from "./runtime/map-occlusion";
import { createEnvironmentEffectRuntime } from "./runtime/environment-effect-runtime";
import { createCourtyardFoliageRuntime } from "./runtime/courtyard-foliage-runtime";
import { createCourtyardAerialRuntime } from "./runtime/courtyard-aerial-runtime";
import { createCourtyardLampRuntime } from "./runtime/courtyard-lamp";
import { createCourtyardAnimalRuntime } from "./runtime/courtyard-animal-runtime";
import { createAnimalAudio } from "./runtime/animal-audio";
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
import { PIKO_PLAYER_ART, type PikoPlayerGender } from "./piko-player";
import { PIKO_PLAYABLE_RESIDENTS, type PlayablePikoResidentId } from "./piko-residents";
import { PIKO_SIMULATED_RESIDENT } from "./piko-simulated-resident";
import { playPikoUiSound } from "./piko-audio";

import { canStand } from "./runtime/character-movement";
import { canActivateTransport, createExitGate, enabledMapExits, type MapExit } from "./runtime/map-travel";
import { PIKO_MAP_TRANSITIONS, isPikoMapId } from "./piko-map-transitions";
import type { PikoNavigation } from "./runtime/map-package-schema";
const NavigationEditor = lazy(() => import("./PikoNavigationEditor"));

export type PikoMapLoadState = "loading" | "ready" | "error";

type PikoWorldCanvasProps = {
  mapId: string;
  nickname: string;
  spawnId?: string;
  onExit?: (exit: MapExit) => void;
  speech?: PikoSpeech | null;
  residentId?: PlayablePikoResidentId;
  playerGender?: PikoPlayerGender;
  showMayorHint?: boolean;
  mayorHintVisible?: boolean;
  movementBlocked?: boolean;
  onLoadStateChange?: (loadState: PikoMapLoadState) => void;
};

export function PikoWorldCanvas({ mapId, spawnId, onExit, nickname, speech, residentId = "m01", playerGender, onLoadStateChange, showMayorHint = false, mayorHintVisible = showMayorHint, movementBlocked = false }: PikoWorldCanvasProps) {
  const { t } = useTranslation();
  const exitDefinitions = isPikoMapId(mapId) ? MAP_EXIT_MARKERS[mapId] ?? [] : [];
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const [debugNavigation, setDebugNavigation] = useState<PikoNavigation | null>(null);
  const debugEditingRef = useRef(false);
  const navigationRef = useRef<PikoNavigation | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const mayorActiveRef = useRef(showMayorHint);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const blockedRef = useRef(movementBlocked);
  const socialBusyRef = useRef(false);
  const stopPlayerRef = useRef(() => {});
  const activateTransportRef = useRef<(exitId: string) => void>(() => {});
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
    const sharedTextureReleases: (() => void)[] = [];
    const residentTextures = new Map<PlayablePikoResidentId, Texture>();
    const occluders: ReturnType<typeof createMapOccluder>[] = [];
    const actorOcclusion: ReturnType<typeof createBakedActorOcclusion>[] = [];
    let residentSilhouette: ReturnType<typeof createResidentOcclusionSilhouette> | null = null;
    let clickFeedback: ReturnType<typeof createClickFeedback> | null = null;
    let simulatedActor: ReturnType<typeof createResidentActor> | null = null;
    let residentActor: ReturnType<typeof createResidentActor> | null = null;
    let mayorActor: ReturnType<typeof createMayorActor> | null = null;
    let environmentRuntime: Awaited<ReturnType<typeof createEnvironmentEffectRuntime>> = null;
    let courtyardFoliageRuntime: Awaited<ReturnType<typeof createCourtyardFoliageRuntime>> = null;
    let courtyardAerialRuntime: Awaited<ReturnType<typeof createCourtyardAerialRuntime>> = null;
    let courtyardLamp: ReturnType<typeof createCourtyardLampRuntime> | null = null;
    let courtyardAnimalRuntime: Awaited<ReturnType<typeof createCourtyardAnimalRuntime>> = null;
    let animalAudio: ReturnType<typeof createAnimalAudio> | null = null;
    let environmentAudio: ReturnType<typeof createEnvironmentAudio> | null = null;
    const exitMarkers: NonNullable<Awaited<ReturnType<typeof createMapExitMarker>>>[] = [];
    let disposed = false;
    let disconnectPosition = () => {};
    let disconnectResizeObserver = () => undefined;

    const loadTexture = async (url: string) => {
      const lease = await acquireSharedTexture(url);
      if (disposed) { lease.release(); return null; }
      sharedTextureReleases.push(lease.release);
      return lease.texture;
    };
    const loadDeadline = window.setTimeout(() => {
      disposeMap();
      setLoadState("error");
    }, PIKO_MAP_TRAVEL_TIMING.renderTimeoutMs);

    function disposeMap() {
      if (disposed) return;
      disposed = true;
      window.clearTimeout(loadDeadline);
      navigationRef.current = null;
      debugEditingRef.current = false;
      abortController.abort();
      disconnectResizeObserver();
      disconnectPosition();
      animalAudio?.destroy();
      exitMarkers.forEach(marker => marker.destroy());
      courtyardAnimalRuntime?.destroy();
      courtyardAerialRuntime?.destroy();
      courtyardLamp?.destroy();
      environmentRuntime?.destroy();
      environmentAudio?.destroy();
      courtyardFoliageRuntime?.destroy();
      stopPlayerRef.current = () => {};
      activateTransportRef.current = () => {};
      simulatedHoverRef.current = () => {};
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
      sharedTextureReleases.forEach(release => release());
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
        const texture = await loadTexture(baseTextureUrl);
        if (!texture) return;
        texture.source.scaleMode = manifest.baseTexture.sampling;

        const world = new Container();
        world.sortableChildren = true;
        clickFeedback = createClickFeedback(nextApp.ticker);
        world.addChild(clickFeedback.marker);
        const ground = new Sprite(texture);
        // Artwork resolution can differ from the map's navigation coordinate space.
        ground.width = manifest.size.width;
        ground.height = manifest.size.height;
        ground.eventMode = "static";
        ground.on("pointertap", event => {
          if (event.button !== 0 || event.pointerType !== "mouse") return;
          const target = world.toLocal(event.global);
          if (residentActor?.walkTo(target)) clickFeedback?.show(target);
        });
        ground.zIndex = -Infinity;
        world.addChild(ground);
        nextApp.stage.addChild(world);

        for (const exitDefinition of exitDefinitions) {
          const exitMarker = await createMapExitMarker(nextApp.ticker, exitDefinition,
            () => disposed,
            () => mayorActiveRef.current && !blockedRef.current && !welcomeOpenRef.current);
          if (disposed) return;
          if (exitMarker) {
            exitMarkers.push(exitMarker);
            world.addChild(exitMarker.container);
          }
        }

        const occlusion = await loadPikoMapOcclusion(mapId, manifest.data.occlusion, abortController.signal);
        if (disposed) return;
        if (mapId === "welcome-courtyard") {
          courtyardFoliageRuntime = await createCourtyardFoliageRuntime({
            occlusion,
            baseTexture: texture,
            ticker: nextApp.ticker,
            size: manifest.size,
            resolveAssetUrl: src => resolvePikoMapAssetUrl(mapId, src),
            isDisposed: () => disposed,
          });
          if (!courtyardFoliageRuntime) return;
          courtyardFoliageRuntime.objects.forEach(object => world.addChild(object));
        }
        const animatedTree = courtyardFoliageRuntime?.animatedTree;
        const bakedOccluders = occlusion.occluders.filter(item =>
          !courtyardFoliageRuntime?.bakedActorOcclusionExclusions.has(item)
          && isBakedOccluder(item, manifest.baseTexture.src));
        for (const definition of occlusion.occluders) {
          if (courtyardFoliageRuntime?.occluderRenderExclusions.has(definition)) continue;
          if (isBakedOccluder(definition, manifest.baseTexture.src)) continue;
          const url = resolvePikoMapAssetUrl(mapId, definition.src);
          const source = url === baseTextureUrl ? texture : await loadTexture(url);
          if (!source) return;
          source.source.scaleMode = manifest.baseTexture.sampling;
          const occluder = createMapOccluder(source, definition);
          occluders.push(occluder);
          world.addChild(occluder.container);
        }
        const environment = await loadPikoMapEnvironment(mapId, manifest.data.environment, abortController.signal);
        if (disposed) return;
        environmentAudio = createEnvironmentAudio(environment.audioZones, src => resolvePikoMapAssetUrl(mapId, src));
        environmentRuntime = await createEnvironmentEffectRuntime({
          definitions: environment.effects,
          baseTexture: texture,
          baseTextureSrc: manifest.baseTexture.src,
          ticker: nextApp.ticker,
          resolveAssetUrl: src => resolvePikoMapAssetUrl(mapId, src),
          isDisposed: () => disposed,
        });
        if (!environmentRuntime) return;
        environmentRuntime.objects.forEach(object => world.addChild(object));
        if (mapId === "welcome-courtyard") {
          courtyardAerialRuntime = await createCourtyardAerialRuntime({
            ticker: nextApp.ticker,
            resolveAssetUrl: src => resolvePikoMapAssetUrl(mapId, src),
            isDisposed: () => disposed,
          });
          if (!courtyardAerialRuntime) return;
          courtyardAerialRuntime.objects.forEach(object => world.addChild(object));
          courtyardLamp = createCourtyardLampRuntime(nextApp.ticker);
          world.addChild(...courtyardLamp.containers);
        }
        setPlayerHeadOccluded(false);

        {
          const navigation = await loadPikoMapNavigation(mapId, manifest.data.navigation, abortController.signal);
          if (disposed) return;
          const spawn = spawnId ? navigation.spawnPoints.find(point => point.id === spawnId)
            : mapId === "welcome-courtyard" ? undefined : navigation.spawnPoints[0];
          if (spawnId && (!spawn || !canStand(spawn.position, navigation))) throw new Error("Invalid map arrival");
          navigationRef.current = navigation;
          setDebugNavigation(structuredClone(navigation));
          const checkExit = createExitGate(enabledMapExits(navigation));
          if (mapId === "welcome-courtyard") {
            const mayorTexture = await loadTexture(PIKO_MAYOR_IDLE_SRC);
            if (!mayorTexture) return;
            mayorActor = createMayorActor(mayorTexture, nextApp.ticker, () => mayorActiveRef.current);
            mayorActor.container.zIndex = PIKO_MAYOR_POSITION.y;
            mayorHoverRef.current = addCharacterPresentation(mayorActor.container);
            world.addChild(mayorActor.container);
            courtyardAnimalRuntime = await createCourtyardAnimalRuntime({
              ticker: nextApp.ticker, navigation, bakedOccluders, size: manifest.size,
              resolveAssetUrl: src => resolvePikoMapAssetUrl(mapId, src),
              isDisposed: () => disposed,
            });
            if (!courtyardAnimalRuntime) return;
            courtyardAnimalRuntime.objects.forEach(object => world.addChild(object));
            animalAudio = createAnimalAudio(() => courtyardAnimalRuntime?.actors.map(actor => ({
              id: actor.placement.id, kind: actor.placement.kind, ...actor.motion.state,
            })) ?? [], src => resolvePikoMapAssetUrl(mapId, src));
          }
          for (const id of Object.keys(PIKO_PLAYABLE_RESIDENTS) as PlayablePikoResidentId[]) {
            const src = PIKO_PLAYABLE_RESIDENTS[id];
            const residentTexture = await loadTexture(src);
            if (!residentTexture) return;
            residentTextures.set(id, residentTexture);
          }
          interactRef.current = () => {
            if(!residentActor || !mayorActiveRef.current || blockedRef.current || welcomeOpenRef.current)return;
            residentActor.stop();
            playPikoUiSound("open");
            welcomeOpenRef.current=true; setWelcomeOpen(true);
          };
          const portraitSpec = playerGender ? PIKO_PLAYER_ART[playerGender] : null;
          const portraitTexture = portraitSpec ? await loadTexture(portraitSpec.src) : null;
          if (portraitSpec && !portraitTexture) return;
          residentActor = createResidentActor(residentTextures.get(residentIdRef.current)!, nextApp.ticker,
            () => mayorActiveRef.current && !blockedRef.current && !welcomeOpenRef.current && !socialBusyRef.current && !debugEditingRef.current,
            {host, navigation, position: spawn?.position, facing: spawn?.facing, footsteps: mapId !== "boundless-sea" && mapId !== "changfeng-sea",
              portrait: portraitSpec && portraitTexture ? { texture: portraitTexture, ...portraitSpec } : undefined});
          activateTransportRef.current = exitId => {
            const definition = exitDefinitions.find(marker => marker.exitId === exitId);
            if (!residentActor || disposed || !definition || !canActivateTransport(definition, residentActor.container,
              mayorActiveRef.current && !blockedRef.current && !welcomeOpenRef.current
              && !socialBusyRef.current && !debugEditingRef.current)) return;
            const exit = enabledMapExits(navigation).find(candidate => candidate.id === exitId);
            if (!exit) return;
            residentActor.stop();
            onExitRef.current?.(exit);
          };
          stopPlayerRef.current = () => residentActor?.stop();
          residentActor.container.zIndex = residentActor.container.y;
          residentPresentationRef.current = addCharacterPresentation(residentActor.container, nicknameRef.current, false);
          world.addChild(residentActor.container);
          changeResidentRef.current = id => {
            residentActor?.stop();
            residentActor?.setSheet(residentTextures.get(id)!);
          };
          if (mapId === "welcome-courtyard") {
            simulatedActor = createResidentActor(residentTextures.get(PIKO_SIMULATED_RESIDENT.residentId)!, nextApp.ticker,
              () => mayorActiveRef.current && !blockedRef.current && !welcomeOpenRef.current && !socialBusyRef.current && !debugEditingRef.current,
              { host, navigation, label: PIKO_SIMULATED_RESIDENT.id,
                position: PIKO_SIMULATED_RESIDENT.position, simulatedInput: () => ({ x: 0, y: 0 }) });
            simulatedHoverRef.current = addCharacterPresentation(simulatedActor.container, PIKO_SIMULATED_RESIDENT.nickname);
            world.addChild(simulatedActor.container);
          }
          let lastX = simulatedActor?.container.x ?? 0, lastY = simulatedActor?.container.y ?? 0;
          setSimulatedPosition({ x: lastX, y: lastY });
          let playerX = residentActor.container.x, playerY = residentActor.container.y;
          setPlayerPosition({ x: playerX, y: playerY });
          environmentAudio?.update({ x: playerX, y: playerY });
          animalAudio?.update({ x: playerX, y: playerY });
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
              animalAudio?.update({ x: playerX, y: playerY });
            }
            if (playerMoved || lastTreeOutline !== animatedTree?.outline) {
              lastTreeOutline = animatedTree?.outline;
              setPlayerHeadOccluded(isResidentHeadOccluded(
                { x: playerX, y: playerY }, occlusion, RESIDENT_WORLD_SCALE,
              ));
            }
            const exit = checkExit({ x: playerX, y: playerY }, mayorActiveRef.current
              && !blockedRef.current && !welcomeOpenRef.current && !socialBusyRef.current && !debugEditingRef.current);
            if (exit) {
              residentActor?.stop();
              onExitRef.current?.(exit);
            }
            if (!simulatedActor) return;
            const { x, y } = simulatedActor.container;
            if (x === lastX && y === lastY) return;
            lastX = x; lastY = y;
            setSimulatedPosition({ x, y });
          };
          nextApp.ticker.add(syncPosition);
          disconnectPosition = () => nextApp.ticker.remove(syncPosition);
          for (const actor of [mayorActor, residentActor, simulatedActor]) {
            if (!actor) continue;
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
        window.clearTimeout(loadDeadline);
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
  }, [playerGender, mapId, spawnId]);

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
      {loadState === "ready" && showMayorHint && !movementBlocked && !welcomeOpen && (
        exitDefinitions.map(definition => <PikoMapExitMarker key={definition.exitId} definition={definition} fit={worldFit} player={playerPosition}
          onActivate={definition.action ? () => activateTransportRef.current(definition.exitId) : undefined} />)
      )}
      {loadState === "ready" && mapId === "welcome-courtyard" && (
        <PikoMayor fit={worldFit} showName={mayorHintVisible && !welcomeOpen}
          onHover={hovered=>mayorHoverRef.current(hovered)}
          onInteract={showMayorHint && !movementBlocked ? ()=>interactRef.current() : undefined} />
      )}
      {loadState === "ready" && mapId === "welcome-courtyard" && showMayorHint && !movementBlocked && !welcomeOpen && (
        <PikoResidentInteraction key={PIKO_SIMULATED_RESIDENT.id} target={PIKO_SIMULATED_RESIDENT}
          position={simulatedPosition} fit={worldFit} onBusyChange={onSocialBusyChange} onHover={onSimulatedHover} />
      )}
      {loadState === "ready" && showMayorHint && speech && !playerHeadOccluded && <PikoSpeechBubble body={speech.body} position={playerPosition} fit={worldFit} />}
      <PikoWelcomeDialog open={welcomeOpen} onOpenChange={open=>{welcomeOpenRef.current=open;setWelcomeOpen(open);}} />
      {import.meta.env.DEV && loadState === "ready" && showMayorHint && debugNavigation && worldFit.scale > 0 && !movementBlocked && (
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
            ? t("pikoWorld.mapLoading", { mapName: isPikoMapId(mapId) ? PIKO_MAP_TRANSITIONS[mapId].title : mapId })
            : t("pikoWorld.mapLoadError", { mapName: isPikoMapId(mapId) ? PIKO_MAP_TRANSITIONS[mapId].title : mapId })}
        </div>
      ) : null}
    </div>
  );
}
