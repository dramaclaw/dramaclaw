// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowUpRight } from "lucide-react";

import { Label } from "@/components/ui/label";
import { MentionTextarea } from "@/components/episode/beat-workbench/mention-textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { saveScopes, trackSave } from "@/stores/save-status-store";
import { useNavigateToAsset } from "@/hooks/use-assets-deep-link";
import { useUpdateBeat } from "@/lib/queries/scripts";
import { useEpisodeDetail } from "@/lib/queries/episodes";
import { useScenePlatePreview, useScenes } from "@/lib/queries/scenes";
import {
  extractIdentityMarkers,
  extractPropMarkers,
  mentionsToProgramMarkers,
  programMarkersToMentions,
} from "@/lib/mention-markers";
import {
  sceneNameToRef,
  sceneRefToName,
  type SceneRefRecordLike,
} from "@/lib/scene-ref";
import { identityRefLabel } from "@/lib/identity-period";
import { timeOfDayLabel, timeOfDayOptions } from "@/lib/time-of-day";
import { cn } from "@/lib/utils";
import type { Beat } from "@/types/episode";
import type { BeatUpdate } from "@/types/script";

interface TextPaneProps {
  beat: Beat;
  project: string;
  episode: number;
  spineTemplate?: "drama" | "narrated";
}

const NO_CHARACTER_MARKER = "__NO_CHARACTER__";
const NO_PROP_MARKER = "__NO_PROP__";
const NO_SCENE_MARKER = "__none__";
const NO_SCENE_VARIANT_MARKER = "__NO_SCENE_VARIANT__";
const NO_TIME_OF_DAY_MARKER = "__NO_TIME_OF_DAY__";
const NO_SPEAKER_MARKER = "__NO_SPEAKER__";
type TextPaneDirtyFields = {
  narration: boolean;
  visual: boolean;
  sceneRef: boolean;
  timeOfDay: boolean;
  speaker: boolean;
};

const CONTROL_CLASS =
  "rounded-[8px] border-white/[0.09] bg-white/[0.025] text-[13px] text-foreground/88 shadow-none placeholder:text-muted-foreground/45 hover:bg-white/[0.032] focus-visible:border-white/[0.18] focus-visible:bg-white/[0.035] focus-visible:ring-0 dark:border-white/[0.09] dark:bg-white/[0.025] dark:hover:bg-white/[0.032] dark:focus-visible:border-white/[0.18] dark:focus-visible:bg-white/[0.035]";
const COMPACT_CONTROL_CLASS = cn(CONTROL_CLASS, "h-8 px-3");
// Dropdown popup polish — open below the trigger (not item-aligned/overlapping),
// inset padding so the highlight rounds nicely, capped height with scroll.
const SELECT_POPUP_CLASS = "max-h-72 p-1";
const SELECT_ITEM_CLASS = "py-1.5";
const MENTION_TEXTAREA_CLASS = cn(CONTROL_CLASS, "min-h-[72px]");
const MENTION_TEXTAREA_INPUT_CLASS = "px-3 py-2 text-[13px] leading-6";

function audioTypeLabel(
  t: ReturnType<typeof useTranslation>["t"],
  value: string | undefined | null,
) {
  if (value === "silence") return t("episode.workbench.text.silence");
  if (value === "dialogue") return t("episode.workbench.text.dialogue");
  return t("episode.workbench.text.narrationLabel");
}

/**
 * 文案 sub-tab — per-beat full metadata editor. Autosaves on blur (text inputs)
 * or on change (select, toggle). No manual save button.
 */
export function TextPane({ beat, project, episode, spineTemplate = "drama" }: TextPaneProps) {
  const { t } = useTranslation();
  const navigateToAsset = useNavigateToAsset(project);
  const update = useUpdateBeat(project, episode);
  const beatTextScope = saveScopes.beatText(project, episode, beat.beat_number);
  const episodeQuery = useEpisodeDetail(project, episode);
  const episodeIdentityIds = useMemo(
    () => episodeQuery.data?.data?.identity_ids ?? [],
    [episodeQuery.data],
  );
  const identityOptions = useMemo(
    () => [NO_CHARACTER_MARKER, ...episodeIdentityIds],
    [episodeIdentityIds],
  );
  const episodePropIds = useMemo(
    () => (episodeQuery.data?.data?.prop_menu ?? []).map((item) => item.prop_id),
    [episodeQuery.data],
  );
  const propOptions = useMemo(
    () => [NO_PROP_MARKER, ...episodePropIds],
    [episodePropIds],
  );
  const scenesQuery = useScenes(project);
  // Scene records drive the split base/variant controls. Beat storage remains
  // canonical `{scene_id, variant_id}`; time-version plates stay out of writes.
  const sceneRefRecords = useMemo<SceneRefRecordLike[]>(
    () => [
      ...(scenesQuery.data?.data ?? []).map((scene) => ({
        name: scene.name,
        base_scene_id: scene.base_scene_id,
        variant_id: scene.variant_id,
        time_of_day: scene.time_of_day,
      })),
      ...(episodeQuery.data?.data?.scene_menu ?? []).map((item) => ({
        scene_id: item.scene_id,
        base_scene_id: item.base_scene_id,
        variant_id: item.variant_id,
        time_of_day: item.time_of_day,
      })),
    ],
    [scenesQuery.data, episodeQuery.data],
  );

  const [narration, setNarration] = useState(
    programMarkersToMentions(beat.narration_segment ?? ""),
  );
  const [visual, setVisual] = useState(
    programMarkersToMentions(beat.visual_description ?? ""),
  );
  const [audioType, setAudioType] = useState(beat.audio_type ?? "narration");
  const [sceneId, setSceneId] = useState(
    sceneRefToName(beat.scene_ref) || beat.location || "",
  );
  const [timeOfDay, setTimeOfDay] = useState(beat.time_of_day ?? "");

  const [speaker, setSpeaker] = useState(beat.speaker ?? "");

  const [identities, setIdentities] = useState<string[]>(
    beat.detected_identities ?? [],
  );
  const [props, setProps] = useState<string[]>(beat.detected_props ?? []);
  const dirtyRef = useRef<TextPaneDirtyFields>({
    narration: false,
    visual: false,
    sceneRef: false,
    timeOfDay: false,
    speaker: false,
  });
  const clearDirtyForPatch = (patch: BeatUpdate) => {
    if ("narration_segment" in patch) dirtyRef.current.narration = false;
    if ("visual_description" in patch) dirtyRef.current.visual = false;
    if ("scene_ref" in patch) dirtyRef.current.sceneRef = false;
    if ("time_of_day" in patch) dirtyRef.current.timeOfDay = false;
    if ("speaker" in patch) dirtyRef.current.speaker = false;
  };

  // Reset when beat_number changes (user selected a different beat).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setNarration(programMarkersToMentions(beat.narration_segment ?? ""));
    setVisual(programMarkersToMentions(beat.visual_description ?? ""));
    setAudioType(beat.audio_type ?? "narration");
    setSceneId(sceneRefToName(beat.scene_ref) || beat.location || "");
    setTimeOfDay(beat.time_of_day ?? "");
    setSpeaker(beat.speaker ?? "");
    setIdentities(beat.detected_identities ?? []);
    setProps(beat.detected_props ?? []);
    dirtyRef.current = {
      narration: false,
      visual: false,
      sceneRef: false,
      timeOfDay: false,
      speaker: false,
    };
  }, [beat.beat_number]);

  const saveField = async (patch: BeatUpdate) => {
    try {
      await trackSave(beatTextScope, () =>
        update.mutateAsync({ beatNum: beat.beat_number, data: patch }),
      );
      clearDirtyForPatch(patch);
    } catch {
      toast.error(t("episode.workbench.text.saveFailed"));
    }
  };
  const blurIfChanged = <K extends keyof BeatUpdate>(
    key: K,
    next: BeatUpdate[K],
    original: BeatUpdate[K],
  ) => {
    if (next !== original) saveField({ [key]: next } as BeatUpdate);
  };
  const normalizeMentionText = (text: string) =>
    mentionsToProgramMarkers(text, {
      identities: episodeIdentityIds,
      props: episodePropIds,
    });
  const markerPatchForVisual = (text: string): Pick<
    BeatUpdate,
    "detected_identities" | "detected_props"
  > => {
    const next: Pick<BeatUpdate, "detected_identities" | "detected_props"> = {};
    const markerIdentities = extractIdentityMarkers(text);
    const markerProps = extractPropMarkers(text);
    if (markerIdentities.length > 0) next.detected_identities = markerIdentities;
    if (markerProps.length > 0) next.detected_props = markerProps;
    return next;
  };
  const saveNarration = () => {
    const normalized = normalizeMentionText(narration);
    blurIfChanged("narration_segment", normalized, beat.narration_segment ?? "");
  };
  const saveVisual = () => {
    const normalized = normalizeMentionText(visual);
    if (normalized === (beat.visual_description ?? "")) return;
    saveField({
      visual_description: normalized,
      ...markerPatchForVisual(normalized),
    });
  };

  const currentSceneRef = useMemo(
    () => sceneNameToRef(sceneId, sceneRefRecords),
    [sceneId, sceneRefRecords],
  );
  const scenePlatePreview = useScenePlatePreview(
    project,
    currentSceneRef.scene_id,
    currentSceneRef.variant_id,
    timeOfDay,
  );
  const scenePlateRender = scenePlatePreview.data?.ok
    ? scenePlatePreview.data.data.render
    : null;

  const sceneNameForRef = (baseSceneId: string, variantId: string) => {
    const base = baseSceneId.trim();
    const variant = variantId.trim();
    if (!base) return "";
    for (const record of sceneRefRecords) {
      if (record.time_of_day?.trim()) continue;
      const recordName = String(record.name || record.scene_id || "").trim();
      if (!recordName) continue;
      const ref = sceneNameToRef(recordName, sceneRefRecords);
      if (ref.scene_id === base && ref.variant_id === variant) {
        return recordName;
      }
    }
    return sceneRefToName({ scene_id: base, variant_id: variant });
  };

  const saveSceneRefValue = (baseSceneId: string, variantId: string) => {
    const currentSceneId = sceneRefToName(beat.scene_ref) || beat.location || "";
    const currentRef = sceneNameToRef(currentSceneId, sceneRefRecords);
    const nextBase = baseSceneId.trim();
    const nextVariant = variantId.trim();
    if (
      nextBase !== currentRef.scene_id ||
      nextVariant !== currentRef.variant_id
    ) {
      const patch: BeatUpdate = {
        scene_ref: {
          scene_id: nextBase,
          variant_id: nextVariant,
        },
      };
      saveField({
        ...patch,
      });
    }
  };
  const baseSceneChoices = useMemo(() => {
    const set = new Set<string>();
    for (const record of sceneRefRecords) {
      if (record.time_of_day?.trim()) continue;
      const recordName = String(record.name || record.scene_id || "").trim();
      if (!recordName) continue;
      const ref = sceneNameToRef(recordName, sceneRefRecords);
      if (ref.scene_id) set.add(ref.scene_id);
    }
    if (currentSceneRef.scene_id) set.add(currentSceneRef.scene_id);
    return Array.from(set);
  }, [currentSceneRef.scene_id, sceneRefRecords]);
  const sceneVariantChoices = useMemo(() => {
    const set = new Set<string>();
    for (const record of sceneRefRecords) {
      if (record.time_of_day?.trim()) continue;
      const recordName = String(record.name || record.scene_id || "").trim();
      if (!recordName) continue;
      const ref = sceneNameToRef(recordName, sceneRefRecords);
      if (ref.scene_id === currentSceneRef.scene_id && ref.variant_id) {
        set.add(ref.variant_id);
      }
    }
    if (currentSceneRef.variant_id) set.add(currentSceneRef.variant_id);
    return Array.from(set);
  }, [currentSceneRef.scene_id, currentSceneRef.variant_id, sceneRefRecords]);

  // Latest-state ref — updated in useEffect (not during render) so the
  // unmount-flush cleanup reads values from the beat that was *committed*,
  // not values racing ahead of an incoming beat prop.
  const latestRef = useRef({
    narration,
    visual,
    sceneId,
    sceneRef: currentSceneRef,
    timeOfDay,
    speaker,
    identityIds: episodeIdentityIds,
    propIds: episodePropIds,
  });
  useEffect(() => {
    latestRef.current = {
      narration,
      visual,
      sceneId,
      sceneRef: currentSceneRef,
      timeOfDay,
      speaker,
      identityIds: episodeIdentityIds,
      propIds: episodePropIds,
    };
  });

  // Flush any dirty fields on beat switch / unmount.
  //
  // Everything the cleanup needs is *captured at setup time*. Previously we
  // stored `beat`, `update`, and `scope` in refs that were
  // reassigned during render — which meant the cleanup for beat N compared
  // beat N's form state against beat N+1's server snapshot, and PATCHed beat
  // N+1 with beat N's text. Capturing at setup binds the closure to the
  // right (project, episode, beatNumber) tuple.
  useEffect(() => {
    const capturedBeat = beat;
    const capturedScope = beatTextScope;
    const capturedMut = update;
    return () => {
      const latest = latestRef.current;
      const patches: BeatUpdate = {};
      const normalizedNarration = mentionsToProgramMarkers(latest.narration, {
        identities: latest.identityIds,
        props: latest.propIds,
      });
      const normalizedVisual = mentionsToProgramMarkers(latest.visual, {
        identities: latest.identityIds,
        props: latest.propIds,
      });
      const dirty = dirtyRef.current;
      if (dirty.narration && normalizedNarration !== (capturedBeat.narration_segment ?? ""))
        patches.narration_segment = normalizedNarration;
      if (dirty.visual && normalizedVisual !== (capturedBeat.visual_description ?? "")) {
        patches.visual_description = normalizedVisual;
        const markerIdentities = extractIdentityMarkers(normalizedVisual);
        const markerProps = extractPropMarkers(normalizedVisual);
        if (markerIdentities.length > 0) patches.detected_identities = markerIdentities;
        if (markerProps.length > 0) patches.detected_props = markerProps;
      }
      const capturedSceneId =
        sceneRefToName(capturedBeat.scene_ref) || capturedBeat.location || "";
      const capturedSceneRef = capturedBeat.scene_ref
        ? {
            scene_id: capturedBeat.scene_ref.scene_id || "",
            variant_id: capturedBeat.scene_ref.variant_id || "",
          }
        : { scene_id: capturedSceneId, variant_id: "" };
      if (
        dirty.sceneRef &&
        (latest.sceneRef.scene_id !== capturedSceneRef.scene_id ||
          latest.sceneRef.variant_id !== capturedSceneRef.variant_id)
      ) {
        patches.scene_ref = {
          scene_id: latest.sceneRef.scene_id,
          variant_id: latest.sceneRef.variant_id,
        };
      }
      if (dirty.timeOfDay && latest.timeOfDay !== (capturedBeat.time_of_day ?? ""))
        patches.time_of_day = latest.timeOfDay;
      if (dirty.speaker && latest.speaker !== (capturedBeat.speaker ?? ""))
        patches.speaker = latest.speaker;

      if (Object.keys(patches).length > 0) {
        // mutateAsync + trackSave — the promise chain survives unmount,
        // unlike inline mutate() callbacks which TanStack Query suppresses
        // once the observer unsubscribes.
        void trackSave(capturedScope, () =>
          capturedMut.mutateAsync({
            beatNum: capturedBeat.beat_number,
            data: patches,
          }),
        ).catch(() => {
          // Error state already written by trackSave; swallow the rejection.
        });
      }
    };
  }, [beat.beat_number]);

  const toggleIdentity = (id: string) => {
    const currentReal = identities.filter((x) => x && x !== NO_CHARACTER_MARKER);
    const next =
      id === NO_CHARACTER_MARKER
        ? [NO_CHARACTER_MARKER]
        : identities.includes(id)
          ? currentReal.filter((x) => x !== id)
          : [...currentReal, id];
    const normalized = next.length > 0 ? next : [NO_CHARACTER_MARKER];
    setIdentities(normalized);
    saveField({ detected_identities: normalized });
  };
  const toggleProp = (id: string) => {
    const currentReal = props.filter((x) => x && x !== NO_PROP_MARKER);
    const next =
      id === NO_PROP_MARKER
        ? [NO_PROP_MARKER]
        : props.includes(id)
          ? currentReal.filter((x) => x !== id)
          : [...currentReal, id];
    const normalized = next.length > 0 ? next : [NO_PROP_MARKER];
    setProps(normalized);
    saveField({ detected_props: normalized });
  };
  const hasIdentityDetectionState = identities.some((id) => id.trim());
  const mentionLabels = useMemo(
    () => [...episodeIdentityIds, ...episodePropIds],
    [episodeIdentityIds, episodePropIds],
  );
  // 徽章上显示的是 `角色名_时期`，时期名跟界面语言走（见 lib/identity-period）；
  // 落库的 detected_identities、@提及 token 用的都还是原 id，只有这层显示本地化。
  const identityBadgeLabels = useMemo(() => {
    const map: Record<string, string> = {
      [NO_CHARACTER_MARKER]: t("episode.workbench.text.noCharacter"),
    };
    for (const id of [...identityOptions, ...identities]) {
      if (id === NO_CHARACTER_MARKER) continue;
      map[id] = identityRefLabel(id, t);
    }
    return map;
  }, [identityOptions, identities, t]);
  const audioTypeOptions = useMemo(
    () =>
      spineTemplate === "narrated"
        ? (["narration", "dialogue"] as const)
        : (["silence", "narration", "dialogue"] as const),
    [spineTemplate],
  );
  const timeOfDayChoices = useMemo(
    () => timeOfDayOptions(timeOfDay, beat.time_of_day),
    [beat.time_of_day, timeOfDay],
  );
  return (
    <div className="space-y-3.5">
      {/* 台词 — full width */}
      <Field label={t("episode.workbench.text.narration")}>
        <MentionTextarea
          value={narration}
          onChange={(e) => {
            dirtyRef.current.narration = true;
            setNarration(e.target.value);
          }}
          onBlur={saveNarration}
          rows={2}
          mentionLabels={mentionLabels}
          placeholder={t("episode.workbench.text.narrationPlaceholder")}
          className={MENTION_TEXTAREA_CLASS}
          inputClassName={MENTION_TEXTAREA_INPUT_CLASS}
        />
      </Field>

      <MetadataSection>
        {/* 类型 + 场景 + 时间 — compact inline row */}
        <div className="col-span-full grid grid-cols-[auto_minmax(0,1fr)_minmax(7rem,12rem)_auto] gap-x-3 gap-y-3">
          <Field label={t("episode.workbench.text.type")}>
            <Select
              value={audioType}
              onValueChange={(v) => {
                const next = v ?? "narration";
                setAudioType(next);
                if (next !== (beat.audio_type ?? "narration")) {
                  const patch: BeatUpdate = { audio_type: next };
                  if ((spineTemplate !== "narrated" || next !== "dialogue") && speaker.trim()) {
                    patch.speaker = "";
                    setSpeaker("");
                  }
                  saveField(patch);
                }
              }}
            >
              <SelectTrigger
                aria-label={t("episode.workbench.text.type")}
                className={cn(COMPACT_CONTROL_CLASS, "w-full")}
              >
                <SelectValue>
                  {audioTypeLabel(t, audioType)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent
                align="start"
                alignItemWithTrigger={false}
                className={SELECT_POPUP_CLASS}
              >
                {audioTypeOptions.map((value) => (
                  <SelectItem
                    key={value}
                    value={value}
                    className={SELECT_ITEM_CLASS}
                  >
                    {audioTypeLabel(t, value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field
            label={t("episode.workbench.text.location")}
            action={
              sceneId.trim() ? (
                <button
                  type="button"
                  onClick={() => navigateToAsset("scene", sceneId.trim())}
                  className="inline-flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-primary"
                  title={t("assets.common.jumpToAsset", { name: sceneId.trim() })}
                >
                  <ArrowUpRight className="size-3" />
                </button>
              ) : undefined
            }
          >
            <Select
              value={currentSceneRef.scene_id || NO_SCENE_MARKER}
              onValueChange={(v) => {
                const nextBase = v === NO_SCENE_MARKER ? "" : (v ?? "");
                const nextSceneId = sceneNameForRef(nextBase, "");
                dirtyRef.current.sceneRef = true;
                setSceneId(nextSceneId);
                saveSceneRefValue(nextBase, "");
              }}
            >
              <SelectTrigger
                aria-label={t("episode.workbench.text.location")}
                className={cn(COMPACT_CONTROL_CLASS, "w-full")}
              >
                <SelectValue
                  placeholder={t("episode.workbench.text.locationPlaceholder")}
                >
                  {sceneId || t("episode.workbench.text.locationPlaceholder")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent
                align="start"
                alignItemWithTrigger={false}
                className={SELECT_POPUP_CLASS}
              >
                <SelectItem value={NO_SCENE_MARKER} className={SELECT_ITEM_CLASS}>
                  {t("episode.workbench.text.locationNone")}
                </SelectItem>
                {baseSceneChoices.map((id) => (
                  <SelectItem key={id} value={id} className={SELECT_ITEM_CLASS}>
                    {id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("episode.workbench.text.sceneVariant", { defaultValue: "变体" })}>
            <Select
              value={currentSceneRef.variant_id || NO_SCENE_VARIANT_MARKER}
              onValueChange={(v) => {
                const nextVariant =
                  v === NO_SCENE_VARIANT_MARKER ? "" : String(v ?? "");
                const nextSceneId = sceneNameForRef(
                  currentSceneRef.scene_id,
                  nextVariant,
                );
                dirtyRef.current.sceneRef = true;
                setSceneId(nextSceneId);
                saveSceneRefValue(currentSceneRef.scene_id, nextVariant);
              }}
              disabled={!currentSceneRef.scene_id}
            >
              <SelectTrigger
                aria-label={t("episode.workbench.text.sceneVariant", { defaultValue: "变体" })}
                className={cn(COMPACT_CONTROL_CLASS, "w-full")}
              >
                <SelectValue>
                  {currentSceneRef.variant_id ||
                    t("episode.workbench.text.noSceneVariant", {
                      defaultValue: "无变体",
                    })}
                </SelectValue>
              </SelectTrigger>
              <SelectContent
                align="start"
                alignItemWithTrigger={false}
                className={SELECT_POPUP_CLASS}
              >
                <SelectItem
                  value={NO_SCENE_VARIANT_MARKER}
                  className={SELECT_ITEM_CLASS}
                >
                  {t("episode.workbench.text.noSceneVariant", {
                    defaultValue: "无变体",
                  })}
                </SelectItem>
                {sceneVariantChoices.map((variant) => (
                  <SelectItem
                    key={variant}
                    value={variant}
                    className={SELECT_ITEM_CLASS}
                  >
                    {variant}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("episode.workbench.text.timeOfDay")}>
            <Select
              value={timeOfDay || NO_TIME_OF_DAY_MARKER}
              onValueChange={(v) => {
                const next = v === NO_TIME_OF_DAY_MARKER ? "" : (v ?? "");
                dirtyRef.current.timeOfDay = true;
                setTimeOfDay(next);
                if (next !== (beat.time_of_day ?? "")) {
                  saveField({ time_of_day: next });
                }
              }}
            >
              <SelectTrigger
                aria-label={t("episode.workbench.text.timeOfDay")}
                className={cn(COMPACT_CONTROL_CLASS, "w-full")}
              >
                <SelectValue
                  placeholder={t("episode.workbench.text.timeOfDayPlaceholder")}
                >
                  {timeOfDayLabel(timeOfDay, t)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent
                align="start"
                alignItemWithTrigger={false}
                className={SELECT_POPUP_CLASS}
              >
                <SelectItem
                  value={NO_TIME_OF_DAY_MARKER}
                  className={SELECT_ITEM_CLASS}
                >
                  {timeOfDayLabel("", t)}
                </SelectItem>
                {timeOfDayChoices.map((value) => (
                  <SelectItem key={value} value={value} className={SELECT_ITEM_CLASS}>
                    {timeOfDayLabel(value, t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        {scenePlateRender?.label ? (
          <p className="col-span-full rounded-[8px] border border-white/[0.08] bg-white/[0.025] px-3 py-2 text-xs text-muted-foreground">
            {scenePlateRender.label}
          </p>
        ) : null}

        {/* 画面描述 — full width */}
        <div className="col-span-full">
          <Field label={t("episode.workbench.text.visualDescription")}>
            <MentionTextarea
              value={visual}
              onChange={(e) => {
                dirtyRef.current.visual = true;
                setVisual(e.target.value);
              }}
              onBlur={saveVisual}
              rows={2}
              mentionLabels={mentionLabels}
              className={MENTION_TEXTAREA_CLASS}
              inputClassName={MENTION_TEXTAREA_INPUT_CLASS}
            />
          </Field>
        </div>

        {/* 出场身份 */}
        <div className="col-span-full">
          <Field label={t("episode.workbench.text.identities")}>
            <IdentityBadgeGroup
              options={identityOptions}
              selected={identities}
              onToggle={toggleIdentity}
              onJump={(id) => navigateToAsset("identity", id)}
              noJumpIds={[NO_CHARACTER_MARKER]}
              labels={identityBadgeLabels}
              jumpLabel={t("assets.common.jumpToAsset", { name: "" }).trim()}
              emptyMessage={t("episode.workbench.text.identitiesNotPlanned")}
              ariaLabel={t("episode.workbench.text.identities")}
              removedLabel={t("common.removed")}
            />
            {!hasIdentityDetectionState ? (
              <p className="mt-1 text-xs text-amber-300/90">
                {t("episode.workbench.text.identityDetectionRequired")}
              </p>
            ) : null}
          </Field>
        </div>

        {/* 出场道具 */}
        <div className="col-span-full">
          <Field label={t("episode.workbench.text.props")}>
            <IdentityBadgeGroup
              options={propOptions}
              selected={props}
              onToggle={toggleProp}
              onJump={(id) => navigateToAsset("prop", id)}
              noJumpIds={[NO_PROP_MARKER]}
              labels={{
                [NO_PROP_MARKER]: t("episode.workbench.text.noProp"),
              }}
              jumpLabel={t("assets.common.jumpToAsset", { name: "" }).trim()}
              emptyMessage={t("episode.workbench.text.propsNotPlanned")}
              ariaLabel={t("episode.workbench.text.props")}
              removedLabel={t("common.removed")}
            />
          </Field>
        </div>

        {audioType === "dialogue" && spineTemplate === "narrated" ? (
          <Field label={t("episode.workbench.text.speaker")}>
            <Select
              value={
                episodeIdentityIds.includes(speaker)
                  ? speaker
                  : NO_SPEAKER_MARKER
              }
              onValueChange={(value) => {
                const next = value === NO_SPEAKER_MARKER ? "" : String(value ?? "");
                dirtyRef.current.speaker = true;
                setSpeaker(next);
                if (next !== (beat.speaker ?? "")) {
                  saveField({ speaker: next });
                }
              }}
            >
              <SelectTrigger
                aria-label={t("episode.workbench.text.speaker")}
                className={cn(COMPACT_CONTROL_CLASS, "w-full")}
              >
                <SelectValue
                  placeholder={t("episode.workbench.text.speakerRequired")}
                >
                  {episodeIdentityIds.includes(speaker)
                    ? speaker
                    : t("episode.workbench.text.speakerRequired")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent
                align="start"
                alignItemWithTrigger={false}
                className={SELECT_POPUP_CLASS}
              >
                {episodeIdentityIds.length === 0 ? (
                  <SelectItem
                    value={NO_SPEAKER_MARKER}
                    className={SELECT_ITEM_CLASS}
                  >
                    {t("episode.workbench.text.speakerRequired")}
                  </SelectItem>
                ) : null}
                {episodeIdentityIds.map((id) => (
                  <SelectItem key={id} value={id} className={SELECT_ITEM_CLASS}>
                    {identityRefLabel(id, t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : audioType === "narration" && spineTemplate === "narrated" ? (
          <Field label={t("episode.workbench.text.narrator")}>
            <div
              className={cn(
                COMPACT_CONTROL_CLASS,
                "flex items-center text-muted-foreground/90",
              )}
            >
              {t("episode.workbench.text.projectNarrator")}
            </div>
          </Field>
        ) : null}
      </MetadataSection>
    </div>
  );
}

function Field({
  label,
  action,
  children,
}: {
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="truncate text-[12px] font-medium leading-none text-muted-foreground/82">
          {label}
        </Label>
        {action}
      </div>
      {children}
    </div>
  );
}

function IdentityBadgeGroup({
  options,
  selected,
  onToggle,
  onJump,
  jumpLabel,
  noJumpIds,
  labels,
  emptyMessage,
  ariaLabel,
  removedLabel,
}: {
  options: string[];
  selected: string[];
  onToggle: (id: string) => void;
  onJump?: (id: string) => void;
  jumpLabel?: string;
  noJumpIds?: string[];
  labels?: Record<string, string>;
  emptyMessage: string;
  ariaLabel: string;
  removedLabel: string;
}) {
  if (options.length === 0) {
    return (
      <p
        role="status"
        className="rounded-[8px] border border-dashed border-white/[0.09] bg-white/[0.018] px-3 py-2.5 text-[13px] text-muted-foreground/70"
      >
        {emptyMessage}
      </p>
    );
  }

  const seen = new Set<string>();
  const noJump = new Set(noJumpIds ?? []);
  const ordered: { id: string; stale: boolean }[] = [];
  for (const id of options) {
    if (!seen.has(id)) {
      ordered.push({ id, stale: false });
      seen.add(id);
    }
  }
  for (const id of selected) {
    if (!seen.has(id)) {
      ordered.push({ id, stale: true });
      seen.add(id);
    }
  }

  return (
    <div role="group" aria-label={ariaLabel} className="flex flex-wrap gap-1.5">
      {ordered.map(({ id, stale }) => {
        const isSelected = selected.includes(id);
        const label = labels?.[id] ?? id;
        return (
          <span
            key={id}
            className={cn(
              "flex items-center gap-1.5 rounded-[8px] border px-2.5 py-1.5 text-[12px] transition-colors",
              isSelected
                ? stale
                  ? "border-destructive/45 bg-destructive/[0.07] text-foreground/82"
                  : "border-primary/65 bg-primary/[0.07] text-foreground/86"
                : "border-white/[0.09] bg-white/[0.018] text-muted-foreground/70 hover:border-white/[0.16] hover:text-foreground/78",
            )}
          >
            <button
              type="button"
              aria-pressed={isSelected}
              onClick={() => onToggle(id)}
              className="flex items-center gap-1.5 hover:opacity-80"
            >
              {label}
              {stale && isSelected ? (
                <span className="text-xs text-destructive">{removedLabel}</span>
              ) : null}
            </button>
            {onJump && !noJump.has(id) ? (
              <button
                type="button"
                aria-label={jumpLabel}
                title={jumpLabel}
                onClick={() => onJump(id)}
                className="text-muted-foreground transition-colors hover:text-primary"
              >
                <ArrowUpRight className="size-3" />
              </button>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

function MetadataSection({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-4 border-t border-white/[0.06] pt-4">
      {children}
    </div>
  );
}
