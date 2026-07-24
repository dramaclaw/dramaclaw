// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function read(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("freezone viewer contracts", () => {
  it("keeps Pano360ViewerNode as a compatible freezone canvas tool", () => {
    const node = read("src/features/canvas/nodes/Pano360ViewerNode.tsx");
    const canvasNodes = read("src/features/canvas/domain/canvasNodes.ts");
    const registry = read("src/features/canvas/domain/nodeRegistry.ts");
    const nodeSelectionMenu = read("src/features/canvas/NodeSelectionMenu.tsx");
    const spawnOverlay = read("src/features/canvas/ui/NodeSpawnPlusOverlay.tsx");
    const nodesIndex = read("src/features/canvas/nodes/index.ts");

    expect(node).toContain("snap2x2");
    expect(node).toContain("snap4x3");
    expect(node).toContain("sphere_correction_deg");
    expect(node).toContain("selected_background");
    expect(node).toContain("360 自由画布查看器");
    expect(node).not.toContain("PanoCaptureDialog");
    expect(canvasNodes).toContain("pano360Viewer");
    expect(canvasNodes).toContain("Pano360ViewerNodeData");
    expect(registry).toContain("pano360ViewerNodeDefinition");
    expect(registry).toContain("node.menu.pano360Viewer");
    expect(nodeSelectionMenu).toContain("CANVAS_NODE_TYPES.pano360Viewer");
    expect(spawnOverlay).toContain("CANVAS_NODE_TYPES.pano360Viewer");
    expect(nodesIndex).toContain("pano360ViewerNode: Pano360ViewerNode");
    expect(nodesIndex).toContain("Pano360ViewerNode");
  });

  it("keeps the asset pano viewer on the legacy pano capture dialog", () => {
    const scenesPanel = read("src/components/assets/scenes-panel.tsx");

    expect(scenesPanel).toContain("PanoCaptureDialog");
    expect(scenesPanel).toContain("useScenePanoManifest");
    expect(scenesPanel).toContain("setPanoDialogOpen(true)");
    expect(scenesPanel).toContain("handleScenePanoCapture");
    expect(scenesPanel).toContain("onOpenPanoViewer={() => setPanoDialogOpen(true)}");
    expect(scenesPanel).toContain("async function handleOpenStageViewer()");
    expect(scenesPanel).toContain("await stageManifest.refetch()");
    expect(scenesPanel).toContain("setStageDialogOpen(true)");
    expect(scenesPanel).toContain("onOpenStageViewer={handleOpenStageViewer}");
  });

  it("keeps ThreeDWorldNode freezone mode optional and separate from mainline beat overlay requirements", () => {
    const node = read("src/features/canvas/nodes/ThreeDWorldNode.tsx");

    expect(node).toContain("ThreeDDirectorDialog");
    expect(node).toContain("const SCENE_DIRECTOR_SOURCE_ROLES = new Set");
    expect(node).toContain("'scene_3gs_master_ply'");
    expect(node).toContain("'scene_3gs_custom_scene'");
    expect(node).toContain("function isCandidateDirectorWorldNode");
    expect(node).toContain("!hasMainlineContexts");
    expect(node).toContain("return activeSource ? [activeSource] : [];");
    expect(node).toContain("function isSceneDirectorWorldNode");
    expect(node).toContain("if (!hasMainlineContexts");
    expect(node).toContain("const sceneDirectorWorld = isSceneDirectorWorldNode(data)");
    expect(node).toContain("if (sceneDirectorWorld) return null;");
    expect(node).toContain("viewerPurpose={beatContext ? 'beat' : 'freezone'}");
    expect(node).toContain("canvas_screenshot_node");
    expect(node).toContain("beat_selected_background");
    expect(node).toContain("onSubmitDirectorCombined={beatContext ? handleSubmitDirectorCombined : undefined}");
    expect(node).toContain("onCaptureCanvasNode={handleCaptureCanvasNode}");
    expect(node).toContain("isDirectorRenderNode");
    expect(node).toContain("isDirectorRenderNode ? fallbackThumb ?? upstreamThumb : upstreamThumb ?? fallbackThumb");
    expect(node).toContain("snapshot: meta.snapshot");
    expect(node).not.toContain("blockings_dir_fs:");
    expect(node).not.toContain("slate_beat:");
  });

  it("keeps scene director world assets scene-scoped when they are added to freezone", () => {
    const panel = read("src/features/freezone/AssetLibraryPanel.tsx");
    const canvas = read("src/features/canvas/Canvas.tsx");
    const hydrate = read("src/features/canvas/domain/assetDragHydrate.ts");

    expect(panel).toContain('const SCENE_DIRECTOR_WORLD_ROLE = "scene_director_world"');
    expect(panel).toContain('const sceneContext = existing?.find((ctx) => ctx.kind === "scene" && ctx.sceneId === sceneId)');
    expect(panel).toContain("if (sceneContext) return [sceneContext];");
    expect(panel).toContain('kind: "scene"');
    expect(panel).toContain("sceneId,");
    expect(panel).toContain("hydrateAssetDragPayload(payload)");
    expect(canvas).toContain("hydrateAssetDragPayload(assetPayload)");
    expect(hydrate).toContain("getSceneDirectorStageManifest");
    expect(hydrate).toContain("directorWorldSourcesFromManifest");
    expect(hydrate).toContain('role !== SCENE_DIRECTOR_WORLD_ROLE');
    expect(panel).not.toContain("if (existing?.length) return existing;");
  });

  it("lets a source-less ThreeDWorldNode enter a blank Director World", () => {
    const node = read("src/features/canvas/nodes/ThreeDWorldNode.tsx");

    expect(node).toContain("source_type: 'sog' as const");
    expect(node).toContain("source_kind: 'custom' as const");
    expect(node).toContain("pano_url: undefined");
    expect(node).toContain("{selected ? (");
    expect(node).not.toContain("if (!data.plyUrl && !data.panoUrl && !data.sources?.length && upstreamPanoSources.length === 0) return;");
    expect(node).not.toContain("{selected && hasWorldSource ? (");
    expect(node).toContain("t('viewer.threeD.enterDirectorWorld')");
  });

  it("exposes a director world camera reset without clearing saved scene data", () => {
    const dialog = read("src/features/viewer-kit/three-d/ThreeDDirectorDialog.tsx");
    const viewerApp = read("src/features/viewer-kit/three-d/engine/viewerApp.ts");
    const zh = read("public/locales/zh/translation.json");
    const en = read("public/locales/en/translation.json");
    const outputSectionIndex = dialog.indexOf('t("viewer.threeD.sections.output")');
    const sourceCalibrationResetIndex = dialog.indexOf('t("viewer.threeD.sourceCalibration.reset")');
    const resetCameraIndex = dialog.indexOf(
      't("viewer.threeD.resetCamera")',
      sourceCalibrationResetIndex,
    );
    const beatOverlaySectionIndex = dialog.indexOf('t("viewer.threeD.beatOverlay.title")');
    const beatOverlaySection = dialog.slice(beatOverlaySectionIndex, outputSectionIndex);
    const outputSection = dialog.slice(outputSectionIndex);

    expect(viewerApp).toContain("resetCamera: () =>");
    expect(dialog).toContain("viewerApp.resetCamera()");
    expect(dialog).toContain('t("viewer.threeD.resetCamera")');
    expect(sourceCalibrationResetIndex).toBeGreaterThan(-1);
    expect(resetCameraIndex).toBeGreaterThan(sourceCalibrationResetIndex);
    expect(resetCameraIndex).toBeLessThan(beatOverlaySectionIndex);
    expect(beatOverlaySection).not.toContain('t("viewer.threeD.resetCamera")');
    expect(outputSection).not.toContain('t("viewer.threeD.resetCamera")');
    expect(dialog).not.toContain("onClearScene?.() && viewer.resetCamera()");
    expect(zh).toContain('"resetCamera": "重置镜头"');
    expect(en).toContain('"resetCamera": "Reset camera"');
  });

  it("copies a selected beat overlay into the current beat explicitly", () => {
    const dialog = read("src/features/viewer-kit/three-d/ThreeDDirectorDialog.tsx");
    const zh = read("public/locales/zh/translation.json");
    const en = read("public/locales/en/translation.json");

    expect(dialog).toContain("const sourceBeatNumber = Number(selectedOverlayBeat);");
    expect(dialog).toContain("const targetBeatNumber = manifest.beat_context.beat;");
    expect(dialog).toContain("target_beat: targetBeatNumber");
    expect(dialog).toContain("beat: targetBeatNumber");
    expect(dialog).toContain("applyOverlayStatus(next, targetBeatNumber)");
    expect(dialog).toContain('t("viewer.threeD.beatOverlay.copyFlow"');
    expect(zh).toContain('"inheritedFromBeat": "当前未保存，临时沿用镜头 {{beat}}"');
    expect(en).toContain('"inheritedFromBeat": "Not saved yet; temporarily using shot {{beat}}"');
    expect(dialog).not.toContain("const loaded = await loadOverlay(beatNumber);");
    expect(zh).toContain('"copyFlow": "复制来源：镜头 {{sourceBeat}} → 当前镜头 {{targetBeat}}"');
    expect(zh).toContain('"copySelected": "复制来源到当前镜头"');
    expect(en).toContain('"copyFlow": "Copy source: shot {{sourceBeat}} -> current shot {{targetBeat}}"');
    expect(en).toContain('"copySelected": "Copy source into current shot"');
  });

  it("lets scene director worlds create unbounded anonymous actors and props with neutral fallback color", () => {
    const dialog = read("src/features/viewer-kit/three-d/ThreeDDirectorDialog.tsx");
    const manifest = read("src/features/viewer-kit/three-d/directorManifest.ts");
    const worldNode = read("src/features/canvas/nodes/ThreeDWorldNode.tsx");
    const viewerManifestsApi = read("src/api/viewerManifests.ts");
    const skillNode = read("src/features/canvas/nodes/SkillNode.tsx");
    const zh = read("public/locales/zh/translation.json");
    const en = read("public/locales/en/translation.json");

    expect(manifest).toContain("anonymous_prop_colors: string[];");
    expect(viewerManifestsApi).toContain("getDirectorStagePalette");
    expect(worldNode).toContain("getDirectorStagePalette(projectId)");
    expect(worldNode).toContain("defaultPalette");
    expect(worldNode).not.toContain("ANONYMOUS_DIRECTOR_COLORS");
    expect(worldNode).not.toContain("ANONYMOUS_DIRECTOR_PROP_COLORS");
    expect(dialog).not.toContain("ANONYMOUS_ACTOR_COLORS");
    expect(dialog).not.toContain("ANONYMOUS_PROP_COLORS");
    expect(skillNode).not.toContain("BEAT_ACTOR_COLORS");
    expect(skillNode).not.toContain("BEAT_PROP_COLORS");
    expect(dialog).toContain('const ANONYMOUS_FALLBACK_COLOR = "#9ca3af"');
    expect(dialog).toContain("anonymousSequence.actor + 1");
    expect(dialog).toContain("anonymousSequence.prop + 1");
    expect(dialog).toContain("const anonymousPropColors = manifest.palette.anonymous_prop_colors ?? []");
    expect(dialog).toContain("colorFromCreationPalette(anonymousActorPalette, anonymousSequence.actor)");
    expect(dialog).toContain("colorFromCreationPalette(anonymousPropPalette, anonymousSequence.prop)");
    expect(dialog).toContain("const nextPropLikeColor = colorFromCreationPalette(anonymousPropPalette, anonymousSequence.prop)");
    expect(dialog).toContain("const [propLikeColor, setPropLikeColor] = useState<string>(ANONYMOUS_FALLBACK_COLOR)");
    expect(dialog).toContain("if (activeProp) setPropLikeColor(activeProp.color)");
    expect(dialog).toContain("function ColorPaletteField");
    expect(dialog).toContain('className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(24px,24px))] gap-2"');
    expect(dialog).toContain("shadow-[0_0_0_3px_rgba(255,255,255,0.38)");
    expect(dialog).toContain("ColorPaletteField");
    expect(dialog).toContain("anonymousPropColors.length > 0");
    expect(dialog).toContain("? anonymousPropColors");
    expect(dialog).toContain("setAnonymousSequence((prev) => ({ ...prev, actor: prev.actor + 1 }))");
    expect(dialog).toContain("setAnonymousSequence((prev) => ({ ...prev, prop: prev.prop + 1 }))");
    expect(dialog.match(/setAnonymousSequence\(\(prev\) => \(\{ \.\.\.prev, prop: prev\.prop \+ 1 \}\)\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(dialog).toContain('manifest.mode === "beat" ? activeActor.color : actorColor');
    expect(dialog).toContain("const color = manifest.mode === \"beat\" ? activeProp.color : propLikeColor");
    expect(dialog).toContain("color: propLikeColor");
    expect(dialog).toContain("onChange={setPropLikeColor}");
    expect(dialog).toContain("palette={anonymousActorPalette}");
    expect(dialog).toContain("palette={anonymousPropPalette}");
    expect(dialog).toContain('label={t("viewer.threeD.propColor")}');
    expect(dialog).toContain('label={t("viewer.threeD.stagingColor")}');
    expect(dialog).toContain('selection?.kind === "staging"');
    expect(dialog).toContain('label={t("viewer.threeD.stagingShapeHint")}');
    expect(dialog).not.toContain('color: "#4587ff"');
    expect(dialog).not.toContain('payload?.marker_color ?? payload?.color ?? "#4587ff"');
    expect(dialog).not.toContain("const [propColor");
    expect(dialog).toContain('t("viewer.threeD.propColor")');
    expect(dialog).toContain('t("viewer.threeD.stagingColor")');
    expect(dialog).not.toContain('t("viewer.threeD.propShapeHint")');
    expect(dialog).toContain('t("viewer.threeD.stagingShapeHint")');
    expect(dialog).toContain('t("viewer.threeD.nextAnonymousActor"');
    expect(dialog).toContain('t("viewer.threeD.nextAnonymousProp"');
    expect(zh).toContain('"nextAnonymousActor": "下一个人物：{{label}} · {{color}}"');
    expect(zh).toContain('"nextAnonymousProp": "下一个道具：{{label}} · {{color}}"');
    expect(zh).toContain('"propColor": "道具颜色"');
    expect(zh).toContain('"stagingColor": "占位颜色"');
    expect(zh).toContain('"stagingShapeHint": "占位形状"');
    expect(en).toContain('"nextAnonymousActor": "Next actor: {{label}} · {{color}}"');
    expect(en).toContain('"nextAnonymousProp": "Next prop: {{label}} · {{color}}"');
    expect(en).toContain('"propColor": "Prop color"');
    expect(en).toContain('"stagingColor": "Staging color"');
    expect(en).toContain('"stagingShapeHint": "Staging shape"');
  });

  it("uses shape hints to build visible prop and staging proxy silhouettes", () => {
    const viewerApp = read("src/features/viewer-kit/three-d/engine/viewerApp.ts");
    const shapeHints = read("src/features/viewer-kit/three-d/engine/shapeHints.ts");
    const zh = read("public/locales/zh/translation.json");
    const en = read("public/locales/en/translation.json");

    expect(shapeHints).toContain("sports_car");
    expect(shapeHints).toContain("export function proxyPartsForHint");
    expect(viewerApp).toContain("proxyPartsForHint");
    expect(viewerApp).toContain("function rebuildShapeHintProxy");
    expect(viewerApp).toContain("rebuildShapeHintProxy(entity, hint, colorHex)");
    expect(viewerApp).toContain("markerShapeHints.set(selection.entity, hint)");
    expect(viewerApp).toContain("getMarkerShapeHint");
    expect(viewerApp).toContain("selection.kind !== 'staging'");
    expect(viewerApp).toContain("rebuildShapeHintProxy(selection.entity, hint, markerColors.get(selection.entity)");
    expect(viewerApp).toContain("const ground = pos.y + s.y * proxyLocalBottomForHint(hint)");
    expect(viewerApp).toContain("pos.x, ground - next.y * proxyLocalBottomForHint(hint), pos.z");
    expect(viewerApp).not.toContain("entity.addComponent('render', { type: 'box' });\n      const mat = makeMaterial(color);");
    expect(zh).toContain('"sports_car": "跑车"');
    expect(en).toContain('"sports_car": "Sports car"');
  });

  it("keeps director marker pixels at their assigned palette colors in combined captures", () => {
    const viewerApp = read("src/features/viewer-kit/three-d/engine/viewerApp.ts");

    expect(viewerApp).toContain("m.useTonemap = false;");
    expect(viewerApp).toContain("m.opacity = 1;");
    expect(viewerApp).toContain("m.blendType = pc.BLEND_NONE;");
    expect(viewerApp).toContain("context.imageSmoothingEnabled = renderMode === 'env_only';");
    expect(viewerApp).not.toContain("m.opacity = 0.92;");
    expect(viewerApp).not.toContain("m.blendType = pc.BLEND_NORMAL;");
  });

  it("documents that F only moves the selection to the crosshair", () => {
    const dialog = read("src/features/viewer-kit/three-d/ThreeDDirectorDialog.tsx");
    const viewerApp = read("src/features/viewer-kit/three-d/engine/viewerApp.ts");
    const zh = read("public/locales/zh/translation.json");
    const en = read("public/locales/en/translation.json");

    expect(dialog).toContain('case "KeyF":');
    expect(dialog).toContain("viewerApp.moveSelectedToCrosshair()");
    expect(dialog).toContain('case "KeyM":');
    expect(dialog).toContain("viewerApp.mountSelectedAtCrosshair()");
    expect(viewerApp).not.toContain("if (mountSelectedAtCrosshair()) return true;");
    expect(zh).toContain("F 移到准星");
    expect(zh).toContain("M 挂到准星");
    expect(en).toContain("F move to crosshair");
    expect(en).toContain("M mount to crosshair");
  });

  it("restores explicit actor mount relationships without making F auto-mount", () => {
    const viewerApp = read("src/features/viewer-kit/three-d/engine/viewerApp.ts");
    const dialog = read("src/features/viewer-kit/three-d/ThreeDDirectorDialog.tsx");
    const zh = read("public/locales/zh/translation.json");
    const en = read("public/locales/en/translation.json");

    expect(viewerApp).toContain("mount?: { kind: 'prop' | 'staging'; index: number; attachPointId: string };");
    expect(viewerApp).toContain("const mountLinks = new WeakMap<pc.Entity, MountTarget>();");
    expect(viewerApp).toContain("function mountSelectedAtCrosshair(): boolean");
    expect(viewerApp).toContain("function unmountSelected(): boolean");
    expect(viewerApp).toContain("function syncMountedActorsOf(prop: pc.Entity): void");
    expect(viewerApp).toContain("snap.mount = { kind: link.kind, index: idx, attachPointId: link.attachPointId };");
    expect(viewerApp).toContain("mountActorOn(actor, { kind: s.mount.kind, entity: target, attachPointId: s.mount.attachPointId || '' });");
    expect(viewerApp).toContain("if (selection.kind !== 'actor') syncMountedActorsOf(selection.entity);");
    expect(viewerApp).toContain("syncMountedActorsForSelection();");
    expect(viewerApp).toContain("function syncMountedActorsForSelection(): void");
    expect(viewerApp).not.toContain("if (mountSelectedAtCrosshair()) return true;");
    expect(dialog).toContain("viewer.mountSelectedAtCrosshair()");
    expect(dialog).toContain("viewer.unmountSelected()");
    expect(dialog).toContain("selection.mounted");
    expect(zh).toContain('"mountSelected": "挂到准星目标"');
    expect(zh).toContain('"unmountSelected": "解除挂载"');
    expect(en).toContain('"mountSelected": "Mount to crosshair target"');
    expect(en).toContain('"unmountSelected": "Unmount"');
  });

  it("moves selected markers to the actual center-screen crosshair ray", () => {
    const viewerApp = read("src/features/viewer-kit/three-d/engine/viewerApp.ts");

    expect(viewerApp).toContain("function crosshairRay(): pc.Ray | null");
    expect(viewerApp).toContain("return screenToRay(rect.left + rect.width / 2, rect.top + rect.height / 2);");
    expect(viewerApp).toContain("app.graphicsDevice.maxPixelRatio = dpr;");
    expect(viewerApp).toContain("app.resizeCanvas(rect.width, rect.height);");
    expect(viewerApp).toContain("const x = clientX - rect.left;");
    expect(viewerApp).toContain("const y = clientY - rect.top;");
    expect(viewerApp).not.toContain("canvas.width = Math.max(1, Math.round(rect.width * dpr));");
    expect(viewerApp).not.toContain("const x = (clientX - rect.left) * scaleX;");
    expect(viewerApp).toContain("function raycastRayToHorizontalPlane(ray: pc.Ray, planeY: number): pc.Vec3 | null");
    expect(viewerApp).toContain("const current = selection.entity.getPosition();");
    expect(viewerApp).toContain("const hit = raycastRayToHorizontalPlane(ray, current.y);");
    expect(viewerApp).toContain("selection.entity.setPosition(hit.x, current.y, hit.z);");
    expect(viewerApp).not.toContain("raycastRayToCollision");
    expect(viewerApp).not.toContain("source: 'collision'");
    expect(viewerApp).not.toContain("const ray = new pc.Ray(camera.getPosition().clone(), camera.forward.clone().normalize());");
  });

  it("hides the system cursor while left-dragging the 3D camera", () => {
    const flyCamera = read("src/features/viewer-kit/three-d/engine/flyCamera.ts");

    expect(flyCamera).toContain("let cursorBeforeLeftDrag: string | null = null;");
    expect(flyCamera).toContain("if (event.button === 0) {");
    expect(flyCamera).toContain("cursorBeforeLeftDrag = canvas.style.cursor;");
    expect(flyCamera).toContain("canvas.style.cursor = 'none';");
    expect(flyCamera).toContain("canvas.style.cursor = cursorBeforeLeftDrag;");
    expect(flyCamera).toContain("cursorBeforeLeftDrag = null;");
    expect(flyCamera).toContain("const restoreLeftDragCursor = () => {");
    expect(flyCamera).toContain("document.addEventListener('pointercancel', onPointerCancel);");
    expect(flyCamera).toContain("canvas.addEventListener('lostpointercapture', onLostPointerCapture);");
    expect(flyCamera).toContain("restoreLeftDragCursor();");
  });

  it("tears down PlayCanvas update and ignores async source loads after destroy", () => {
    const viewerApp = read("src/features/viewer-kit/three-d/engine/viewerApp.ts");

    expect(viewerApp).toContain("let destroyed = false;");
    expect(viewerApp).toContain("const updateHandler = () => {");
    expect(viewerApp).toContain("app.on('update', updateHandler);");
    expect(viewerApp).toContain("if (destroyed) return;");
    expect(viewerApp).toContain("destroyed = true;");
    expect(viewerApp).toContain("app.off('update', updateHandler);");
    expect(viewerApp).toContain("if (destroyed) {");
    expect(viewerApp).toContain("app.assets.remove(asset);");
  });

  it("keeps generated scene 360 panoramas on the legacy pano viewer path", () => {
    const overlay = read("src/features/canvas/ui/Scene360Overlay.tsx");

    expect(overlay).toContain("CANVAS_NODE_TYPES.pano360Viewer");
    expect(overlay).not.toContain("CANVAS_NODE_TYPES.threeDWorld");
    expect(overlay).not.toContain("source_type: 'pano360'");
    expect(overlay).not.toContain("activeSourceId");
    expect(overlay).toContain("output_role: 'scene_360_candidate'");
    expect(overlay).toContain("media_kind: 'pano360'");
    expect(overlay).toContain("aspectRatio,");
  });

  it("lets canvas ThreeDWorldNode open pano360 image sources when explicitly connected", () => {
    const canvasNodes = read("src/features/canvas/domain/canvasNodes.ts");
    const node = read("src/features/canvas/nodes/ThreeDWorldNode.tsx");

    expect(canvasNodes).toContain("panoUrl?: string | null");
    expect(canvasNodes).toContain("sources?: DirectorWorldSource[]");
    expect(node).toContain("source_type: sourceType");
    expect(node).toContain("sourceType = data.plyUrl ? 'sog' : 'pano360'");
    expect(node).toContain("directorPanoSourceFromCanvasNode");
    expect(node).toContain("const upstreamPanoSources");
    expect(node).toContain("for (const source of upstreamPanoSources)");
    expect(node).not.toContain("getSceneDirectorStageManifest");
    expect(node).not.toContain("canHydrateSceneDirectorWorld");
    expect(node).not.toContain("saveSceneDirectorWorld");
    expect(node).not.toContain("clearSceneDirectorWorld");
    expect(node).not.toContain("localScenePatchFromManifest");
    expect(node).not.toContain("sceneIdFromThreeDWorldNode");
    expect(node).toContain("directorManifest?.scene");
    expect(node).toContain("directorManifest?.scenes_by_source_id");
    expect(node).not.toContain("function isPanoImageNode");
    expect(node).not.toContain("function directorPanoSourceFromUpstream");
    expect(node).not.toContain("if (!data.plyUrl && !data.panoUrl && !data.sources?.length && upstreamPanoSources.length === 0) return");
    expect(node).toContain("{selected ? (");
    expect(node).toContain("sources: directorSources.length > 0 ? directorSources : undefined");
    expect(node).toContain("activeSourceId");
    expect(node).toContain("snapshot.world?.activeSourceId");
    expect(node).toContain("activeSourceId: nextActiveSourceId");
    expect(node).toContain("scenesBySourceId");
    expect(node).toContain("initialScenesBySourceId");
  });

  it("commits scene director worlds only through the explicit structured commit path", () => {
    const push = read("src/api/push.ts");
    const target = read("src/features/freezone/commit/pushTarget.ts");
    const dialog = read("src/features/freezone/commit/CommitDialog.tsx");
    const shell = read("src/features/freezone/FreezoneShell.tsx");

    expect(push).toContain('"scene_director_world"');
    expect(target).toContain('role === "scene_director_world"');
    expect(dialog).toContain("commitSceneDirectorWorldFromCanvasNode");
    expect(shell).toContain("saveOpenDirectorWorldScene(nodeId)");
    expect(shell).toContain("nodeData: latestData");
    expect(shell).toContain("nodeDataPatchAfterCommittedTarget");
    expect(shell).toContain("sceneDirectorWorldDataForManifest");
    expect(shell).toContain("invalidateCommittedTargetQueries(target)");
    expect(shell).toContain("queryKeys.sceneDirectorStageManifest(projectId, target.scene_id)");
    expect(shell).not.toContain("updateNodeData(nodeId, manifestNodeData)");
    expect(shell).not.toContain("updateNodeData(pushState.nodeId, manifestNodeData)");
  });

  it("keeps Director World generation behind the connected ThreeDWorldNode", () => {
    const toolbar = read("src/features/canvas/ui/NodeActionToolbar.tsx");
    const overlay = read("src/features/canvas/ui/SelectedNodeOverlay.tsx");
    const worldNode = read("src/features/canvas/nodes/ThreeDWorldNode.tsx");
    const zh = read("public/locales/zh/translation.json");
    const en = read("public/locales/en/translation.json");

    expect(toolbar).not.toContain("nodeToolbar.generateDirectorWorld");
    expect(toolbar).not.toContain("nodeToolbar.addPanoToDirectorWorld");
    expect(overlay).not.toContain("handleGenerateDirectorWorldFromImage");
    expect(overlay).not.toContain("handleAddPanoToDirectorWorld");
    expect(worldNode).not.toContain("PLY_KIND_OPTIONS");
    expect(worldNode).toContain("DIRECTOR_IMAGE_SOURCE_OPTIONS");
    expect(worldNode).toContain("nodeToolbar.normalImage");
    expect(worldNode).toContain("nodeToolbar.image360");
    expect(worldNode).toContain("referenceImages");
    expect(worldNode).toContain("onReferenceImageChange");
    expect(worldNode).toContain("const inferredImageSourceKind");
    expect(worldNode).toContain("if (isPanoImageCanvasNode(sourceNodeForGeneration)) return 'pano';");
    expect(worldNode).toContain("function imageTo3gsKindForSource");
    expect(worldNode).toContain("const sourceKind = imageTo3gsKindForSource(sourceNode, selectedImageSourceKind)");
    expect(worldNode).toContain("submitFreezoneImageTo3GS");
    expect(worldNode).toContain("sourceFromImageTo3gsResult");
    expect(worldNode).toContain("'freezone.image_to_3gs'");
    expect(worldNode).toContain("worldBillingRuleMissing");
    expect(worldNode).toContain("<CreditCostPill");
    expect(worldNode).toContain("NODE_CREDIT_PILL_FLAT_CLASS");
    expect(worldNode).toContain("NODE_GENERATE_BUTTON_BASE_CLASS");
    expect(worldNode).toContain('<ArrowUp className="h-4 w-4" />');
    expect(zh).toContain('"generateDirectorWorld": "生成3DGS世界"');
    expect(en).toContain('"generateDirectorWorld": "Generate 3DGS World"');
  });

  it("shows and enforces the shared video-analysis feature price", () => {
    const toolbar = read("src/features/canvas/ui/NodeActionToolbar.tsx");

    expect(toolbar).toContain('"freezone.video_analyze"');
    expect(toolbar).toContain("videoAnalyzeBillingRuleMissing");
    expect(toolbar).toContain("videoAnalyzeCreditCostDisplay");
    expect(toolbar).toContain("<CreditCostPill");
  });

  it("keeps freezone 3GS commit roles for generated PLY source kinds", () => {
    const commit = read("src/features/freezone/commit/promoteToAsset.ts");

    expect(commit).toContain("scene_3gs_master_ply");
    expect(commit).toContain("scene_3gs_reverse_ply");
    expect(commit).toContain("scene_3gs_pano_ply");
    expect(commit).not.toContain("scene_3gs_collision_glb");
  });

  it("auto-commits present image generation nodes when requested by the preset", () => {
    const imageGenNode = read("src/features/canvas/nodes/ImageGenNode.tsx");

    expect(imageGenNode).toContain("autoCommitOnGenerate");
    expect(imageGenNode).toContain("canvasEventBus.publish('freezone/commit-node'");
    expect(imageGenNode).toContain("auto: true");
  });

  it("routes projection group toolbar actions through projection sync and remove events", () => {
    const toolbar = read("src/features/canvas/ui/NodeActionToolbar.tsx");
    const shell = read("src/features/freezone/FreezoneShell.tsx");
    const ports = read("src/features/canvas/application/ports.ts");
    const groupNode = read("src/features/canvas/nodes/GroupNode.tsx");

    expect(toolbar).toContain("isProtectedProjectionGroupNode(node)");
    expect(toolbar).toContain('"freezone/projection-sync"');
    expect(toolbar).toContain('"freezone/projection-remove"');
    expect(toolbar).toContain("useCanvasProjectionStatus(protectedProjectionKey)");
    expect(shell).toContain('"freezone/projection-sync"');
    expect(shell).toContain("handleSyncProjection(projectionKey)");
    expect(shell).toContain('"freezone/projection-remove"');
    expect(shell).toContain("handleRemoveProjection(projectionKey)");
    expect(shell).not.toContain("<ProjectionPanel");
    expect(shell).toContain("setCanvasProjectionStatuses(result.projections)");
    expect(shell).toContain("clearCanvasProjectionStatuses()");
    expect(groupNode).toContain("useCanvasProjectionStatus(projectionKey)");
    expect(groupNode).toContain("projection-stale-frame");
    expect(groupNode).toContain("projection-stale-banner");
    expect(groupNode).toContain("freezone.projections.staleBadge");
    expect(ports).toContain("'freezone/projection-sync'");
    expect(ports).toContain("'freezone/projection-remove'");
  });

  it("uses the backend scene Director World manifest as the single source of truth", () => {
    const scenesPanel = read("src/components/assets/scenes-panel.tsx");

    expect(scenesPanel).toContain("useSceneDirectorStageManifest");
    expect(scenesPanel).toContain("const sceneDirectorManifest = stageManifest.data?.ok");
    expect(scenesPanel).toContain("? stageManifest.data.data");
    expect(scenesPanel).toContain(": null");
    expect(scenesPanel).not.toContain("scenePanoDirectorManifest");
    expect(scenesPanel).not.toContain("directorManifestWithScenePanoSource");
  });

  it("keeps viewer purpose and capture metadata as explicit shared contracts", () => {
    const purpose = read("src/features/viewer-kit/viewerPurpose.ts");
    const store = read("src/stores/canvasStore.ts");

    expect(purpose).toContain('ViewerPurpose = "mainline" | "freezone" | "asset" | "beat"');
    expect(store).toContain("captureMetadata");
  });
});
