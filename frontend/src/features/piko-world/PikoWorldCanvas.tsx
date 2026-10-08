// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createTownHallAmbience } from "./runtime/town-hall-ambience";
import { TOWN_HALL_NOTICES } from "./runtime/town-hall-interactions";
import { mapPerspectiveScale } from "./runtime/map-perspective";
import { PikoTaskLabel } from "./PikoTaskLabel";
import type { PikoOwnTaskStatus } from "./use-piko-task-status";
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

import { loadPikoMapEnvironment, loadPikoMapInteractions, loadPikoMapManifest, loadPikoMapNavigation, loadPikoMapOcclusion, resolvePikoMapAssetUrl } from "./runtime/map-package-loader";
import { createMapOccluder, createBakedActorOcclusion, isBakedOccluder, isResidentHeadOccluded } from "./runtime/map-occlusion";
import { pointInPolygon } from "./runtime/navigation-geometry";
import { pikoSeatAction, type PikoSeatAction } from "./runtime/seat-actions";
import { SEATED_POSE } from "./runtime/seated-pose";
import exitMarkerStyles from "./piko-map-exit-marker.module.css";
import { createMapRiverFish, LANTERN_CANAL_FISH } from "./runtime/map-river-fish";
import { createEnvironmentEffectRuntime } from "./runtime/environment-effect-runtime";
import { createCourtyardFoliageRuntime } from "./runtime/courtyard-foliage-runtime";
import { createMapAerialRuntime, isAerialMap } from "./runtime/map-aerial-runtime";
import { createCourtyardLampRuntime, createLanternCanalLampRuntime } from "./runtime/courtyard-lamp";
import { createCourtyardAnimalRuntime } from "./runtime/courtyard-animal-runtime";
import { localAnimalsForMap } from "./runtime/courtyard-animals";
import { createAnimalAudio } from "./runtime/animal-audio";
import { createEnvironmentAudio } from "./runtime/environment-audio";
import { createResidentOcclusionSilhouette } from "./runtime/resident-occlusion-silhouette";
import { containWorldInViewport, type PikoSize } from "./runtime/viewport-fit";
import { PikoMayor } from "./PikoMayor";
import { PIKO_MAYOR_IDLE_SRC, PIKO_MAYOR_POSITION } from "./runtime/mayor-idle";
import { createMayorActor } from "./runtime/mayor-actor";
import { createResidentActor, RESIDENT_WORLD_SCALE } from "./runtime/resident-actor";
import { PikoTownNpcInteraction } from "./PikoTownNpcInteraction";
import { townNpcsForMap, townNpcIdleSrc } from "./piko-town-npcs";
import { createTownNpcActor } from "./runtime/town-npc-actor";
import { DOG_MAPS } from "./runtime/dog-world-routes";
import { getWorldDog } from "./runtime/dog-world-session";
import { PikoWelcomeDialog } from "./PikoWelcomeDialog";
import { addCharacterPresentation } from "./runtime/character-presentation";
import { PIKO_CHARACTER_CURSOR, PIKO_DEFAULT_CURSOR } from "./piko-cursors";
import { createClickFeedback } from "./runtime/click-feedback";
import { PIKO_PLAYER_MOTION_COLUMNS, PIKO_PLAYER_WALK_COLUMNS, PIKO_FEMALE_PLAYER_MOTION_SRC, PIKO_MALE_PLAYER_MOTION_SRC, PIKO_PLAYER_SEATED_ART, PIKO_PLAYER_GAIT_CYCLE_SOURCE_PIXELS, PIKO_PLAYER_IDLE_CYCLE_MS, PIKO_PLAYER_SPEED, pikoPlayerIdleFrameAt, type PikoPlayerGender } from "./piko-player";
import { PIKO_PLAYABLE_RESIDENTS, type PlayablePikoResidentId } from "./piko-residents";
import { PLAYER_ACCESSORIES, accessoryDefinition, accessorySrc, type PlayerAccessoryId, type PlayerAccessorySelection } from "./piko-player-accessories";
import { createPlayerAccessory } from "./runtime/player-accessory";
import { playPikoUiSound } from "./piko-audio";

import { canStand } from "./runtime/character-movement";
import { canActivateTransport, createExitGate, enabledMapExits, type MapExit } from "./runtime/map-travel";
import { PIKO_MAP_TRANSITIONS, isPikoMapId } from "./piko-map-transitions";
import type { PikoNavigation, PikoOcclusion } from "./runtime/map-package-schema";
const NavigationEditor = lazy(() => import("./PikoNavigationEditor"));

export type PikoMapLoadState = "loading" | "ready" | "error";

type PikoWorldCanvasProps = {
  mapId: string;
  nickname: string;
  spawnId?: string;
  onExit?: (exit: MapExit) => void;
  speech?: PikoSpeech | null;
  taskStatus?: PikoOwnTaskStatus;
  residentId?: PlayablePikoResidentId;
  playerGender?: PikoPlayerGender;
  accessory?: PlayerAccessorySelection;
  showMayorHint?: boolean;
  mayorHintVisible?: boolean;
  movementBlocked?: boolean;
  onLoadStateChange?: (loadState: PikoMapLoadState) => void;
};

export function PikoWorldCanvas({ mapId, spawnId, onExit, nickname, speech, taskStatus, residentId = "m01", playerGender, accessory = null, onLoadStateChange, showMayorHint = false, mayorHintVisible = showMayorHint, movementBlocked = false }: PikoWorldCanvasProps) {
  const { t } = useTranslation();
  const exitDefinitions = isPikoMapId(mapId) ? MAP_EXIT_MARKERS[mapId] ?? [] : [];
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const [debugNavigation, setDebugNavigation] = useState<PikoNavigation | null>(null);
  const [debugOcclusion, setDebugOcclusion] = useState<PikoOcclusion | null>(null);
  const debugEditingRef = useRef(false);
  const navigationRef = useRef<PikoNavigation | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const mayorActiveRef = useRef(showMayorHint);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const blockedRef = useRef(movementBlocked);
  const stopPlayerRef = useRef(() => {});
  const activateTransportRef = useRef<(exitId: string) => void>(() => {});
  const npcHoverRef = useRef(new Map<string, (hovered: boolean) => void>());
  const [playerPosition, setPlayerPosition] = useState({ x: 1190, y: 485 });
  const [dogGreeting, setDogGreeting] = useState<{ mapId: string; x: number; y: number; headOffset: number } | null>(null);
  const [playerSeated, setPlayerSeated] = useState(false);
  const [hallNotice, setHallNotice] = useState<{ body: string; position: { x: number; y: number } } | null>(null);
  const [seatHovered, setSeatHovered] = useState<string | null>(null);
  const [seatHints, setSeatHints] = useState<{ id: string; action: PikoSeatAction }[]>([]);
  const [playerHeadOccluded, setPlayerHeadOccluded] = useState(false);
  const onNpcInteract = useCallback(() => {
    stopPlayerRef.current();
    hostRef.current?.focus({ preventScroll: true });
  }, []);
  const onNpcHover = useCallback((id: string, hovered: boolean) => npcHoverRef.current.get(id)?.(hovered), []);
  const welcomeOpenRef = useRef(false);
  const interactRef = useRef<()=>void>(()=>{});
  const nicknameRef = useRef(nickname);
  const playerNameGap = playerGender ? 6 + Math.max(0, -(accessoryDefinition(accessory)?.y ?? 0)) * RESIDENT_WORLD_SCALE * mapPerspectiveScale(mapId, playerPosition.y) : 4;
  const playerNameGapRef = useRef(playerNameGap);
  playerNameGapRef.current = playerNameGap;
  const accessoryRef = useRef(accessory);
  useEffect(() => { accessoryRef.current = accessory; }, [accessory]);
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
  useEffect(() => { residentPresentationRef.current?.setNameGap(playerNameGap); }, [playerNameGap]);
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
    const npcActors: ReturnType<typeof createTownNpcActor>[] = [];
    let playerAccessory: ReturnType<typeof createPlayerAccessory> | null = null;
    let residentActor: ReturnType<typeof createResidentActor> | null = null;
    let mayorActor: ReturnType<typeof createMayorActor> | null = null;
    let environmentRuntime: Awaited<ReturnType<typeof createEnvironmentEffectRuntime>> = null;
    let courtyardFoliageRuntime: Awaited<ReturnType<typeof createCourtyardFoliageRuntime>> = null;
    let hallAmbience: ReturnType<typeof createTownHallAmbience> | null = null;
    let hallNoticeTimer: ReturnType<typeof setTimeout> | undefined;
    setHallNotice(null);
    let aerialRuntime: Awaited<ReturnType<typeof createMapAerialRuntime>> = null;
    let lampRuntime: ReturnType<typeof createCourtyardLampRuntime> | null = null;
    let courtyardAnimalRuntime: Awaited<ReturnType<typeof createCourtyardAnimalRuntime>> = null;
    let animalAudio: ReturnType<typeof createAnimalAudio> | null = null;
    let worldDog: Awaited<ReturnType<typeof getWorldDog>> | null = null;
    let lastDogGreeting = "";
    let riverFishRuntime: Awaited<ReturnType<typeof createMapRiverFish>> = null;
    let environmentAudio: ReturnType<typeof createEnvironmentAudio> | null = null;
    let interactions: Awaited<ReturnType<typeof loadPikoMapInteractions>> | null = null;
    let playerSitTexture: Texture | null = null;
    let playerSitIdleTexture: Texture | null = null;
    let playerWasSeated = false;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const canInteract = () => mayorActiveRef.current && !blockedRef.current && !welcomeOpenRef.current
      && !debugEditingRef.current;
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
      worldDog?.pauseGreeting();
      setDogGreeting(null);
      animalAudio?.destroy();
      exitMarkers.forEach(marker => marker.destroy());
      courtyardAnimalRuntime?.destroy();
      aerialRuntime?.destroy();
      hallAmbience?.destroy();
      clearTimeout(hallNoticeTimer);
      lampRuntime?.destroy();
      riverFishRuntime?.destroy();
      environmentRuntime?.destroy();
      environmentAudio?.destroy();
      courtyardFoliageRuntime?.destroy();
      stopPlayerRef.current = () => {};
      activateTransportRef.current = () => {};
      npcHoverRef.current.clear();
      clickFeedback?.destroy();
      residentSilhouette?.destroy();
      actorOcclusion.forEach(item => item.destroy());
      mayorActor?.destroy();
      playerAccessory?.destroy();
      residentActor?.destroy();
      npcActors.forEach(actor => actor.destroy());
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
      setPlayerSeated(false);
      setSeatHovered(null);
      setSeatHints([]);
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
          if (!canInteract()) return;
          const target = world.toLocal(event.global);
          const notice = mapId === "town-hall-interior" ? interactions?.interactions.find(item =>
            item.kind === "sign" && pointInPolygon(target, item.trigger.points)) : undefined;
          const noticeAction = notice && TOWN_HALL_NOTICES[notice.actionId];
          if (noticeAction && residentActor) {
            const show = () => {
              if (disposed) return;
              clearTimeout(hallNoticeTimer);
              setHallNotice({ body: noticeAction.message, position: noticeAction.approach });
              hallNoticeTimer = setTimeout(() => setHallNotice(null), 3500);
            };
            if (residentActor.walkTo(noticeAction.approach, show)) clickFeedback?.show(noticeAction.approach);
            return;
          }
          setHallNotice(null);
          const seat = interactions?.interactions.find(item => item.kind === "seat" && pointInPolygon(target, item.trigger.points));
          const seatAction = seat ? pikoSeatAction(seat.actionId) : null;
          if (seatAction && residentActor && playerSitTexture) {
            const sitDown = () => {
              if (!disposed && residentActor && playerSitTexture && residentActor.sit(playerSitTexture, seatAction.approach, playerSitIdleTexture, seatAction.depthY)) {
                residentActor.container.position.set(seatAction.seat.x, seatAction.seat.y);
              }
            };
            const distance = Math.hypot(residentActor.container.x - seatAction.approach.x, residentActor.container.y - seatAction.approach.y);
            if (distance > seatAction.radius) {
              if (residentActor.walkTo(seatAction.approach, sitDown)) clickFeedback?.show(seatAction.approach);
              return;
            }
            sitDown();
            return;
          }
          if (residentActor?.walkTo(target)) clickFeedback?.show(target);
        });
        ground.on("pointermove", event => {
          const target = world.toLocal(event.global);
          const interactive = canInteract() ? interactions?.interactions.find(item =>
            ((item.kind === "seat" && playerSitTexture && pikoSeatAction(item.actionId))
              || (mapId === "town-hall-interior" && item.kind === "sign" && TOWN_HALL_NOTICES[item.actionId]))
            && pointInPolygon(target, item.trigger.points)) : undefined;
          nextApp.canvas.style.cursor = interactive ? PIKO_CHARACTER_CURSOR : PIKO_DEFAULT_CURSOR;
          ground.cursor = interactive ? PIKO_CHARACTER_CURSOR : PIKO_DEFAULT_CURSOR;
          setSeatHovered(interactive?.actionId ?? null);
        });
        ground.on("pointerout", () => { setSeatHovered(null); nextApp.canvas.style.cursor = PIKO_DEFAULT_CURSOR; });
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
        if (mapId === "town-hall-interior") {
          const [clean, fire, cat] = await Promise.all([
            loadTexture(resolvePikoMapAssetUrl(mapId, "effects/firebox-clean.png")),
            loadTexture(resolvePikoMapAssetUrl(mapId, "effects/hearth-fire.png")),
            loadTexture(resolvePikoMapAssetUrl(mapId, "effects/sleeping-cat-v1.png")),
          ]);
          if (!clean || !fire || !cat || disposed) return;
          hallAmbience = createTownHallAmbience(nextApp.ticker, clean, fire, cat);
          world.addChild(hallAmbience.container, hallAmbience.cat);
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
        if (mapId === "welcome-courtyard" || mapId === "lantern-canal-street") {
          riverFishRuntime = await createMapRiverFish({ ticker: nextApp.ticker, surfaces: environmentRuntime.waterSurfaces,
            resolveAssetUrl: src => resolvePikoMapAssetUrl("welcome-courtyard", src), isDisposed: () => disposed,
            placements: mapId === "lantern-canal-street" ? LANTERN_CANAL_FISH : undefined });
          if (disposed) return;
          if (riverFishRuntime) riverFishRuntime.objects.forEach(object => world.addChild(object));
        }
        if (mapId === "welcome-courtyard") {
          lampRuntime = createCourtyardLampRuntime(nextApp.ticker);
          world.addChild(...lampRuntime.containers);
        }
        if (mapId === "lantern-canal-street") {
          lampRuntime = createLanternCanalLampRuntime(nextApp.ticker);
          world.addChild(...lampRuntime.containers);
        }
        if (isAerialMap(mapId)) {
          aerialRuntime = await createMapAerialRuntime({
            mapId,
            ticker: nextApp.ticker,
            // These maps use the same approved artwork and shared texture lease.
            resolveAssetUrl: src => resolvePikoMapAssetUrl("welcome-courtyard", src),
            isDisposed: () => disposed,
          });
          if (!aerialRuntime) return;
          aerialRuntime.objects.forEach(object => world.addChild(object));
        }
        setPlayerHeadOccluded(false);

        {
          const navigation = await loadPikoMapNavigation(mapId, manifest.data.navigation, abortController.signal);
          if (disposed) return;
          interactions = await loadPikoMapInteractions(mapId, manifest.data.interactions, abortController.signal);
          if (disposed) return;
          const spawn = spawnId ? navigation.spawnPoints.find(point => point.id === spawnId)
            : mapId === "welcome-courtyard" ? undefined : navigation.spawnPoints[0];
          if (spawnId && (!spawn || !canStand(spawn.position, navigation))) throw new Error("Invalid map arrival");
          navigationRef.current = navigation;
          setDebugNavigation(structuredClone(navigation));
          setDebugOcclusion(structuredClone(occlusion));
          const checkExit = createExitGate(enabledMapExits(navigation));
          if (mapId === "welcome-courtyard") {
            const mayorTexture = await loadTexture(PIKO_MAYOR_IDLE_SRC);
            if (!mayorTexture) return;
            mayorActor = createMayorActor(mayorTexture, nextApp.ticker, () => mayorActiveRef.current);
            mayorActor.container.zIndex = PIKO_MAYOR_POSITION.y;
            mayorHoverRef.current = addCharacterPresentation(mayorActor.container);
            world.addChild(mayorActor.container);
          }
          const dogMap = (DOG_MAPS as readonly string[]).includes(mapId);
          if (dogMap || localAnimalsForMap(mapId).length > 0) {
            if (dogMap) {
              worldDog = await getWorldDog();
              if (disposed) return;
            }
            courtyardAnimalRuntime = await createCourtyardAnimalRuntime({
              worldDog: worldDog ?? undefined, mapId,
              ticker: nextApp.ticker, navigation, bakedOccluders, size: manifest.size,
              resolveAssetUrl: src => resolvePikoMapAssetUrl("welcome-courtyard", src),
              isDisposed: () => disposed,
            });
            if (!courtyardAnimalRuntime) return;
            courtyardAnimalRuntime.objects.forEach(object => world.addChild(object));
            animalAudio = createAnimalAudio(() => courtyardAnimalRuntime?.actors.map(actor => ({
              id: actor.placement.id, kind: actor.placement.kind, ...actor.motion.state,
              position: actor.container.visible ? actor.motion.state.position : { x: -100000, y: -100000 },
            })) ?? [], src => resolvePikoMapAssetUrl("welcome-courtyard", src));
          }
          const legacyResidentIds = playerGender ? [] : Object.keys(PIKO_PLAYABLE_RESIDENTS) as PlayablePikoResidentId[];
          for (const id of legacyResidentIds) {
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
          const playerMotionSrc = playerGender === "male" ? PIKO_MALE_PLAYER_MOTION_SRC
            : playerGender === "female" ? PIKO_FEMALE_PLAYER_MOTION_SRC : null;
          const playerMotionTexture = playerMotionSrc ? await loadTexture(playerMotionSrc) : null;
          if (playerMotionSrc && !playerMotionTexture) return;
          const seatedArt = playerGender && interactions.interactions.some(item => item.kind === "seat" && pikoSeatAction(item.actionId))
            ? PIKO_PLAYER_SEATED_ART[playerGender] : null;
          if (seatedArt) {
            [playerSitTexture, playerSitIdleTexture] = await Promise.all([loadTexture(seatedArt.base), loadTexture(seatedArt.idle)]);
            if (disposed || !playerSitTexture || !playerSitIdleTexture) return;
            setSeatHints(interactions.interactions.flatMap(item => {
              const action = item.kind === "seat" ? pikoSeatAction(item.actionId) : null;
              return action ? [{ id: item.actionId, action }] : [];
            }));
          }
          residentActor = createResidentActor(playerMotionTexture ?? residentTextures.get(residentIdRef.current)!, nextApp.ticker,
            canInteract,
            {host, navigation, position: spawn?.position, facing: spawn?.facing, footsteps: !["boundless-sea", "changfeng-sea", "town-hall-interior"].includes(mapId),
              onPose: (facing, column, idleElapsedMs) => {
                if (residentActor) {
                  const seated = residentActor.isSeated();
                  const perspectiveScale = mapPerspectiveScale(mapId, residentActor.container.y);
                  const scaleX = RESIDENT_WORLD_SCALE * (seated ? SEATED_POSE.scale : 1) * perspectiveScale;
                  const scaleY = RESIDENT_WORLD_SCALE * (seated ? SEATED_POSE.scale : 1) * perspectiveScale;
                  residentActor.body.scale.x = scaleX;
                  // Also scale the shadow to match perspective
                  residentActor.shadow.scale.set(scaleX);
                  residentActor.shadow.y = seated ? (SEATED_POSE.footY - SEATED_POSE.pivot.y) * scaleY : 0;
                  if (residentActor.body.scale.y !== scaleY) {
                    residentActor.body.scale.y = scaleY;
                    residentPresentationRef.current?.setNameGap(playerNameGapRef.current);
                  }
                  if (seated !== playerWasSeated) {
                    playerWasSeated = seated;
                    setPlayerSeated(seated);
                    residentPresentationRef.current?.setNameGap(playerNameGapRef.current);
                  }
                }
                playerAccessory?.update(facing, column, residentActor?.isSeated());
                playerAccessory?.animate(idleElapsedMs);
              },
              motionColumns: playerGender ? PIKO_PLAYER_MOTION_COLUMNS : undefined,
              walkColumns: playerGender ? PIKO_PLAYER_WALK_COLUMNS : undefined,
              idleFrameAt: playerGender ? pikoPlayerIdleFrameAt : undefined,
              idleCycleMs: playerGender ? PIKO_PLAYER_IDLE_CYCLE_MS : undefined,
              speed: playerGender ? PIKO_PLAYER_SPEED : undefined,
              gaitCycleSourcePixels: playerGender ? PIKO_PLAYER_GAIT_CYCLE_SOURCE_PIXELS : undefined});
          const initialPerspectiveScale = mapPerspectiveScale(mapId, residentActor.container.y);
          residentActor.body.scale.y = RESIDENT_WORLD_SCALE * initialPerspectiveScale;
          residentActor.body.scale.x = RESIDENT_WORLD_SCALE * initialPerspectiveScale;
          residentActor.shadow.scale.set(RESIDENT_WORLD_SCALE * initialPerspectiveScale);
          if (playerGender) {
            const textures = new Map<PlayerAccessoryId, Texture>();
            await Promise.all(PLAYER_ACCESSORIES.map(async item => {
              // Decorative assets must not prevent the map from opening.
              const texture = await loadTexture(accessorySrc(item)).catch(error => {
                if (!disposed) console.warn(`Could not load player accessory: ${item.id}`, error);
                return null;
              });
              if (texture) textures.set(item.id, texture);
            }));
            if (disposed) return;
            playerAccessory = createPlayerAccessory(residentActor.body, textures, () => accessoryRef.current, playerGender);
            playerAccessory.update(spawn?.facing ?? "south", 0);
          }
          activateTransportRef.current = exitId => {
            const definition = exitDefinitions.find(marker => marker.exitId === exitId);
            if (!residentActor || disposed || !definition || !canActivateTransport(definition, residentActor.container,
              mayorActiveRef.current && !blockedRef.current && !welcomeOpenRef.current
              && !debugEditingRef.current)) return;
            const exit = enabledMapExits(navigation).find(candidate => candidate.id === exitId);
            if (!exit) return;
            residentActor.stop();
            onExitRef.current?.(exit);
          };
          stopPlayerRef.current = () => residentActor?.stop();
          residentActor.container.zIndex = residentActor.container.y;
          residentPresentationRef.current = addCharacterPresentation(residentActor.container, nicknameRef.current, false, playerNameGapRef.current);
          world.addChild(residentActor.container);
          changeResidentRef.current = id => {
            if (playerGender) return;
            residentActor?.stop();
            residentActor?.setSheet(residentTextures.get(id)!);
          };
          for (const npc of townNpcsForMap(mapId)) {
            const sheet = await loadTexture(townNpcIdleSrc(npc));
            if (!sheet) return;
            const actor = createTownNpcActor(sheet, nextApp.ticker,
              () => mayorActiveRef.current && !blockedRef.current && !welcomeOpenRef.current && !debugEditingRef.current, npc);
            npcActors.push(actor);
            npcHoverRef.current.set(npc.id, addCharacterPresentation(actor.container, npc.nickname));
            world.addChild(actor.container);
          }
          let playerX = residentActor.container.x, playerY = residentActor.container.y;
          setPlayerPosition({ x: playerX, y: playerY });
          environmentAudio?.update({ x: playerX, y: playerY });
          animalAudio?.update({ x: playerX, y: playerY });
          setPlayerHeadOccluded(isResidentHeadOccluded(
            { x: playerX, y: playerY }, occlusion, RESIDENT_WORLD_SCALE * initialPerspectiveScale,
          ));
          let lastTreeOutline = animatedTree?.outline;
          let lastHeadSeated = false;
          const dogActor = courtyardAnimalRuntime?.actors.find(actor => actor.placement.kind === "dog");
          const syncPosition = () => {
            const now = Date.now();
            const canGreet = canInteract() && !reducedMotion?.matches && !document.hidden && document.hasFocus();
            if (canGreet) worldDog?.greetNearby(mapId, residentActor?.container ?? { x: playerX, y: playerY }, now,
              () => animalAudio?.prepareDogGreeting() ?? false);
            else worldDog?.pauseGreeting();
            const greeting = canGreet && worldDog && worldDog.mapId === mapId && now < worldDog.greetingUntil && dogActor
              ? { mapId, ...worldDog.state.position, headOffset: dogActor.placement.scale * 900 + 8 } : null;
            const greetingKey = greeting ? `${greeting.x}:${greeting.y}` : "";
            if (greetingKey !== lastDogGreeting) { lastDogGreeting = greetingKey; setDogGreeting(greeting); }
            actorOcclusion.forEach(item => item.update());
            residentSilhouette?.update();
            const playerMoved = residentActor && (residentActor.container.x !== playerX || residentActor.container.y !== playerY);
            if (residentActor && playerMoved) {
              playerX = residentActor.container.x; playerY = residentActor.container.y;
              setPlayerPosition({ x: playerX, y: playerY });
              environmentAudio?.update({ x: playerX, y: playerY });
              animalAudio?.update({ x: playerX, y: playerY });
            }
            const headSeated = residentActor?.isSeated() ?? false;
            if (playerMoved || headSeated !== lastHeadSeated || lastTreeOutline !== animatedTree?.outline) {
              lastTreeOutline = animatedTree?.outline;
              lastHeadSeated = headSeated;
              setPlayerHeadOccluded(isResidentHeadOccluded(
                { x: playerX, y: playerY }, occlusion, RESIDENT_WORLD_SCALE * (headSeated ? SEATED_POSE.scale : 1) * mapPerspectiveScale(mapId, playerY),
                { depthY: residentActor?.container.zIndex ?? playerY, headOffset: headSeated ? SEATED_POSE.headOffset : 42 },
              ));
            }
            const exit = checkExit({ x: playerX, y: playerY }, mayorActiveRef.current
              && !blockedRef.current && !welcomeOpenRef.current && !debugEditingRef.current);
            if (exit) {
              residentActor?.stop();
              onExitRef.current?.(exit);
            }
          };
          nextApp.ticker.add(syncPosition);
          disconnectPosition = () => nextApp.ticker.remove(syncPosition);
          for (const actor of [mayorActor, residentActor, ...npcActors]) {
            if (!actor) continue;
            const masked = createBakedActorOcclusion(actor.container, bakedOccluders, manifest.size, () => actor.container.zIndex);
            actorOcclusion.push(masked);
            world.addChild(masked.mask);
          }
          residentSilhouette = createResidentOcclusionSilhouette(residentActor.container, residentActor.body, occlusion.occluders,
            animatedTree ? new Set([animatedTree.id]) : undefined, () => residentActor!.container.zIndex);
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
      {loadState === "ready" && showMayorHint && !movementBlocked && !welcomeOpen && !playerSeated && worldFit.scale > 0 && seatHints.map(({ id, action: seat }) => {
        const near = seatHovered === id || Math.hypot(playerPosition.x - seat.approach.x, playerPosition.y - seat.approach.y) <= 120;
        return <div key={id} className={exitMarkerStyles.anchor} data-seat-id={id} data-near={near} aria-hidden="true"
          style={{ left: worldFit.x + seat.seat.x * worldFit.scale,
            top: worldFit.y + seat.seat.y * worldFit.scale,
            transform: `translate(-50%, -50%) scale(${worldFit.scale})` }}>
          <span className={exitMarkerStyles.name} style={{ top: 56 }}>{t("pikoWorld.sitDown")}</span>
        </div>;
      })}
      {loadState === "ready" && showMayorHint && !movementBlocked && !welcomeOpen && townNpcsForMap(mapId).map(npc => (
        <PikoTownNpcInteraction key={npc.id} npc={npc} fit={worldFit}
          onInteract={onNpcInteract} onHover={onNpcHover} />
      ))}
      {taskStatus && <PikoTaskLabel task={taskStatus} position={playerPosition} fit={worldFit} headOffset={(playerSeated ? 81 : 136) * mapPerspectiveScale(mapId, playerPosition.y) + playerNameGap}
        available={loadState === "ready" && showMayorHint && !movementBlocked && !welcomeOpen && !speech}
        onInteract={() => stopPlayerRef.current()} />}
      {loadState === "ready" && showMayorHint && speech && !playerHeadOccluded && <PikoSpeechBubble body={speech.body} position={playerPosition} fit={worldFit} headOffset={(playerSeated ? 73 : 128) * mapPerspectiveScale(mapId, playerPosition.y) + playerNameGap} />}
      {loadState === "ready" && showMayorHint && dogGreeting?.mapId === mapId && <PikoSpeechBubble body="🐶❤️" position={dogGreeting} fit={worldFit} headOffset={dogGreeting.headOffset} />}
      {loadState === "ready" && mapId === "town-hall-interior" && hallNotice && !movementBlocked && <>
        <PikoSpeechBubble body={hallNotice.body} position={hallNotice.position} fit={worldFit} headOffset={185} />
        <span className="sr-only" role="status">{hallNotice.body}</span>
      </>}
      <PikoWelcomeDialog open={welcomeOpen} onOpenChange={open=>{welcomeOpenRef.current=open;setWelcomeOpen(open);}} />
      {import.meta.env.DEV && loadState === "ready" && showMayorHint && debugNavigation && worldFit.scale > 0 && !movementBlocked && (
        <Suspense fallback={null}><NavigationEditor key={mapId} navigation={debugNavigation} occlusion={debugOcclusion} fit={worldFit} player={playerPosition}
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
