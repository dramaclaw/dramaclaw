// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MentionTextarea } from "@/components/episode/beat-workbench/mention-textarea";
import {
  GLASS_DIALOG_CONTENT_CLASS,
  TRANSPARENT_DIALOG_FOOTER_CLASS,
} from "@/lib/dialog-styles";
import { cn } from "@/lib/utils";
import { useEpisodeBeats, useEpisodeDetail, useInsertManualShot } from "@/lib/queries/episodes";
import {
  extractIdentityMarkers,
  extractPropMarkers,
  mentionsToProgramMarkers,
  programMarkersToMentions,
} from "@/lib/mention-markers";
import { sceneNameToRef, sceneRefToName } from "@/lib/scene-ref";
import { timeOfDayLabel, timeOfDayOptions } from "@/lib/time-of-day";

interface InsertManualShotDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  project: string;
  episode: number;
  spineTemplate?: "drama" | "narrated";
  /** null ⇒ insert before the first beat. */
  afterBeatNumber: number | null;
  onInserted?: () => void;
}

const DEFAULT_DURATION = 3;
type ManualShotAudioType = "silence" | "narration" | "dialogue";

const NONE_SENTINEL = "__none__";
const NO_VARIANT_SENTINEL = "__NO_SCENE_VARIANT__";
const NO_SPEAKER_MARKER = "__NO_SPEAKER__";
const FIELD_SURFACE_CLASS =
  "!rounded-[8px] !border-white/10 bg-white/[0.025] focus-within:!border-primary/45 focus-within:!ring-0 focus-visible:!border-primary/45 focus-visible:!ring-0";
const INPUT_CLASS = `h-8 text-xs ${FIELD_SURFACE_CLASS}`;
const TEXTAREA_CLASS =
  `!block !w-full !resize-none ${FIELD_SURFACE_CLASS}`;
const TEXTAREA_INPUT_CLASS = "px-2.5 py-2 text-xs placeholder:!text-xs";
const SELECT_POPUP_CLASS = "max-h-72 p-1";
const SELECT_ITEM_CLASS = "py-1.5";
// Backend validators still require a non-empty visual_description string.
// Use an invisible placeholder so the inserted beat remains visually empty.
const EMPTY_MANUAL_SHOT_VISUAL_DESCRIPTION = "\u200B";

/**
 * Manual-shot insertion dialog. Mirrors the NiceGUI form at
 * sketch_studio.py:_open_insert_manual_shot_dialog — the BE wrapper
 * is `POST /beats/insert-manual` (see novelvideo.manual_shots.insert_manual_shot).
 *
 * Layout: visual description is the primary full-width input. Read-only
 * behavior notes use info blocks, while duration / scene / time / identities
 * are grouped as shot settings. Manual insertion creates an empty beat
 * container by default: content fields are intentionally not inherited from
 * neighboring beats.
 */
export function InsertManualShotDialog({
  open,
  onOpenChange,
  project,
  episode,
  spineTemplate = "drama",
  afterBeatNumber,
  onInserted,
}: InsertManualShotDialogProps) {
  const { t } = useTranslation();
  const insertMutation = useInsertManualShot(project, episode);

  const beatsQuery = useEpisodeBeats(project, episode);
  const episodeQuery = useEpisodeDetail(project, episode);

  const allBeats = useMemo(
    () => beatsQuery.data?.data ?? [],
    [beatsQuery.data],
  );

  const sceneRefRecords = useMemo(
    () =>
      (episodeQuery.data?.data?.scene_menu ?? []).map((item) => ({
        scene_id: item.scene_id,
        base_scene_id: item.base_scene_id,
        variant_id: item.variant_id,
        time_of_day: item.time_of_day,
      })),
    [episodeQuery.data],
  );
  const locationOptions = useMemo(() => {
    const set = new Set<string>();
    for (const item of episodeQuery.data?.data?.scene_menu ?? []) {
      const sceneId = item.scene_id?.trim();
      if (!sceneId) continue;
      const ref = sceneNameToRef(sceneId, sceneRefRecords);
      if (ref.scene_id) set.add(ref.scene_id);
    }
    for (const b of allBeats) {
      const loc = (sceneRefToName(b.scene_ref) || b.location || "").trim();
      if (!loc) continue;
      const ref = sceneNameToRef(loc, sceneRefRecords);
      if (ref.scene_id) set.add(ref.scene_id);
    }
    return Array.from(set);
  }, [allBeats, episodeQuery.data, sceneRefRecords]);

  const locationChoices = useMemo(() => {
    return Array.from(new Set(locationOptions));
  }, [locationOptions]);
  const episodeIdentityIds = useMemo(
    () => episodeQuery.data?.data?.identity_ids ?? [],
    [episodeQuery.data],
  );
  const isNarratedProject = spineTemplate === "narrated";

  const [visual, setVisual] = useState("");
  const [location, setLocation] = useState("");
  const [locationVariant, setLocationVariant] = useState("");
  const [timeOfDay, setTimeOfDay] = useState("");
  const [duration, setDuration] = useState<number>(DEFAULT_DURATION);
  const [audioType, setAudioType] = useState<ManualShotAudioType>("silence");
  const [narrationText, setNarrationText] = useState("");
  const [speaker, setSpeaker] = useState("");
  const [identitiesText, setIdentitiesText] = useState("");
  const [propsText, setPropsText] = useState("");
  const [identityManuallyEdited, setIdentityManuallyEdited] = useState(false);
  const [propsManuallyEdited, setPropsManuallyEdited] = useState(false);
  const timeChoices = useMemo(() => timeOfDayOptions(timeOfDay), [timeOfDay]);
  const locationVariantChoices = useMemo(() => {
    const set = new Set<string>();
    for (const record of sceneRefRecords) {
      if (record.time_of_day?.trim()) continue;
      const recordName = String(record.scene_id || "").trim();
      if (!recordName) continue;
      const ref = sceneNameToRef(recordName, sceneRefRecords);
      if (ref.plate_time_of_day) continue;
      if (ref.scene_id === location && ref.variant_id) set.add(ref.variant_id);
    }
    return Array.from(set);
  }, [location, sceneRefRecords]);

  // Reset once per open. Guard against background query refetches so typed
  // content is never wiped mid-edit.
  const prefilledRef = useRef(false);
  useEffect(() => {
    if (!open) {
      prefilledRef.current = false;
      return;
    }
    if (prefilledRef.current) return;
    setVisual("");
    setLocation("");
    setLocationVariant("");
    setTimeOfDay("");
    setDuration(DEFAULT_DURATION);
    setAudioType("silence");
    setNarrationText("");
    setSpeaker("");
    setIdentitiesText("");
    setPropsText("");
    setIdentityManuallyEdited(false);
    setPropsManuallyEdited(false);
    prefilledRef.current = true;
  }, [open]);

  const titleText =
    afterBeatNumber === null
      ? t("episode.workbench.insertManual.titleBeforeFirst")
      : t("episode.workbench.insertManual.titleAfter", { n: afterBeatNumber });

  const submit = async () => {
    const trimmedVisual = visual.trim();
    const trimmedNarration = narrationText.trim();
    const trimmedSpeaker = speaker.trim();
    const selectedSpeaker = isNarratedProject
      ? episodeIdentityIds.includes(trimmedSpeaker)
        ? trimmedSpeaker
        : ""
      : "";
    if (audioType !== "silence" && !trimmedNarration) {
      toast.error(t("episode.workbench.insertManual.narrationRequired"));
      return;
    }
    if (isNarratedProject && audioType === "dialogue" && !selectedSpeaker) {
      toast.error(t("episode.workbench.insertManual.speakerRequired"));
      return;
    }
    const selectedLocation = location.trim();
    const selectedVariant = locationVariant.trim();
    const identityOptions = episodeIdentityIds;
    const propOptions = (episodeQuery.data?.data?.prop_menu ?? []).map(
      (item) => item.prop_id,
    );
    const normalizedVisual = mentionsToProgramMarkers(trimmedVisual, {
      identities: identityOptions,
      props: propOptions,
    });
    const submittedVisual =
      normalizedVisual.trim().length > 0
        ? normalizedVisual
        : EMPTY_MANUAL_SHOT_VISUAL_DESCRIPTION;
    const identityList = identitiesText
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const propList = propsText
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const detectedIdentities =
      identityList.length > 0 ? identityList : extractIdentityMarkers(normalizedVisual);
    const detectedProps =
      propList.length > 0 ? propList : extractPropMarkers(normalizedVisual);
    try {
      const selectedSceneRef = selectedLocation
        ? { scene_id: selectedLocation, variant_id: selectedVariant }
        : null;
      const res = await insertMutation.mutateAsync({
        after_beat_number: afterBeatNumber,
        visual_description: submittedVisual,
        duration_seconds: duration > 0 ? duration : DEFAULT_DURATION,
        scene_ref: selectedSceneRef,
        time_of_day: timeOfDay.trim() || null,
        detected_identities: detectedIdentities.length > 0 ? detectedIdentities : null,
        detected_props: detectedProps.length > 0 ? detectedProps : null,
        audio_type: audioType,
        speaker: isNarratedProject && audioType === "dialogue" ? selectedSpeaker : null,
        narration_segment: audioType === "silence" ? null : trimmedNarration,
      });
      if (res.ok === false) {
        toast.error(res.error || t("common.error"));
        return;
      }
      toast.success(t("episode.workbench.insertManual.success"));
      onOpenChange(false);
      onInserted?.();
    } catch {
      toast.error(t("common.error"));
    }
  };

  const submitting = insertMutation.isPending;

  // Identity placeholder hints the BE auto-extracts from {{role_identity}}
  // markers in the visual description when the field is left blank.
  const placeholderIdentities = episodeQuery.data?.data?.identity_ids
    ?.slice(0, 2)
    .join(", ");
  const placeholderProps = episodeQuery.data?.data?.prop_menu
    ?.map((item) => item.prop_id)
    .slice(0, 2)
    .join(", ");
  const mentionLabels = useMemo(
    () => [
      ...episodeIdentityIds,
      ...(episodeQuery.data?.data?.prop_menu ?? []).map((item) => item.prop_id),
    ],
    [episodeIdentityIds, episodeQuery.data],
  );
  const normalizeVisualInput = (next: string) => {
    const displayText = programMarkersToMentions(next);
    setVisual(displayText);
    const identityOptions = episodeIdentityIds;
    const propOptions = (episodeQuery.data?.data?.prop_menu ?? []).map(
      (item) => item.prop_id,
    );
    const normalized = mentionsToProgramMarkers(displayText, {
      identities: identityOptions,
      props: propOptions,
    });
    const detectedIdentities = extractIdentityMarkers(normalized);
    const detectedProps = extractPropMarkers(normalized);
    if (!identityManuallyEdited) {
      setIdentitiesText(detectedIdentities.join(", "));
    }
    if (!propsManuallyEdited) {
      setPropsText(detectedProps.join(", "));
    }
  };
  const selectedSpeakerValue = episodeIdentityIds.includes(speaker)
    ? speaker
    : NO_SPEAKER_MARKER;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn(GLASS_DIALOG_CONTENT_CLASS, "ring-white/10 sm:max-w-2xl")}>
        <DialogHeader>
          <DialogTitle>{titleText}</DialogTitle>
        </DialogHeader>

        <div className="grid max-h-[75vh] gap-5 overflow-y-auto pr-1">
          <Field
            label={t("episode.workbench.insertManual.visualDescription")}
          >
            <MentionTextarea
              value={visual}
              onChange={(e) => normalizeVisualInput(e.target.value)}
              rows={4}
              placeholder={t("episode.workbench.insertManual.visualPlaceholder")}
              mentionLabels={mentionLabels}
              className={TEXTAREA_CLASS}
              inputClassName={TEXTAREA_INPUT_CLASS}
              autoFocus
            />
          </Field>

          <div className="grid gap-4 md:grid-cols-[minmax(0,220px)_1fr]">
            <Field label={t("episode.workbench.insertManual.audioType")}>
              <div className="grid grid-cols-3 gap-1 rounded-[8px] border border-white/10 bg-white/[0.025] p-1">
                {(["silence", "narration", "dialogue"] as const).map((value) => (
                  <Button
                    key={value}
                    type="button"
                    variant={audioType === value ? "secondary" : "ghost"}
                    size="sm"
                    className="h-7 rounded-[6px] px-2 text-xs"
                    onClick={() => setAudioType(value)}
                  >
                    {t(`episode.workbench.insertManual.audioType${value[0].toUpperCase()}${value.slice(1)}`)}
                  </Button>
                ))}
              </div>
            </Field>

            {audioType !== "silence" ? (
              <Field
                label={t("episode.workbench.insertManual.narration")}
                required
              >
                <Textarea
                  value={narrationText}
                  onChange={(e) => setNarrationText(e.target.value)}
                  rows={2}
                  placeholder={t("episode.workbench.insertManual.narrationPlaceholder")}
                  className={`min-h-[64px] resize-none ${TEXTAREA_CLASS} ${TEXTAREA_INPUT_CLASS}`}
                />
              </Field>
            ) : (
              <InfoBlock
                label={t("episode.workbench.insertManual.narration")}
                value={t("episode.workbench.insertManual.silentHint")}
              />
            )}
          </div>

          {audioType === "dialogue" && isNarratedProject ? (
            <Field label={t("episode.workbench.insertManual.speaker")} required>
              <Select
                value={selectedSpeakerValue}
                onValueChange={(value) => {
                  setSpeaker(
                    value === NO_SPEAKER_MARKER ? "" : String(value ?? ""),
                  );
                }}
              >
                <SelectTrigger
                  aria-label={t("episode.workbench.insertManual.speaker")}
                  className={`h-8 w-full text-xs ${FIELD_SURFACE_CLASS}`}
                >
                  <SelectValue
                    placeholder={t("episode.workbench.insertManual.speakerRequired")}
                  >
                    {episodeIdentityIds.includes(speaker)
                      ? speaker
                      : t("episode.workbench.insertManual.speakerRequired")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent
                  align="start"
                  alignItemWithTrigger={false}
                  className={SELECT_POPUP_CLASS}
                >
                  <SelectItem
                    value={NO_SPEAKER_MARKER}
                    className={SELECT_ITEM_CLASS}
                    disabled={episodeIdentityIds.length > 0}
                  >
                    {t("episode.workbench.insertManual.speakerRequired")}
                  </SelectItem>
                  {episodeIdentityIds.map((identityId) => (
                    <SelectItem
                      key={identityId}
                      value={identityId}
                      className={SELECT_ITEM_CLASS}
                    >
                      {identityId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : audioType === "narration" && isNarratedProject ? (
            <InfoBlock
              label={t("episode.workbench.insertManual.narrator")}
              value={t("episode.workbench.insertManual.projectNarrator")}
            />
          ) : null}

          <div className="grid gap-4 md:grid-cols-4">
            <Field label={t("episode.workbench.insertManual.duration")}>
              <Input
                type="number"
                min={0.5}
                step={0.5}
                value={Number.isFinite(duration) ? duration : ""}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setDuration(Number.isFinite(v) && v > 0 ? v : 0);
                }}
                className={INPUT_CLASS}
              />
            </Field>

            <Field label={t("episode.workbench.insertManual.location")}>
              <Select
                value={location || NONE_SENTINEL}
                onValueChange={(v) => {
                  setLocation(v === NONE_SENTINEL ? "" : (v ?? ""));
                  setLocationVariant("");
                }}
              >
                <SelectTrigger
                  aria-label={t("episode.workbench.insertManual.location")}
                  className={`h-8 w-full text-xs ${FIELD_SURFACE_CLASS}`}
                >
                  <SelectValue
                    placeholder={t("episode.workbench.insertManual.locationPlaceholder")}
                  >
                    {location || t("episode.workbench.insertManual.locationPlaceholder")}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE_SENTINEL}>
                    {t("episode.workbench.insertManual.locationNone")}
                  </SelectItem>
                  {locationChoices.map((loc) => (
                    <SelectItem key={loc} value={loc}>
                      {loc}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field
              label={t("episode.workbench.insertManual.sceneVariant", {
                defaultValue: "变体",
              })}
            >
              <Select
                value={locationVariant || NO_VARIANT_SENTINEL}
                onValueChange={(v) =>
                  setLocationVariant(
                    v === NO_VARIANT_SENTINEL ? "" : String(v ?? ""),
                  )
                }
                disabled={!location}
              >
                <SelectTrigger
                  aria-label={t("episode.workbench.insertManual.sceneVariant", {
                    defaultValue: "变体",
                  })}
                  className={`h-8 w-full text-xs ${FIELD_SURFACE_CLASS}`}
                >
                  <SelectValue>
                    {locationVariant ||
                      t("episode.workbench.insertManual.noSceneVariant", {
                        defaultValue: "无变体",
                      })}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_VARIANT_SENTINEL}>
                    {t("episode.workbench.insertManual.noSceneVariant", {
                      defaultValue: "无变体",
                    })}
                  </SelectItem>
                  {locationVariantChoices.map((variant) => (
                    <SelectItem key={variant} value={variant}>
                      {variant}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label={t("episode.workbench.insertManual.timeOfDay")}>
              <Select
                value={timeOfDay || NONE_SENTINEL}
                onValueChange={(v) =>
                  setTimeOfDay(v === NONE_SENTINEL ? "" : (v ?? ""))
                }
              >
                <SelectTrigger
                  aria-label={t("episode.workbench.insertManual.timeOfDay")}
                  className={`h-8 w-full text-xs ${FIELD_SURFACE_CLASS}`}
                >
                  <SelectValue
                    placeholder={t("episode.workbench.insertManual.timeOfDayPlaceholder")}
                  >
                    {timeOfDayLabel(timeOfDay, t)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE_SENTINEL}>
                    {timeOfDayLabel("", t)}
                  </SelectItem>
                  {timeChoices.map((tod) => (
                    <SelectItem key={tod} value={tod}>
                      {timeOfDayLabel(tod, t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <InfoBlock
              label={t("episode.workbench.insertManual.type")}
              value={t("episode.workbench.insertManual.typeManual")}
            />

            <Field label={t("episode.workbench.insertManual.identities")}>
              <Input
                value={identitiesText}
                onChange={(e) => {
                  setIdentityManuallyEdited(true);
                  setIdentitiesText(e.target.value);
                }}
                placeholder={
                  placeholderIdentities
                    ? t("episode.workbench.insertManual.identitiesPlaceholder", {
                        example: placeholderIdentities,
                      })
                    : t("episode.workbench.insertManual.identitiesPlaceholderEmpty")
                }
                className={INPUT_CLASS}
              />
            </Field>

            <Field
              label={t("episode.workbench.insertManual.props", {
                defaultValue: "出场道具",
              })}
            >
              <Input
                value={propsText}
                onChange={(e) => {
                  setPropsManuallyEdited(true);
                  setPropsText(e.target.value);
                }}
                placeholder={
                  placeholderProps
                    ? t("episode.workbench.insertManual.propsPlaceholder", {
                        example: placeholderProps,
                        defaultValue: "逗号分隔，如 {{example}}；留空自动从画面描述提取",
                      })
                    : t("episode.workbench.insertManual.propsPlaceholderEmpty", {
                        defaultValue: "逗号分隔道具ID；留空自动从画面描述提取",
                      })
                }
                className={INPUT_CLASS}
              />
            </Field>
          </div>
        </div>

        <DialogFooter className={TRANSPARENT_DIALOG_FOOTER_CLASS}>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t("common.cancel")}
          </Button>
          <Button
            onClick={submit}
          disabled={submitting}
          >
            {submitting && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
            {t("episode.workbench.insertManual.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <Label className="text-xs font-medium text-muted-foreground">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
      {children}
    </div>
  );
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-2">
      <Label className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      <div className="flex min-h-8 items-center rounded-[8px] border border-white/10 bg-white/[0.025] px-2.5 py-1 text-xs text-muted-foreground">
        {value}
      </div>
    </div>
  );
}
