// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Download,
  Film,
  ChevronDown,
  Image as ImageIcon,
  Library,
  Loader2,
  Mic,
  RefreshCw,
  Scissors,
  Settings2,
  Square,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from "lucide-react";

import {
  useCropSeedance2Asset,
  useDeleteSeedance2Asset,
  useGenerateBeatVideoPrompt,
  useGenerateSeedance2Prompt,
  useRegenerateBeatVideo,
  useUploadSeedance2Asset,
  useSeedance2BeatStatus,
  useTrimSeedance2Asset,
  useVideoBackends,
  useVideoPool,
  useVideoPoolSelect,
  type Seedance2BeatStatus,
  type VideoBackendOption,
  type VideoInputCropTarget,
} from "@/lib/queries/video";
import {
  backendErrorToastMessage,
  BillingRuleNotConfiguredError,
} from "@/lib/api-errors";
import { resolveMediaUrl } from "@/lib/media-url";
import { centerCropBoxForRatio, ratioToCss, zoomCropBox } from "@/lib/aspect-ratio";
import { useProjectAspectRatio } from "@/stores/aspect-ratio-store";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/format-relative-time";
import { useNow } from "@/hooks/use-now";
import { useTaskController } from "@/hooks/use-task-controller";
import { queryKeys } from "@/lib/query-keys";
import { normalizeMentionSeparatorSpaces } from "@/lib/mention-markers";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { CreditCostInline } from "@/components/credit-cost-inline";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MentionTextarea } from "@/components/episode/beat-workbench/mention-textarea";
import {
  buildSeedance2LabelIdentityMaps,
  remapSeedance2Mentions,
  sameSeedance2LabelIdentity,
  type Seedance2LabelIdentityMaps,
} from "@/components/episode/beat-workbench/seedance2-mentions";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { useUpdateBeat } from "@/lib/queries/scripts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { BeatStageState } from "@/types/beat-state";
import type { Beat } from "@/types/episode";
import {
  MEDIA_PRIMARY_ACTION_BUTTON_CLASS,
  MEDIA_THUMB_ACTIVE_CLASS,
  MEDIA_THUMB_ACTIVE_MARK_CLASS,
  MEDIA_THUMB_CLASS,
  MEDIA_THUMB_IDLE_CLASS,
  MEDIA_THUMB_TIME_CLASS,
} from "./media-styles";

const SEEDANCE2_REFERENCE_DRAG_TYPE =
  "application/x-supertale-seedance2-reference";
const SEEDANCE2_PROMPT_GUIDANCE_TEMPLATES = [
  {
    key: "subject",
    labelKey: "seedance2GuidanceSubject",
    text: "主体：明确画面核心人物或物体、当前动作和状态，避免多个主体争抢焦点。",
  },
  {
    key: "scene",
    labelKey: "seedance2GuidanceScene",
    text: "场景：补充空间背景、地点关系、关键道具和环境材质，保持与参考图一致。",
  },
  {
    key: "lighting",
    labelKey: "seedance2GuidanceLighting",
    text: "光影：描述主光源、明暗层次、色温和氛围，避免忽明忽暗。",
  },
  {
    key: "camera",
    labelKey: "seedance2GuidanceCamera",
    text: "镜头：说明景别、视角、运镜速度和运动方向，保持镜头运动清晰可执行。",
  },
  {
    key: "style",
    labelKey: "seedance2GuidanceStyle",
    text: "风格：限定画面质感、时代感、色彩倾向和真实度，避免风格漂移。",
  },
  {
    key: "no_subtitle",
    labelKey: "seedance2GuidanceNoSubtitle",
    text: "无字幕：避免生成任何文字或字幕，保持画面纯净。",
  },
] as const;
const VIDEO_GRID_CLASS =
  "grid grid-cols-[auto_minmax(260px,1fr)] items-start gap-x-4 gap-y-3";
const VIDEO_PREVIEW_CLASS =
  "relative flex h-[220px] w-auto max-w-full justify-self-start items-center justify-center overflow-hidden rounded-[10px] border border-white/[0.075] bg-white/[0.022]";
const VIDEO_CANDIDATES_CLASS =
  "flex max-h-[220px] flex-wrap content-start gap-2 overflow-y-auto pr-1";
const SEEDANCE2_CONTROL_CLASS =
  "rounded-[8px] border-white/[0.095] bg-white/[0.025] text-sm shadow-none focus-visible:border-white/[0.16] focus-visible:ring-white/10 dark:border-white/[0.095] dark:bg-white/[0.025]";
const VIDEO_PARAM_CONTROL_CLASS =
  "!h-[30px] rounded-[7px] border border-white/[0.13] bg-white/[0.018] px-2.5 text-[12px] font-normal leading-none text-foreground/86 shadow-none transition-colors hover:border-white/[0.22] hover:bg-white/[0.035] focus-visible:border-white/[0.24] focus-visible:ring-white/10 dark:border-white/[0.13] dark:bg-white/[0.018] [&>svg]:size-3.5";
const VIDEO_PARAM_ACTION_CLASS =
  "!h-[30px] gap-1.5 rounded-[7px] border border-white/[0.13] bg-white/[0.018] px-2.5 text-[12px] font-normal leading-none text-foreground/86 shadow-none transition-[background-color,border-color,color,transform] hover:border-white/[0.22] hover:bg-white/[0.035] hover:text-foreground active:scale-95 disabled:border-white/[0.07] disabled:bg-white/[0.012] disabled:text-muted-foreground/45 dark:border-white/[0.13] dark:bg-white/[0.018] dark:hover:bg-white/[0.035] [&_svg]:size-3.5";
const SEEDANCE2_TEXTAREA_CLASS =
  "rounded-[8px] border-white/[0.095] bg-white/[0.025] text-sm shadow-none focus-visible:border-white/[0.16] focus-visible:ring-white/10 dark:border-white/[0.095] dark:bg-white/[0.025]";
const SEEDANCE2_SECONDARY_ACTION_CLASS =
  "h-7 gap-1 rounded-[7px] border-white/[0.11] bg-white/[0.03] px-2.5 text-[12px] font-normal text-foreground/76 shadow-none hover:border-white/[0.18] hover:bg-white/[0.055] hover:text-foreground disabled:border-white/[0.07] disabled:bg-white/[0.018] disabled:text-muted-foreground/45 dark:border-white/[0.11] dark:bg-white/[0.03]";
const SEEDANCE2_PILL_ACTION_CLASS =
  "h-6 rounded-full border border-white/[0.075] bg-white/[0.018] px-2 text-[11px] font-normal text-muted-foreground/78 shadow-none hover:border-white/[0.14] hover:bg-white/[0.04] hover:text-foreground";
const SEEDANCE2_SEGMENTED_OPTION_CLASS =
  "h-7 rounded-[7px] border px-1.5 text-xs font-normal shadow-none transition-[background-color,border-color,color] duration-150";
const SEEDANCE2_COLLAPSE_TRIGGER_CLASS =
  "-ml-1 h-6 gap-1.5 px-1 text-xs font-medium text-foreground/78 !bg-transparent hover:!bg-transparent hover:text-foreground aria-expanded:!bg-transparent dark:hover:!bg-transparent";
const SEEDANCE2_DEFAULT_RESOLUTION_OPTIONS = ["480p", "720p"] as const;
const HAPPYHORSE_RESOLUTION_OPTIONS = ["720p", "1080p"] as const;
const HAPPYHORSE_RATIO_OPTIONS = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;
const GROK_VIDEO_RESOLUTION_OPTIONS = ["720p", "480p"] as const;
const GROK_VIDEO_RATIO_OPTIONS = ["16:9", "9:16", "1:1", "2:3", "3:2"] as const;
const SEEDANCE2_RESOLUTION_OPTIONS_BY_MODEL = {
  "seedance-2.0-fast": ["480p", "720p"],
  "seedance-2.0": ["480p", "720p", "1080p"],
  "seedance-2.0-value": ["720p", "1080p"],
  "seedance-2.0-fast-value": ["720p", "1080p"],
  // Seedance 1.5 Pro（有声）清晰度，来源 huimengi /api/v1/models
  "seedance-1.5-pro": ["480p", "720p", "1080p"],
} as const;

type Seedance2Resolution = "480p" | "720p" | "1080p";
type HappyHorseRatio = (typeof HAPPYHORSE_RATIO_OPTIONS)[number];
type GrokVideoRatio = (typeof GROK_VIDEO_RATIO_OPTIONS)[number];

interface Seedance2DurationBounds {
  min: number;
  max: number;
}

interface VideoPaneProps {
  beat: Beat;
  project: string;
  episode: number;
  state: BeatStageState;
  /** Episode-level video backend selected in the video panel. */
  defaultBackend: string;
  showAudioMediaStatus?: boolean;
}

interface Seedance2ConfigDraft {
  raw: Record<string, unknown>;
  mode: "first_frame" | "first_last_frame" | "multimodal_reference";
  mode_user_set: boolean;
  duration: number;
  resolution: Seedance2Resolution;
  ratio: "9:16" | "16:9" | "1:1" | "4:3" | "3:4" | "21:9" | "2:3" | "3:2";
  generate_audio: boolean;
  generate_audio_user_set: boolean;
  return_last_frame: boolean;
  scene_optimize: "" | "anime" | "realistic";
  human_review: boolean;
  human_review_user_set: boolean;
  prompt_source: string;
  prompt_guidance: string;
  final_prompt: string;
  text_overlay: {
    enabled: boolean;
    kind: string;
    content: string;
    placement: string;
    timing: string;
    style: string;
    speaker: string;
  };
}

type Seedance2ReferenceField = "prompt_guidance" | "final_prompt";
type Seedance2CropAspect = Seedance2ConfigDraft["ratio"];

const SEEDANCE2_AUTOSAVE_DELAY_MS = 800;

type Seedance2AssetItem = Seedance2BeatStatus["assets"]["items"][number];
type Seedance2CropIntent = {
  asset: Seedance2AssetItem;
  target: VideoInputCropTarget;
};

export function shouldDisableDialogueOnlyBackendForBeat(
  backend: { dialogue_only?: boolean },
  beat: Pick<Beat, "audio_type">,
): boolean {
  if (!backend.dialogue_only) return false;
  return String(beat.audio_type ?? "narration").trim() !== "dialogue";
}

/**
 * 视频 sub-tab — first-frame preview + video preview + per-beat regen.
 * Per-beat backend override is deferred (see v3 spec P4 follow-up).
 */
export function VideoPane({
  beat,
  project,
  episode,
  state,
  defaultBackend,
  showAudioMediaStatus = true,
}: VideoPaneProps) {
  const { t } = useTranslation();
  const { spec } = useProjectAspectRatio(project);
  const frameAspectCss = ratioToCss(spec.renderAspect);
  const seedance2Id = useId();
  const regenerate = useRegenerateBeatVideo(project, episode);
  const generateBeatVideoPrompt = useGenerateBeatVideoPrompt(project, episode);
  const generateSeedance2Prompt = useGenerateSeedance2Prompt(project, episode);
  const uploadSeedance2Asset = useUploadSeedance2Asset(project, episode);
  const deleteSeedance2Asset = useDeleteSeedance2Asset(project, episode);
  const cropSeedance2Asset = useCropSeedance2Asset(project, episode);
  const trimSeedance2Asset = useTrimSeedance2Asset(project, episode);
  const updateBeat = useUpdateBeat(project, episode);
  const regenTask = useTaskController({
    key: {
      taskType: "single_video",
      project,
      episode,
      beatNum: beat.beat_number,
    },
    invalidateKeys: [
      queryKeys.beats(project, episode),
      queryKeys.videoPool(project, episode),
    ],
  });
  // Beat 视频提示词生成在 EE 下是后台任务（同步分支仅 CE 单机命中），mutateAsync
  // 只拿到入队 ack，isPending 一闪而过。用任务控制器让 loading 覆盖真实生成过程，
  // 并在刷新后仍能恢复；完成后 invalidate beats 会把提示词回填到文本框。
  const beatVideoPromptTask = useTaskController({
    key: {
      taskType: "beat_video_prompt",
      project,
      episode,
      beatNum: beat.beat_number,
    },
    invalidateKeys: [queryKeys.beats(project, episode)],
  });
  const poolSelect = useVideoPoolSelect(project, episode);
  const { data: poolRes } = useVideoPool(project, episode);
  const { data: videoBackendsRes } = useVideoBackends(project);
  const videoBackends = videoBackendsRes?.data ?? [];
  const beatVideoPromptCost = useGenerationCreditCost("feature", "beat_video_prompt");
  const seedance2PromptCost = useGenerationCreditCost("feature", "seedance2_prompt");
  const now = useNow();
  const seedance2UploadInputRef = useRef<HTMLInputElement>(null);
  const [regenConfirm, setRegenConfirm] = useState(false);
  const [seedance2CropIntent, setSeedance2CropIntent] =
    useState<Seedance2CropIntent | null>(null);
  const [seedance2TrimAsset, setSeedance2TrimAsset] =
    useState<Seedance2AssetItem | null>(null);
  const [seedance2TrimStart, setSeedance2TrimStart] = useState("0");
  const [seedance2TrimDuration, setSeedance2TrimDuration] = useState("4");
  const [seedance2ReferencesOpen, setSeedance2ReferencesOpen] = useState(true);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [activeMentionField, setActiveMentionField] =
    useState<Seedance2ReferenceField>("final_prompt");
  // The mention query at which the dropdown was dismissed (Escape / after a
  // pick). Keeps it closed until the query changes again.
  const [mentionDismissedQuery, setMentionDismissedQuery] = useState<
    { field: Seedance2ReferenceField; query: string | null } | null
  >(null);
  const seedance2ReferenceSelectionRef = useRef<
    Record<Seedance2ReferenceField, { start: number; end: number } | null>
  >({
    prompt_guidance: null,
    final_prompt: null,
  });
  // #t=0.1 forces a seek so Safari/iOS paints the real first frame without
  // relying on a poster image (which was the beat's sketch PNG, not the video).
  const videoSrc = beat.video_url
    ? `${resolveMediaUrl(beat.video_url)}#t=0.1`
    : null;
  // Clean URL (no #t=0.1 fragment) for the download anchor.
  const videoDownloadUrl = beat.video_url ? resolveMediaUrl(beat.video_url) : null;

  const { candidates, activePoolId } = useMemo(() => {
    const poolData = poolRes?.data ?? null;
    if (!poolData) return { candidates: [], activePoolId: null as string | null };
    const filtered = poolData.videos
      .filter((v) => v.beat_num === beat.beat_number)
      .sort((a, b) => {
        const ta = a.generated_at ? Date.parse(a.generated_at) : 0;
        const tb = b.generated_at ? Date.parse(b.generated_at) : 0;
        return tb - ta;
      });
    const activeId =
      poolData.beat_assignments[String(beat.beat_number)] ?? null;
    return { candidates: filtered, activePoolId: activeId };
  }, [poolRes, beat.beat_number]);
  const hasGeneratedVideo = !!beat.video_url || candidates.length > 0;
  const videoActionLabel = hasGeneratedVideo
    ? t("common.regenerate")
    : t("episode.workbench.video.generateVideo");
  const videoBackendLabelByValue = useMemo(() => {
    const labels = new Map<string, string>();
    for (const backend of videoBackends) {
      labels.set(backend.value, backend.label);
    }
    return labels;
  }, [videoBackends]);
  const selectedBackend = videoBackends.find((b) => b.value === defaultBackend);
  const showSeedance2Config = selectedBackend?.is_seedance2 === true;
  const showHappyHorseConfig = selectedBackend?.is_happyhorse === true;
  const showGrokVideoConfig = selectedBackend?.is_grok_video === true;
  const showPromptConfig =
    showSeedance2Config || showHappyHorseConfig || showGrokVideoConfig;
  const showReferenceDetails =
    showSeedance2Config ||
    showHappyHorseConfig ||
    showGrokVideoConfig ||
    isSeedanceReferenceCropBackend(defaultBackend);
  const legacyPromptField: "video_prompt" | "keyframe_prompt" =
    beat.video_mode === "keyframe" ? "keyframe_prompt" : "video_prompt";
  const legacyPromptLabel =
    legacyPromptField === "keyframe_prompt"
      ? t("episode.workbench.video.keyframePrompt")
      : t("episode.workbench.video.videoPrompt");
  const legacyPromptId = `${seedance2Id}-legacy-video-prompt`;
  const [legacyVideoPrompt, setLegacyVideoPrompt] = useState(
    legacyPromptField === "keyframe_prompt"
      ? (beat.keyframe_prompt ?? "")
      : (beat.video_prompt ?? ""),
  );
  const showSeedance2ValueStyle =
    showSeedance2Config && isSeedance2ValueBackend(defaultBackend);
  const seedance2ResolutionOptions = useMemo(
    () => seedance2ResolutionOptionsForBackend(defaultBackend),
    [defaultBackend],
  );
  const seedance2DurationBounds = useMemo(
    () => seedance2DurationBoundsForBackend(selectedBackend),
    [selectedBackend],
  );
  const happyHorseResolutionOptions = useMemo(
    () => happyHorseResolutionOptionsForBackend(selectedBackend),
    [selectedBackend],
  );
  const happyHorseRatioOptions = useMemo(
    () => happyHorseRatioOptionsForBackend(selectedBackend),
    [selectedBackend],
  );
  const grokVideoResolutionOptions = useMemo(
    () => grokVideoResolutionOptionsForBackend(selectedBackend),
    [selectedBackend],
  );
  const grokVideoRatioOptions = useMemo(
    () => grokVideoRatioOptionsForBackend(selectedBackend),
    [selectedBackend],
  );
  // seedance-1.5-pro：复用清晰度/时长控件（精品剧+解说剧），但不走 seedance2 多模态那套。
  const isSd15ProConfig =
    !showSeedance2Config && isSeedance15ProBackend(defaultBackend);
  const audioFloorSeconds =
    typeof beat.audio_duration_seconds === "number" &&
    beat.audio_duration_seconds > 0
      ? Math.ceil(beat.audio_duration_seconds)
      : null;
  // 时长下限 = max(模型下限, 音频时长)；视频时长须 >= 音频时长。
  const sd15DurationBounds = useMemo<Seedance2DurationBounds>(
    () => ({
      min: Math.max(seedance2DurationBounds.min, audioFloorSeconds ?? 0),
      max: seedance2DurationBounds.max,
    }),
    [seedance2DurationBounds.min, seedance2DurationBounds.max, audioFloorSeconds],
  );
  const [sd15Resolution, setSd15Resolution] =
    useState<Seedance2Resolution>("720p");
  const [sd15Duration, setSd15Duration] = useState<number>(
    seedance2DurationBounds.min,
  );
  useEffect(() => {
    if (!isSd15ProConfig) return;
    const fallbackRes = seedance2ResolutionOptions.includes("720p")
      ? "720p"
      : seedance2ResolutionOptions[0];
    setSd15Resolution((prev) =>
      seedance2ResolutionOptions.includes(prev)
        ? prev
        : normalizeSeedance2Resolution(fallbackRes),
    );
    // 默认时长 = 音频下限（视频须 >= 音频）；用户可在控件里上调。
    setSd15Duration(
      clampDuration(audioFloorSeconds ?? sd15DurationBounds.min, sd15DurationBounds),
    );
  }, [
    isSd15ProConfig,
    beat.beat_number,
    audioFloorSeconds,
    seedance2ResolutionOptions,
    sd15DurationBounds.min,
    sd15DurationBounds.max,
  ]);
  useEffect(() => {
    setLegacyVideoPrompt(
      legacyPromptField === "keyframe_prompt"
        ? (beat.keyframe_prompt ?? "")
        : (beat.video_prompt ?? ""),
    );
  }, [
    beat.beat_number,
    beat.keyframe_prompt,
    beat.video_prompt,
    legacyPromptField,
  ]);
  const previewAspectCss = "16 / 9";
  // Live loading state for the video preview while a single-shot regen runs.
  // Progress comes from the active task's SSE stream (0–1) and survives refresh
  // because the controller reconciles against the persisted task row.
  const videoActive = regenTask.started;
  const videoPercent = Math.max(
    0,
    Math.min(100, Math.round((regenTask.stream?.progress ?? 0) * 100)),
  );
  const seedance2Status = useSeedance2BeatStatus(
    project,
    episode,
    beat.beat_number,
    showReferenceDetails,
  );
  const seedance2StatusData =
    seedance2Status.data?.ok === true ? seedance2Status.data.data : null;
  const seedance2AssetItems = seedance2StatusData?.assets.items ?? [];
  const modelReferenceAssetItems = useMemo(
    () =>
      showHappyHorseConfig || showGrokVideoConfig
        ? seedance2AssetItems.filter((asset) => asset.media_type === "image")
        : seedance2AssetItems,
    [seedance2AssetItems, showGrokVideoConfig, showHappyHorseConfig],
  );
  const referenceCropImageItems = useMemo(
    () => {
      const imageAssets = seedance2AssetItems.filter(
        (asset) =>
          asset.media_type === "image" &&
          asset.exists !== false &&
          Boolean(asset.url || asset.path),
      );
      if (showSeedance2Config || showHappyHorseConfig || showGrokVideoConfig) {
        return imageAssets;
      }
      return imageAssets.filter((asset) => asset.key === "first_frame");
    },
    [seedance2AssetItems, showGrokVideoConfig, showHappyHorseConfig, showSeedance2Config],
  );
  const seedance2ReferenceOptions = useMemo(
    () =>
      modelReferenceAssetItems.filter(
        (asset) =>
          asset.reference_label &&
          asset.reference_label !== "未发送" &&
          asset.exists !== false,
    ),
    [modelReferenceAssetItems],
  );
  const seedance2ReturnedLastFrameAsset = useMemo(
    () =>
      seedance2AssetItems.find((asset) => {
        if (asset.media_type !== "image" || !(asset.url || asset.path)) {
          return false;
        }
        return [
          "returned_last_frame",
          "return_last_frame",
          "last_frame_output",
        ].includes(asset.key);
      }) ?? null,
    [seedance2AssetItems],
  );
  const seedance2Config = useMemo(
    () =>
      parseSeedance2Config(
        beat.seedance2_config_json,
        seedance2DefaultRatioForProjectAspect(spec.renderAspect),
      ),
    [beat.seedance2_config_json, spec.renderAspect],
  );
  const [seedance2Draft, setSeedance2Draft] = useState(seedance2Config);
  const videoCost = useGenerationCreditCost("video_backend", defaultBackend, {
    surface: "supertale",
    params: {
      resolution: showSeedance2Config || showHappyHorseConfig || showGrokVideoConfig
        ? seedance2Draft.resolution
        : isSd15ProConfig
          ? sd15Resolution
          : "720p",
    },
    quantity: showSeedance2Config || showHappyHorseConfig || showGrokVideoConfig
      ? seedance2Draft.duration
      : isSd15ProConfig
        ? sd15Duration
        : 5,
  });
  const beatVideoPromptCostDisplay =
    beatVideoPromptCost.data?.data.display ??
    (beatVideoPromptCost.error instanceof BillingRuleNotConfiguredError
      ? t("common.billingRuleNotConfiguredShort")
      : null);
  const seedance2PromptCostDisplay =
    seedance2PromptCost.data?.data.display ??
    (seedance2PromptCost.error instanceof BillingRuleNotConfiguredError
      ? t("common.billingRuleNotConfiguredShort")
      : null);
  const seedance2DraftRef = useRef(seedance2Config);
  const normalizedLegacySeedance2ConfigRef = useRef("");
  const lastSavedSeedance2ConfigKeyRef = useRef("");
  // Always mirrors the currently-mounted beat so async handlers (e.g. AI prompt
  // optimize) can tell whether the user switched beats while a request was in
  // flight. `beat` captured in a handler closure is frozen at trigger time, so a
  // ref is the only way to read the *live* beat after an await. See issue #39.
  const currentBeatNumberRef = useRef(beat.beat_number);
  currentBeatNumberRef.current = beat.beat_number;
  useEffect(() => {
    setSeedance2Draft(seedance2Config);
    seedance2DraftRef.current = seedance2Config;
    lastSavedSeedance2ConfigKeyRef.current = getSeedance2ConfigSaveKey(
      beat.beat_number,
      serializeSeedance2Config(seedance2Config, seedance2Config),
    );
  }, [beat.beat_number, seedance2Config]);
  useEffect(() => {
    if (!showSeedance2Config && !showHappyHorseConfig && !showGrokVideoConfig) return;
    const current = seedance2DraftRef.current;
    const next = showGrokVideoConfig
      ? normalizeGrokVideoDraftForBackend(
          current,
          grokVideoResolutionOptions,
          grokVideoRatioOptions,
        )
      : showHappyHorseConfig
      ? normalizeHappyHorseDraftForBackend(
          current,
          happyHorseResolutionOptions,
          happyHorseRatioOptions,
        )
      : normalizeSeedance2DraftForBackend(
          current,
          seedance2ResolutionOptions,
          defaultBackend,
          showSeedance2ValueStyle,
        );
    if (sameSeedance2Config(current, next)) return;
    seedance2DraftRef.current = next;
    setSeedance2Draft(next);
  }, [
    defaultBackend,
    grokVideoRatioOptions,
    grokVideoResolutionOptions,
    showGrokVideoConfig,
    happyHorseRatioOptions,
    happyHorseResolutionOptions,
    showHappyHorseConfig,
    seedance2ResolutionOptions,
    showSeedance2Config,
    showSeedance2ValueStyle,
  ]);
  useEffect(() => {
    if (!showSeedance2Config && !showHappyHorseConfig && !showGrokVideoConfig) return;
    const current = seedance2DraftRef.current;
    const nextDuration = clampDuration(current.duration, seedance2DurationBounds);
    if (current.duration === nextDuration) return;
    const next = { ...current, duration: nextDuration };
    seedance2DraftRef.current = next;
    setSeedance2Draft(next);
  }, [
    seedance2DurationBounds.max,
    seedance2DurationBounds.min,
    showGrokVideoConfig,
    showHappyHorseConfig,
    showSeedance2Config,
  ]);
  const seedance2Dirty = !sameSeedance2Config(seedance2Draft, seedance2Config);
  const seedance2Ready = seedance2Draft.final_prompt.trim().length > 0;
  const seedance2ReturnedLastFrameSrc =
    seedance2Draft.return_last_frame && seedance2ReturnedLastFrameAsset
      ? resolveMediaUrl(
          seedance2ReturnedLastFrameAsset.url ||
            seedance2ReturnedLastFrameAsset.path,
        )
      : null;
  const seedance2ReturnedLastFrameAspectCss = ratioToCss(
    seedance2Draft.ratio || spec.renderAspect,
  );
  const seedance2MentionQuery = getSeedance2MentionQuery(
    seedance2Draft[activeMentionField],
  );
  const seedance2MentionOptions = useMemo(() => {
    if (seedance2MentionQuery === null) return [];
    const query = seedance2MentionQuery.trim();
    return seedance2ReferenceOptions.filter((asset) => {
      const label = asset.reference_label;
      return !query || label.includes(query) || `@${label}`.includes(query);
    });
  }, [
    seedance2MentionQuery,
    seedance2ReferenceOptions,
  ]);
  const seedance2ReferenceLabels = useMemo(
    () => seedance2ReferenceOptions.map((asset) => asset.reference_label),
    [seedance2ReferenceOptions],
  );
  // 提示词 @图片N/@音频N 与参考素材的「label↔身份(URL)」映射，用于素材增删/重排后
  // 把提示词里的编号按素材身份重新对号（mention 始终跟着它引用的素材走）。
  const seedance2LabelIdentity = useMemo(
    () => buildSeedance2LabelIdentityMaps(seedance2ReferenceOptions),
    [seedance2ReferenceOptions],
  );
  // 提示词里 hover 到 @图片N 时弹出的小图预览：reference_label → 图片 URL（仅图片素材）。
  const seedance2MentionPreviews = useMemo(() => {
    const map: Record<string, string> = {};
    for (const asset of seedance2ReferenceOptions) {
      if (asset.media_type !== "image") continue;
      const url = resolveMediaUrl(asset.url || asset.path);
      if (url) {
        map[asset.reference_label] = url;
      }
    }
    return map;
  }, [seedance2ReferenceOptions]);
  const seedance2MentionOpen =
    seedance2MentionOptions.length > 0 &&
    !(
      mentionDismissedQuery?.field === activeMentionField &&
      mentionDismissedQuery.query === seedance2MentionQuery
    );
  // Restart the highlight at the top whenever the query changes.
  useEffect(() => {
    setMentionActiveIndex(0);
  }, [activeMentionField, seedance2MentionQuery]);
  const seedance2PromptStatus = seedance2Ready
    ? t("episode.workbench.video.seedance2Ready")
    : t("episode.workbench.video.seedance2Missing");
  const validateVideoPromptReady = () => {
    if (showPromptConfig) {
      if (!seedance2DraftRef.current.final_prompt.trim()) {
        toast.error(
          t("episode.workbench.video.seedance2PromptRequired", {
            n: beat.beat_number,
          }),
        );
        return false;
      }
      return true;
    }
    if (!legacyVideoPrompt.trim()) {
      toast.error(
        t("episode.workbench.video.beatVideoPromptRequired", {
          n: beat.beat_number,
        }),
      );
      return false;
    }
    return true;
  };
  const openRegenConfirm = () => {
    if (!validateVideoPromptReady()) return;
    setRegenConfirm(true);
  };
  const handleSelect = async (poolId: string) => {
    if (poolId === activePoolId) return;
    try {
      await poolSelect.mutateAsync({ beatNum: beat.beat_number, poolId });
      toast.success(t("episode.workbench.video.switched", { n: beat.beat_number }));
    } catch {
      toast.error(t("episode.workbench.video.switchFailed"));
    }
  };

  const handleRegen = async () => {
    try {
      let happyHorseConfigJson: string | undefined;
      let happyHorseDraft: Seedance2ConfigDraft | undefined;
      let grokVideoConfigJson: string | undefined;
      let grokVideoDraft: Seedance2ConfigDraft | undefined;
      if (showSeedance2Config) {
        const normalizedDraft = normalizeSeedance2DraftForBackend(
          seedance2DraftRef.current,
          seedance2ResolutionOptions,
          defaultBackend,
          showSeedance2ValueStyle,
        );
        if (!sameSeedance2Config(normalizedDraft, seedance2DraftRef.current)) {
          seedance2DraftRef.current = normalizedDraft;
          setSeedance2Draft(normalizedDraft);
        }
        if (
          seedance2Dirty ||
          !sameSeedance2Config(normalizedDraft, seedance2Config)
        ) {
          const saved = await saveSeedance2Draft(normalizedDraft, {
            suppressSuccess: true,
          });
          if (!saved) return;
        }
      }
      if (showHappyHorseConfig) {
        const normalizedDraft = normalizeHappyHorseDraftForBackend(
          seedance2DraftRef.current,
          happyHorseResolutionOptions,
          happyHorseRatioOptions,
        );
        if (!sameSeedance2Config(normalizedDraft, seedance2DraftRef.current)) {
          seedance2DraftRef.current = normalizedDraft;
          setSeedance2Draft(normalizedDraft);
        }
        happyHorseDraft = normalizedDraft;
        happyHorseConfigJson = JSON.stringify(
          serializeHappyHorseConfig(normalizedDraft, seedance2Config),
        );
      }
      if (showGrokVideoConfig) {
        const normalizedDraft = normalizeGrokVideoDraftForBackend(
          seedance2DraftRef.current,
          grokVideoResolutionOptions,
          grokVideoRatioOptions,
        );
        if (!sameSeedance2Config(normalizedDraft, seedance2DraftRef.current)) {
          seedance2DraftRef.current = normalizedDraft;
          setSeedance2Draft(normalizedDraft);
        }
        grokVideoDraft = normalizedDraft;
        grokVideoConfigJson = JSON.stringify(
          serializeGrokVideoConfig(normalizedDraft, seedance2Config),
        );
      }
      const res = await regenerate.mutateAsync({
        beatNum: beat.beat_number,
        videoBackend: defaultBackend,
        ...(showHappyHorseConfig && happyHorseDraft
          ? {
              resolution: happyHorseDraft.resolution,
              duration: happyHorseDraft.duration,
              ratio: happyHorseDraft.ratio,
              mode: happyHorseDraft.mode,
              seedance2ConfigJson: happyHorseConfigJson,
            }
          : {}),
        ...(showGrokVideoConfig && grokVideoDraft
          ? {
              resolution: grokVideoDraft.resolution,
              duration: grokVideoDraft.duration,
              ratio: grokVideoDraft.ratio,
              mode: grokVideoDraft.mode,
              seedance2ConfigJson: grokVideoConfigJson,
            }
          : {}),
        ...(isSd15ProConfig
          ? { resolution: sd15Resolution, duration: sd15Duration }
          : {}),
      });
      if (res.ok === false) {
        toast.error(res.error || t("episode.workbench.video.regenFailed"));
        return;
      }
      regenTask.start();
      toast.success(t("episode.workbench.video.started", { n: beat.beat_number }));
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };
  const saveSeedance2Draft = async (
    draft: Seedance2ConfigDraft,
    options: { silent?: boolean; suppressSuccess?: boolean } = {},
  ) => {
    const nextConfig = showGrokVideoConfig
      ? serializeGrokVideoConfig(draft, seedance2Config)
      : showHappyHorseConfig
      ? serializeHappyHorseConfig(draft, seedance2Config)
      : serializeSeedance2Config(draft, seedance2Config);
    const nextConfigJson = JSON.stringify(nextConfig);
    try {
      await updateBeat.mutateAsync({
        beatNum: beat.beat_number,
        data: { seedance2_config_json: nextConfigJson },
      });
      lastSavedSeedance2ConfigKeyRef.current = getSeedance2ConfigSaveKey(
        beat.beat_number,
        nextConfig,
      );
      void seedance2Status.refetch?.();
      if (!options.silent && !options.suppressSuccess) {
        toast.success(t("episode.workbench.video.seedance2Saved"));
      }
      return true;
    } catch {
      if (!options.silent) {
        toast.error(t("episode.workbench.video.regenFailed"));
      }
      return false;
    }
  };
  useEffect(() => {
    if (!showSeedance2Config) return;
    const raw = seedance2Config.raw;
    const shouldNormalizeMode =
      raw.mode === "first_frame" &&
      raw.mode_user_set !== true &&
      seedance2Config.mode === "multimodal_reference";
    const shouldNormalizeAudio =
      raw.generate_audio === false && raw.generate_audio_user_set === true;
    if (!shouldNormalizeMode && !shouldNormalizeAudio) return;
    const key = `${beat.beat_number}:${String(beat.seedance2_config_json ?? "")}`;
    if (normalizedLegacySeedance2ConfigRef.current === key) return;
    normalizedLegacySeedance2ConfigRef.current = key;
    void saveSeedance2Draft(seedance2Config, { silent: true });
  }, [
    beat.beat_number,
    beat.seedance2_config_json,
    seedance2Config,
    showSeedance2Config,
  ]);
  useEffect(() => {
    if (!showPromptConfig || !seedance2Dirty) return;
    const nextConfig = showGrokVideoConfig
      ? serializeGrokVideoConfig(seedance2Draft, seedance2Config)
      : showHappyHorseConfig
      ? serializeHappyHorseConfig(seedance2Draft, seedance2Config)
      : serializeSeedance2Config(seedance2Draft, seedance2Config);
    const saveKey = getSeedance2ConfigSaveKey(beat.beat_number, nextConfig);
    if (lastSavedSeedance2ConfigKeyRef.current === saveKey) return;
    const timer = window.setTimeout(() => {
      void saveSeedance2Draft(seedance2DraftRef.current, {
        suppressSuccess: true,
      });
    }, SEEDANCE2_AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [
    beat.beat_number,
    seedance2Config,
    seedance2Dirty,
    seedance2Draft,
    showHappyHorseConfig,
    showGrokVideoConfig,
    showPromptConfig,
    showSeedance2Config,
  ]);
  const handleGenerateSeedance2Prompt = async () => {
    // Bind the result to the beat that triggered the optimize. The request is
    // async; if the user switches beats before it returns, applying the result
    // to the now-mounted beat's draft would autosave it onto the WRONG beat
    // (issue #39). The backend persists the optimized prompt to this beat and
    // onSuccess patches it into the beats cache, so a switched-away result is
    // safe to drop locally — it will show when the user returns to this beat.
    const triggeredBeatNumber = beat.beat_number;
    try {
      const res = await generateSeedance2Prompt.mutateAsync({
        beatNum: triggeredBeatNumber,
        manualPromptReference: seedance2Draft.final_prompt,
        promptGuidance: seedance2Draft.prompt_guidance,
      });
      if (!res.ok) {
        toast.error(
          res.error || t("episode.workbench.video.seedance2PromptGenerateFailed"),
        );
        return;
      }
      if (currentBeatNumberRef.current !== triggeredBeatNumber) {
        // User moved to another beat while optimizing. Do NOT touch the current
        // draft — the triggering beat is already updated server-side + in cache.
        toast.success(
          t("episode.workbench.video.seedance2PromptGeneratedOtherBeat", {
            n: triggeredBeatNumber,
          }),
        );
        return;
      }
      const parsedDraft = parseSeedance2Config(
        res.data.seedance2_config_json,
        seedance2DefaultRatioForProjectAspect(spec.renderAspect),
      );
      const nextDraft = showGrokVideoConfig
        ? normalizeGrokVideoDraftForBackend(
            parsedDraft,
            grokVideoResolutionOptions,
            grokVideoRatioOptions,
          )
        : showHappyHorseConfig
        ? normalizeHappyHorseDraftForBackend(
            parsedDraft,
            happyHorseResolutionOptions,
            happyHorseRatioOptions,
          )
        : parsedDraft;
      seedance2DraftRef.current = nextDraft;
      setSeedance2Draft(nextDraft);
      void seedance2Status.refetch?.();
      toast.success(
        showHappyHorseConfig || showGrokVideoConfig
          ? "主体提示词已优化"
          : t("episode.workbench.video.seedance2PromptGenerated"),
      );
    } catch (error) {
      toast.error(backendErrorToastMessage(error, t));
    }
  };
  const updateSeedance2Draft = <K extends keyof Seedance2ConfigDraft>(
    key: K,
    value: Seedance2ConfigDraft[K],
  ) => {
    setSeedance2Draft((current) => {
      const next = { ...current, [key]: value };
      seedance2DraftRef.current = next;
      return next;
    });
  };
  const updateSeedance2Mode = (mode: Seedance2ConfigDraft["mode"]) => {
    const next = { ...seedance2DraftRef.current, mode, mode_user_set: true };
    seedance2DraftRef.current = next;
    setSeedance2Draft(next);
  };

  // 参考素材的「label↔身份(URL)」映射变化时（增删/重排导致后端重新编号），把提示词里
  // 的 @图片N/@音频N 按素材身份重新对号、被删的移除。后端拿到的仍是图片N，生成视频时
  // 编号已是最新位置。放在 beat 重置 effect 之后，读到的是重置后的草稿。
  // 前提：后端在素材增删时不自行重编号提示词（当前 bug「提示词不同步」即说明如此）。
  const prevSeedance2LabelIdentityRef = useRef<{
    beatNumber: number;
    maps: Seedance2LabelIdentityMaps;
  } | null>(null);
  useEffect(() => {
    if (!showPromptConfig) return;
    const prev = prevSeedance2LabelIdentityRef.current;
    prevSeedance2LabelIdentityRef.current = {
      beatNumber: beat.beat_number,
      maps: seedance2LabelIdentity,
    };
    // 切 beat / 首帧：只记录基线，不重映射（避免用上一个 beat 的映射改新 beat 的词）。
    if (!prev || prev.beatNumber !== beat.beat_number) return;
    if (sameSeedance2LabelIdentity(prev.maps, seedance2LabelIdentity)) return;
    const current = seedance2DraftRef.current;
    const nextFinal = remapSeedance2Mentions(
      current.final_prompt,
      prev.maps,
      seedance2LabelIdentity,
    );
    const nextGuidance = remapSeedance2Mentions(
      current.prompt_guidance,
      prev.maps,
      seedance2LabelIdentity,
    );
    if (nextFinal !== current.final_prompt) {
      updateSeedance2Draft("final_prompt", nextFinal);
    }
    if (nextGuidance !== current.prompt_guidance) {
      updateSeedance2Draft("prompt_guidance", nextGuidance);
    }
    // updateSeedance2Draft / seedance2DraftRef 为组件内稳定引用，无需进依赖。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedance2LabelIdentity, beat.beat_number, showPromptConfig]);
  const insertSeedance2Reference = (
    field: Seedance2ReferenceField,
    label: string,
    options: {
      replaceTrailingMention?: boolean;
      selectionRange?: { start: number; end: number };
    } = {},
  ) => {
    // Mirror MentionTextarea.insertMention: every inserted reference is followed
    // by a single space so the next reference/word can't glue onto it.
    const token = `@${label} `;
    setSeedance2Draft((current) => {
      const rawText = current[field];
      const text = rawText.trimEnd();
      if (options.selectionRange) {
        const start = Math.max(
          0,
          Math.min(options.selectionRange.start, rawText.length),
        );
        const end = Math.max(
          start,
          Math.min(options.selectionRange.end, rawText.length),
        );
        const after = rawText.slice(end).replace(/^\s+/, "");
        const nextText = normalizeMentionSeparatorSpaces(
          `${rawText.slice(0, start)}${token}${after}`,
          seedance2ReferenceLabels,
        ).text;
        const next = {
          ...current,
          [field]: nextText,
        };
        seedance2DraftRef.current = next;
        return next;
      }
      const mention = options.replaceTrailingMention
        ? getSeedance2MentionMatch(text)
        : null;
      const finalPrompt = text.endsWith("@")
        ? `${text.slice(0, -1)}${token}`
        : mention
          ? `${text.slice(0, mention.index)}${token}`
        : text
          ? `${text}\n${token}`
          : token;
      const nextText = normalizeMentionSeparatorSpaces(
        finalPrompt,
        seedance2ReferenceLabels,
      ).text;
      const next = {
        ...current,
        [field]: nextText,
      };
      seedance2DraftRef.current = next;
      return next;
    });
  };
  const rememberSeedance2PromptSelection = (
    field: Seedance2ReferenceField,
    target: HTMLTextAreaElement,
  ) => {
    setActiveMentionField(field);
    seedance2ReferenceSelectionRef.current[field] = {
      start: target.selectionStart,
      end: target.selectionEnd,
    };
  };
  const handleSeedance2ReferenceDragStart = (
    event: DragEvent<HTMLElement>,
    label: string,
  ) => {
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(SEEDANCE2_REFERENCE_DRAG_TYPE, label);
    event.dataTransfer.setData("text/plain", `@${label}`);
  };
  const handleSeedance2ReferenceDragOver = (
    event: DragEvent<HTMLTextAreaElement>,
  ) => {
    const types = Array.from(event.dataTransfer.types);
    const mayBeReferenceDrop =
      seedance2ReferenceOptions.length > 0 &&
      (types.length === 0 ||
        types.includes(SEEDANCE2_REFERENCE_DRAG_TYPE) ||
        types.includes("text/plain") ||
        types.includes("text/uri-list") ||
        types.includes("text/html"));
    if (mayBeReferenceDrop) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  };
  const handleSeedance2ReferenceDrop = (
    field: Seedance2ReferenceField,
    event: DragEvent<HTMLTextAreaElement>,
  ) => {
    const customLabel = event.dataTransfer.getData(
      SEEDANCE2_REFERENCE_DRAG_TYPE,
    );
    const plainLabel = event.dataTransfer.getData("text/plain").replace(/^@/, "");
    const label = (customLabel || plainLabel).trim();
    if (!seedance2ReferenceOptions.some((asset) => asset.reference_label === label)) {
      return;
    }
    event.preventDefault();
    setActiveMentionField(field);
    const selectionRange =
      document.activeElement === event.currentTarget
        ? {
            start: event.currentTarget.selectionStart,
            end: event.currentTarget.selectionEnd,
          }
        : seedance2ReferenceSelectionRef.current[field] ?? undefined;
    insertSeedance2Reference(field, label, { selectionRange });
    setMentionDismissedQuery({ field, query: label });
  };
  const handleSelectMention = (field: Seedance2ReferenceField, label: string) => {
    setActiveMentionField(field);
    insertSeedance2Reference(field, label, { replaceTrailingMention: true });
    // After inserting, the prompt ends with `@<label>`, so that becomes the
    // trailing query — dismiss it so the dropdown doesn't immediately reopen.
    setMentionDismissedQuery({ field, query: label });
  };
  const handleMentionKeyDown = (
    field: Seedance2ReferenceField,
    event: KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    setActiveMentionField(field);
    if (!seedance2MentionOpen || event.nativeEvent.isComposing) return;
    const count = seedance2MentionOptions.length;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setMentionActiveIndex((index) => (index + 1) % count);
        break;
      case "ArrowUp":
        event.preventDefault();
        setMentionActiveIndex((index) => (index - 1 + count) % count);
        break;
      case "Enter":
      case "Tab":
      case " ": {
        if (event.key === "Enter" && event.shiftKey) return;
        const option =
          seedance2MentionOptions[Math.min(mentionActiveIndex, count - 1)];
        if (option) {
          event.preventDefault();
          handleSelectMention(field, option.reference_label);
        }
        break;
      }
      case "Escape":
        event.preventDefault();
        setMentionDismissedQuery({ field, query: seedance2MentionQuery });
        break;
    }
  };
  const appendSeedance2PromptGuidanceTemplate = (template: string) => {
    const current = seedance2DraftRef.current;
    if (current.prompt_guidance.includes(template)) return;
    const guidance = [current.prompt_guidance.trim(), template]
      .filter(Boolean)
      .join("\n");
    const next = { ...current, prompt_guidance: guidance };
    seedance2DraftRef.current = next;
    setSeedance2Draft(next);
  };
  const renderSeedance2ReferenceControls = (field: Seedance2ReferenceField) => {
    if (activeMentionField !== field) return null;

    if (seedance2MentionOpen) {
      return (
        <div className="rounded-[8px] border border-white/[0.075] bg-white/[0.025] p-1.5">
          <div className="mb-1 text-[10px] font-medium text-muted-foreground/78">
            {t("episode.workbench.video.seedance2MentionCandidates")}
          </div>
          <div className="flex flex-wrap gap-1">
            {seedance2MentionOptions.map((asset, index) => (
              <Button
                key={asset.key}
                type="button"
                size="xs"
                variant="ghost"
                aria-pressed={index === mentionActiveIndex}
                className={cn(
                  "h-6 rounded-[6px] border px-1.5 text-[10px] font-normal shadow-none",
                  index === mentionActiveIndex
                    ? "border-primary/35 bg-primary/[0.10] text-primary hover:bg-primary/[0.14] hover:text-primary"
                    : "border-white/[0.075] bg-white/[0.018] text-muted-foreground/78 hover:border-white/[0.14] hover:bg-white/[0.04] hover:text-foreground",
                )}
                onMouseEnter={() => setMentionActiveIndex(index)}
                onClick={() => handleSelectMention(field, asset.reference_label)}
              >
                @{asset.reference_label}
              </Button>
            ))}
          </div>
        </div>
      );
    }

    if (seedance2ReferenceOptions.length <= 0) return null;
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground/78">
          {t("episode.workbench.video.seedance2AtReferences")}
        </span>
        {seedance2ReferenceOptions.map((asset) => (
          <Button
            key={asset.key}
            type="button"
            size="xs"
            variant="ghost"
            className={SEEDANCE2_PILL_ACTION_CLASS}
            onClick={() => insertSeedance2Reference(field, asset.reference_label)}
          >
            @{asset.reference_label}
          </Button>
        ))}
      </div>
    );
  };
  const handleSeedance2AssetUpload = async (file: File) => {
    try {
      const res = await uploadSeedance2Asset.mutateAsync({
        beatNum: beat.beat_number,
        file,
      });
      if (isErrorResponse(res)) {
        toast.error(res.error || t("common.error"));
        return;
      }
      toast.success(t("episode.workbench.video.seedance2AssetUploaded"));
    } catch {
      toast.error(t("common.error"));
    }
  };
  const handleDeleteSeedance2Asset = async (asset: Seedance2AssetItem) => {
    const path = asset.abs_path || asset.path || "";
    if (!path) return;
    try {
      const res = await deleteSeedance2Asset.mutateAsync({
        beatNum: beat.beat_number,
        mediaKind: asset.media_type === "audio" ? "audios" : "images",
        path,
      });
      if (isErrorResponse(res)) {
        toast.error(res.error || t("common.error"));
        return;
      }
      toast.success(t("episode.workbench.video.seedance2AssetDeleted"));
    } catch {
      toast.error(t("common.error"));
    }
  };
  const handleCropSeedance2Asset = async (
    asset: Seedance2AssetItem,
    target: VideoInputCropTarget,
    crop: { x: number; y: number; width: number; height: number },
  ) => {
    const sourcePath =
      asset.crop_source_abs_path ||
      asset.crop_source_path ||
      asset.abs_path ||
      asset.path ||
      "";
    if (!sourcePath) return;
    try {
      const res = await cropSeedance2Asset.mutateAsync({
        beatNum: beat.beat_number,
        assetKey: asset.key,
        sourcePath,
        target,
        crop,
      });
      if (isErrorResponse(res)) {
        toast.error(res.error || t("common.error"));
        return;
      }
      toast.success(t("episode.workbench.video.seedance2AssetCropped"));
      setSeedance2CropIntent(null);
    } catch {
      toast.error(t("common.error"));
    }
  };
  const handleTrimSeedance2Asset = async () => {
    const asset = seedance2TrimAsset;
    if (!asset) return;
    const sourcePath = asset.abs_path || asset.path || "";
    if (!sourcePath) return;
    const startSeconds = Number(seedance2TrimStart);
    const durationSeconds = Number(seedance2TrimDuration);
    if (
      !Number.isFinite(startSeconds) ||
      !Number.isFinite(durationSeconds) ||
      durationSeconds <= 0
    ) {
      toast.error(t("episode.workbench.video.seedance2AssetAudioTrimInvalid"));
      return;
    }
    try {
      const res = await trimSeedance2Asset.mutateAsync({
        beatNum: beat.beat_number,
        assetKey: asset.key,
        sourcePath,
        startSeconds,
        durationSeconds,
      });
      if (isErrorResponse(res)) {
        toast.error(res.error || t("common.error"));
        return;
      }
      toast.success(t("episode.workbench.video.seedance2AssetAudioTrimmed"));
      setSeedance2TrimAsset(null);
    } catch {
      toast.error(t("common.error"));
    }
  };
  const saveLegacyVideoPrompt = async () => {
    const current =
      legacyPromptField === "keyframe_prompt"
        ? (beat.keyframe_prompt ?? "")
        : (beat.video_prompt ?? "");
    if (legacyVideoPrompt === current) return;
    try {
      await updateBeat.mutateAsync({
        beatNum: beat.beat_number,
        data: { [legacyPromptField]: legacyVideoPrompt },
      });
    } catch {
      toast.error(t("episode.workbench.video.regenFailed"));
    }
  };
  const handleGenerateBeatVideoPrompt = async () => {
    try {
      const res = await generateBeatVideoPrompt.mutateAsync({
        beatNum: beat.beat_number,
      });
      if (!res.ok) {
        toast.error(
          res.error || t("episode.workbench.video.beatVideoPromptGenerateFailed"),
        );
        return;
      }
      if (!("data" in res)) {
        beatVideoPromptTask.start();
        toast.success(t("episode.workbench.video.beatVideoPromptGenerateStarted"));
        return;
      }
      setLegacyVideoPrompt(res.data.prompt);
      toast.success(t("episode.workbench.video.beatVideoPromptGenerated"));
    } catch (error) {
      toast.error(backendErrorToastMessage(error, t));
    }
  };

  return (
    <div className={VIDEO_GRID_CLASS}>
      {/* Left: video player — fixed-aspect container keeps layout stable when
          src changes, so switching history versions doesn't reset scroll. */}
      <div
        className={VIDEO_PREVIEW_CLASS}
        style={{ aspectRatio: previewAspectCss }}
      >
        {showSeedance2Config ? (
          <Seedance2MediaPreview
            src={videoSrc}
            state={state}
          />
        ) : videoSrc ? (
          <BeatVideoPlayer src={videoSrc} beatNum={beat.beat_number} />
        ) : (
          <span className="text-xs text-muted-foreground">
            {state === "generating"
              ? t("episode.workbench.video.generating")
              : state === "failed"
                ? `⚠ ${t("episode.workbench.video.genFailed")}`
                : t("episode.workbench.video.notGenerated")}
          </span>
        )}
        {/* Download overlay — sibling of the branch so it shows for both the
            Seedance2 preview and the plain player whenever a video exists. */}
        {videoDownloadUrl && (
          <a
            href={videoDownloadUrl}
            download={`beat_${beat.beat_number}_video.mp4`}
            onClick={(event) => event.stopPropagation()}
            aria-label={t("common.download")}
            title={t("common.download")}
            className="absolute right-2 top-2 z-10 inline-flex size-7 items-center justify-center rounded-[7px] border border-white/[0.12] bg-black/55 text-foreground/85 backdrop-blur-sm transition hover:border-white/[0.22] hover:bg-black/70 hover:text-foreground"
          >
            <Download className="size-3.5" />
          </a>
        )}
        {videoActive && (
          <div
            className="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-[10px] bg-black/55 backdrop-blur-[1px]"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={videoPercent}
          >
            <Loader2 aria-hidden className="size-5 animate-spin text-white/90" />
            <div className="flex items-baseline leading-none text-white">
              <span className="text-2xl font-semibold tabular-nums tracking-tight">
                {videoPercent}
              </span>
              <span className="ml-0.5 text-xs font-medium text-white/70">%</span>
            </div>
            <div className="h-1 w-24 overflow-hidden rounded-full bg-white/20">
              <div
                className="h-full rounded-full bg-white/85 transition-[width] duration-300 ease-out"
                style={{ width: `${videoPercent}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Right: candidate thumbs */}
      <div className="flex min-h-0 flex-col gap-2.5">
        {candidates.length > 0 && (
          <div className={VIDEO_CANDIDATES_CLASS}>
            {candidates.map((entry) => {
              const baseSrc = resolveMediaUrl(entry.video_url);
              // #t=0.1 forces a seek so Safari/iOS paints the first frame
              // without needing a poster image.
              const src = baseSrc ? `${baseSrc}#t=0.1` : null;
              const isActive = entry.id === activePoolId;
              const timeLabel = formatRelativeTime(entry.generated_at ?? null, now);
              const backendLabel = videoBackendDisplayLabel(
                entry.backend,
                videoBackendLabelByValue,
              );
              return (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => handleSelect(entry.id)}
                  disabled={poolSelect.isPending}
                  className={cn(
                    MEDIA_THUMB_CLASS,
                    isActive ? MEDIA_THUMB_ACTIVE_CLASS : MEDIA_THUMB_IDLE_CLASS,
                    poolSelect.isPending && "cursor-wait",
                  )}
                  title={backendLabel}
                >
                  <div className="h-[76px] bg-black" style={{ aspectRatio: frameAspectCss }}>
                    {src && (
                      <video
                        src={src}
                        muted
                        playsInline
                        preload="metadata"
                        disableRemotePlayback
                        disablePictureInPicture
                        className="h-full w-full object-cover"
                      />
                    )}
                  </div>
                  <span className="absolute left-0 top-0 rounded-br bg-black/70 px-1 py-0.5 text-[9px] font-medium leading-none text-white">
                    {backendLabel}
                  </span>
                  {timeLabel && (
                    <span className={MEDIA_THUMB_TIME_CLASS}>
                      {timeLabel}
                    </span>
                  )}
                  {isActive && (
                    <span className={MEDIA_THUMB_ACTIVE_MARK_CLASS}>
                      ✓
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {!showPromptConfig && (
        <div
          className={cn(
            "col-span-2 rounded-[10px] border border-white/[0.055] bg-white/[0.012] p-3",
            showHappyHorseConfig && "order-3",
          )}
        >
          <Seedance2Field label={legacyPromptLabel} htmlFor={legacyPromptId}>
            <Textarea
              id={legacyPromptId}
              aria-label={legacyPromptLabel}
              value={legacyVideoPrompt}
              onChange={(e) => setLegacyVideoPrompt(e.target.value)}
              onBlur={() => void saveLegacyVideoPrompt()}
              rows={3}
              className={cn("min-h-[82px]", SEEDANCE2_TEXTAREA_CLASS)}
            />
          </Seedance2Field>
          <div className="mt-2 flex justify-start">
            <Button
              size="xs"
              variant="outline"
              disabled={
                generateBeatVideoPrompt.isPending || beatVideoPromptTask.started
              }
              onClick={() => void handleGenerateBeatVideoPrompt()}
              className={MEDIA_PRIMARY_ACTION_BUTTON_CLASS}
            >
              {generateBeatVideoPrompt.isPending ||
              beatVideoPromptTask.started ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <WandSparkles className="size-3" />
              )}
              {t("episode.workbench.video.generateBeatVideoPrompt")}
              <CreditCostInline display={beatVideoPromptCostDisplay} />
            </Button>
          </div>
        </div>
      )}

      {/* Full-width action row. Seedance2 keeps its generate action after config. */}
      {!showPromptConfig && (
        <div
          className={cn(
            "col-span-2 flex flex-wrap items-start gap-x-3 gap-y-2 pt-1",
            showHappyHorseConfig && "order-2",
          )}
        >
          {showHappyHorseConfig && (
            <>
              <VideoParamField
                label={t("episode.workbench.video.mode")}
                htmlFor={`happyhorse-${beat.beat_number}-mode`}
              >
                <Select
                  value={seedance2Draft.mode}
                  onValueChange={(v) =>
                    updateSeedance2Mode(normalizeHappyHorseMode(v))
                  }
                >
                  <SelectTrigger
                    id={`happyhorse-${beat.beat_number}-mode`}
                    className={cn("w-28", VIDEO_PARAM_CONTROL_CLASS)}
                  >
                    <span
                      data-slot="select-value"
                      className="flex flex-1 items-center gap-1.5 text-left"
                    >
                      {t(
                        `episode.workbench.video.seedance2ModeLabels.${normalizeHappyHorseMode(
                          seedance2Draft.mode,
                        )}`,
                      )}
                    </span>
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectItem value="first_frame">
                      {t("episode.workbench.video.seedance2ModeLabels.first_frame")}
                    </SelectItem>
                    <SelectItem value="multimodal_reference">
                      {t("episode.workbench.video.seedance2ModeLabels.multimodal_reference")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </VideoParamField>
              <VideoParamField
                label={t("episode.workbench.video.duration")}
                htmlFor={`happyhorse-${beat.beat_number}-duration`}
              >
                <Input
                  id={`happyhorse-${beat.beat_number}-duration`}
                  aria-label={t("episode.workbench.video.duration")}
                  type="number"
                  min={seedance2DurationBounds.min}
                  max={seedance2DurationBounds.max}
                  value={seedance2Draft.duration}
                  onChange={(e) =>
                    updateSeedance2Draft(
                      "duration",
                      clampDuration(e.target.value, seedance2DurationBounds),
                    )
                  }
                  className={cn("w-20", VIDEO_PARAM_CONTROL_CLASS)}
                />
              </VideoParamField>
              <VideoParamField
                label={t("episode.workbench.video.resolution")}
                htmlFor={`happyhorse-${beat.beat_number}-resolution`}
              >
                <Select
                  value={seedance2Draft.resolution}
                  onValueChange={(v) =>
                    updateSeedance2Draft(
                      "resolution",
                      normalizeSeedance2Resolution(v, happyHorseResolutionOptions[0]),
                    )
                  }
                >
                  <SelectTrigger
                    id={`happyhorse-${beat.beat_number}-resolution`}
                    className={cn("w-24", VIDEO_PARAM_CONTROL_CLASS)}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    {happyHorseResolutionOptions.map((resolution) => (
                      <SelectItem key={resolution} value={resolution}>
                        {resolution}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </VideoParamField>
              <VideoParamField
                label={t("episode.workbench.video.ratio")}
                htmlFor={`happyhorse-${beat.beat_number}-ratio`}
              >
                <Select
                  value={seedance2Draft.ratio}
                  onValueChange={(v) =>
                    updateSeedance2Draft("ratio", normalizeHappyHorseRatio(v))
                  }
                >
                  <SelectTrigger
                    id={`happyhorse-${beat.beat_number}-ratio`}
                    className={cn("w-24", VIDEO_PARAM_CONTROL_CLASS)}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    {happyHorseRatioOptions.map((ratio) => (
                      <SelectItem key={ratio} value={ratio}>
                        {ratio}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </VideoParamField>
            </>
          )}
          {isSd15ProConfig && (
            <>
              <VideoParamField
                label={t("episode.workbench.video.duration")}
                htmlFor={`sd15-${beat.beat_number}-duration`}
              >
                <Input
                  id={`sd15-${beat.beat_number}-duration`}
                  aria-label={t("episode.workbench.video.duration")}
                  type="number"
                  min={sd15DurationBounds.min}
                  max={sd15DurationBounds.max}
                  value={sd15Duration}
                  onChange={(e) =>
                    setSd15Duration(
                      clampDuration(e.target.value, sd15DurationBounds),
                    )
                  }
                  className={cn("w-20", VIDEO_PARAM_CONTROL_CLASS)}
                />
              </VideoParamField>
              <VideoParamField
                label={t("episode.workbench.video.resolution")}
                htmlFor={`sd15-${beat.beat_number}-resolution`}
              >
                <Select
                  value={sd15Resolution}
                  onValueChange={(v) =>
                    setSd15Resolution(
                      normalizeSeedance2Resolution(
                        v,
                        seedance2ResolutionOptions[0],
                      ),
                    )
                  }
                >
                  <SelectTrigger
                    id={`sd15-${beat.beat_number}-resolution`}
                    className={cn("w-24", VIDEO_PARAM_CONTROL_CLASS)}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    {seedance2ResolutionOptions.map((resolution) => (
                      <SelectItem key={resolution} value={resolution}>
                        {resolution}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </VideoParamField>
            </>
          )}
          <VideoParamField label="" hiddenLabel>
            {regenTask.started ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() => void regenTask.stop()}
                disabled={regenTask.stopping}
                className={VIDEO_PARAM_ACTION_CLASS}
              >
                {regenTask.stopping ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Square className="size-3" />
                )}
                {t("common.stop")}
              </Button>
            ) : (
              <Button
                size="xs"
                variant="outline"
                onClick={openRegenConfirm}
                disabled={regenerate.isPending}
                className={VIDEO_PARAM_ACTION_CLASS}
              >
                {regenerate.isPending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : hasGeneratedVideo ? (
                  <RefreshCw className="size-3" />
                ) : (
                  <Film className="size-3" />
                )}
                {videoActionLabel}
                <CreditCostInline display={videoCost.data?.data.display} />
              </Button>
            )}
          </VideoParamField>
        </div>
      )}

      {!showPromptConfig && showReferenceDetails && (
        <div
          className={cn(
            "col-span-2 rounded-[10px] border border-white/[0.055] bg-white/[0.012]",
            showHappyHorseConfig && "order-1",
          )}
        >
          <div className="flex items-center gap-2 px-3 py-2">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-expanded={seedance2ReferencesOpen}
              onClick={() => setSeedance2ReferencesOpen((open) => !open)}
              className={SEEDANCE2_COLLAPSE_TRIGGER_CLASS}
            >
              <ChevronDown
                className={cn(
                  "size-3.5 transition-transform",
                  !seedance2ReferencesOpen && "-rotate-90",
                )}
              />
              <Library className="size-3.5 text-muted-foreground/78" />
              <span>{t("episode.workbench.video.seedance2ReferenceDetails")}</span>
            </Button>
            <span className="inline-flex h-5 items-center rounded-full border border-white/[0.075] bg-white/[0.025] px-2 text-[11px] leading-none text-muted-foreground/78">
              {referenceCropImageItems.length}
            </span>
          </div>
          {seedance2ReferencesOpen && (
            <div className="border-t border-white/[0.055] p-3">
              {referenceCropImageItems.length > 0 ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(6.75rem,6.75rem))] gap-2">
                  {referenceCropImageItems.map((asset) => {
                    const assetImageSrc = resolveMediaUrl(asset.url || asset.path);
                    return (
                      <div
                        key={asset.key}
                        data-seedance2-reference-tile
                        className="group/reference-tile relative w-[6.75rem] overflow-hidden rounded-[7px] border border-white/[0.075] bg-white/[0.018] transition-[border-color,background-color,box-shadow] duration-200 hover:border-white/[0.14] hover:bg-white/[0.032]"
                        style={{ aspectRatio: ratioToCss(spec.sketchAspect) }}
                        title={asset.note || asset.label}
                      >
                        {assetImageSrc ? (
                          <img
                            src={assetImageSrc}
                            alt={asset.label}
                            className="absolute inset-0 h-full w-full object-cover"
                            decoding="async"
                          />
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center bg-white/[0.025]">
                            <ImageIcon className="size-6 text-muted-foreground/70" />
                          </div>
                        )}
                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/78 via-black/46 to-transparent p-1.5 pt-5">
                          <div className="truncate text-[10px] font-medium leading-3 text-white/88">
                            {asset.label}
                          </div>
                          {asset.note && (
                            <div className="truncate text-[9px] leading-3 text-white/48">
                              {asset.note}
                            </div>
                          )}
                        </div>
                        {asset.can_crop && (
                          <div className="absolute bottom-1.5 right-1.5 opacity-0 transition-opacity duration-150 group-hover/reference-tile:opacity-100 group-focus-within/reference-tile:opacity-100">
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="size-6 rounded-[6px] border border-white/[0.18] bg-black/70 text-white/90 shadow-[0_4px_12px_rgba(0,0,0,0.35)] backdrop-blur-sm hover:border-white/[0.32] hover:bg-white/[0.16] hover:text-white"
                              aria-label={t("episode.workbench.video.seedance2AssetCrop")}
                              onClick={() =>
                                setSeedance2CropIntent({
                                  asset,
                                  target: "first_frame",
                                })
                              }
                            >
                              <Scissors className="size-3.5" />
                            </Button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="rounded-[8px] border border-dashed border-white/[0.075] bg-white/[0.015] p-2 text-xs text-muted-foreground/78">
                  {t("episode.workbench.video.seedance2ReferenceEmpty")}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {showPromptConfig && (
        <div className="col-span-2 space-y-4 rounded-[10px] border border-white/[0.055] bg-white/[0.016] p-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <Settings2 className="size-3.5 text-muted-foreground/78" />
            <Label className="text-xs font-medium text-foreground/82">
              {showGrokVideoConfig
                ? "Grok Video 检视器"
                : showHappyHorseConfig
                ? "HappyHorse 检视器"
                : t("episode.workbench.video.seedance2Inspector")}
            </Label>
            <Seedance2SummaryPill
              active={seedance2StatusData?.media.render_ready ?? !!beat.frame_url}
              label={t("episode.workbench.video.renderReady")}
            />
            {showAudioMediaStatus && (
              <Seedance2SummaryPill
                active={seedance2StatusData?.media.audio_ready ?? !!beat.audio_url}
                label={t("episode.workbench.video.audioReady")}
              />
            )}
            <Seedance2SummaryPill
              active={seedance2Ready}
              label={seedance2PromptStatus}
            />
            {showSeedance2Config && (
              <Seedance2SummaryPill
                active={seedance2StatusData?.voice.ready ?? false}
                label={
                  seedance2StatusData?.voice.label ??
                  t("episode.workbench.video.narratorVoiceMissing")
                }
              />
            )}
            <span className="inline-flex h-5 max-w-full items-center rounded-full border border-white/[0.075] bg-white/[0.025] px-2 text-[11px] leading-none text-muted-foreground/78">
              {t("episode.workbench.video.seedance2ReferenceStats", {
                selected: seedance2StatusData?.assets.selected ?? 0,
                missing: seedance2StatusData?.assets.missing ?? 0,
              })}
            </span>
            <span className="inline-flex h-5 max-w-full items-center rounded-full border border-white/[0.075] bg-white/[0.025] px-2 text-[11px] leading-none text-muted-foreground/78">
              {t("episode.workbench.video.videoVersions", {
                count: candidates.length,
              })}
            </span>
          </div>

          <div className="rounded-[10px] border border-white/[0.055] bg-white/[0.012]">
            <div className="flex items-center gap-2 px-3 py-2">
              <Button
                type="button"
                size="xs"
                variant="ghost"
                aria-expanded={seedance2ReferencesOpen}
                onClick={() => setSeedance2ReferencesOpen((open) => !open)}
                className={SEEDANCE2_COLLAPSE_TRIGGER_CLASS}
              >
                <ChevronDown
                  className={cn(
                    "size-3.5 transition-transform",
                    !seedance2ReferencesOpen && "-rotate-90",
                  )}
                />
                <Library className="size-3.5 text-muted-foreground/78" />
                <span>{t("episode.workbench.video.seedance2ReferenceDetails")}</span>
              </Button>
              <span className="inline-flex h-5 items-center rounded-full border border-white/[0.075] bg-white/[0.025] px-2 text-[11px] leading-none text-muted-foreground/78">
                {t("episode.workbench.video.seedance2ReferenceStats", {
                  selected: seedance2StatusData?.assets.selected ?? 0,
                  missing: seedance2StatusData?.assets.missing ?? 0,
                })}
              </span>
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={uploadSeedance2Asset.isPending}
                onClick={() => seedance2UploadInputRef.current?.click()}
                className={cn("ml-auto", SEEDANCE2_SECONDARY_ACTION_CLASS)}
              >
                {uploadSeedance2Asset.isPending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Upload className="size-3" />
                )}
                {t("episode.workbench.video.seedance2AssetUpload")}
              </Button>
              <input
                ref={seedance2UploadInputRef}
                type="file"
                className="hidden"
                accept={showHappyHorseConfig || showGrokVideoConfig ? "image/*" : "image/*,audio/*"}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleSeedance2AssetUpload(file);
                  event.target.value = "";
                }}
              />
            </div>
            {seedance2ReferencesOpen && (
              <div className="border-t border-white/[0.055] p-3">
                {modelReferenceAssetItems.length > 0 ? (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(6.75rem,6.75rem))] gap-2">
                    {modelReferenceAssetItems.map((asset) => {
                      const referenceLabel =
                        asset.reference_label && asset.reference_label !== "未发送"
                          ? asset.reference_label
                          : "";
                      const canInsertReference =
                        referenceLabel.length > 0 && asset.exists !== false;
                      const isMissingImage =
                        asset.media_type === "image" && asset.exists === false;
                      const displayReferenceLabel = referenceLabel || (
                        isMissingImage
                          ? t("episode.workbench.video.seedance2ReferenceImage")
                          : asset.reference_label
                      );
                      const assetImageSrc =
                        asset.media_type === "image" &&
                        asset.exists !== false &&
                        (asset.url || asset.path)
                          ? resolveMediaUrl(asset.url || asset.path)
                          : null;
                      const hasFallback =
                        !asset.selected &&
                        asset.media_type === "image" &&
                        asset.exists === false &&
                        asset.note.trim().length > 0;
                      const showTileText =
                        Boolean(assetImageSrc) ||
                        asset.media_type === "audio" ||
                        hasFallback ||
                        asset.exists === false;
                      const hasTileActions =
                        (asset.can_crop && asset.media_type === "image") ||
                        (asset.can_trim && asset.media_type === "audio") ||
                        asset.can_delete;
                      const stateLabel = asset.selected
                        ? t("episode.workbench.video.seedance2ReferenceSent")
                        : hasFallback
                          ? t("episode.workbench.video.seedance2ReferenceFallback")
                          : asset.exists === false
                            ? t("episode.workbench.video.seedance2ReferenceMissing")
                            : t("episode.workbench.video.seedance2ReferenceUnused");
                      return (
                        <div
                          key={asset.key}
                          data-seedance2-reference-tile
                          draggable={canInsertReference}
                          onDragStart={(event) => {
                            if (referenceLabel) {
                              handleSeedance2ReferenceDragStart(event, referenceLabel);
                            }
                          }}
                          className={cn(
                            "group/reference-tile relative aspect-square w-[6.75rem] overflow-hidden rounded-[7px] border border-white/[0.075] bg-white/[0.018] transition-[border-color,background-color,box-shadow] duration-200 hover:border-white/[0.14] hover:bg-white/[0.032]",
                            canInsertReference &&
                              "cursor-grab active:cursor-grabbing hover:shadow-[0_8px_22px_rgba(0,0,0,0.28)]",
                          )}
                          title={asset.note || asset.label}
                        >
                          {assetImageSrc ? (
                            <img
                              src={assetImageSrc}
                              alt={asset.label}
                              draggable={canInsertReference}
                              onDragStart={(event) => {
                                if (referenceLabel) {
                                  handleSeedance2ReferenceDragStart(event, referenceLabel);
                                }
                              }}
                              className={cn(
                                "absolute inset-0 h-full w-full object-cover",
                                canInsertReference && "cursor-grab active:cursor-grabbing",
                              )}
                              decoding="async"
                            />
                          ) : (
                            <div className="absolute inset-0 flex items-center justify-center bg-white/[0.025]">
                              {asset.media_type === "audio" ? (
                                <Mic className="size-6 text-muted-foreground/70" />
                              ) : (
                                <ImageIcon className="size-6 text-muted-foreground/70" />
                              )}
                            </div>
                          )}
                          <div className="absolute inset-x-1 top-1 flex min-w-0 items-center justify-between gap-1">
                            <span className="truncate rounded-[4px] border border-white/[0.08] bg-black/55 px-1 py-0.5 text-[10px] font-medium leading-none text-white/88 shadow-sm backdrop-blur-sm">
                              {displayReferenceLabel}
                            </span>
                            <span
                              className={cn(
                                "shrink-0 rounded-[4px] border px-1 py-0.5 text-[10px] leading-none shadow-sm backdrop-blur-sm",
                                asset.selected
                                  ? "border-primary/35 bg-primary/18 text-primary"
                                  : "border-white/[0.08] bg-black/50 text-white/58",
                              )}
                            >
                              {stateLabel}
                            </span>
                          </div>
                          {showTileText && (
                            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/78 via-black/46 to-transparent p-1.5 pt-5">
                              <div className="truncate text-[10px] font-medium leading-3 text-white/88">
                                {asset.label}
                              </div>
                              {asset.note && (
                                <div className="truncate text-[9px] leading-3 text-white/48">
                                  {asset.note}
                                </div>
                              )}
                            </div>
                          )}
                          {hasTileActions && (
                            <div className="absolute bottom-1.5 right-1.5 flex gap-1 opacity-0 transition-opacity duration-150 group-hover/reference-tile:opacity-100 group-focus-within/reference-tile:opacity-100">
                              {asset.can_crop && asset.media_type === "image" && (
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="ghost"
                                  className="size-6 rounded-[6px] border border-white/[0.18] bg-black/70 text-white/90 shadow-[0_4px_12px_rgba(0,0,0,0.35)] backdrop-blur-sm hover:border-white/[0.32] hover:bg-white/[0.16] hover:text-white"
                                  aria-label={t("episode.workbench.video.seedance2AssetCrop")}
                                  onClick={() =>
                                    setSeedance2CropIntent({
                                      asset,
                                      target: seedance2CropTargetForAsset(
                                        seedance2Draft.mode,
                                        asset,
                                      ),
                                    })
                                  }
                                >
                                  <Scissors className="size-3.5" />
                                </Button>
                              )}
                              {asset.can_trim && asset.media_type === "audio" && (
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="ghost"
                                  className="size-6 rounded-[6px] border border-white/[0.18] bg-black/70 text-white/90 shadow-[0_4px_12px_rgba(0,0,0,0.35)] backdrop-blur-sm hover:border-white/[0.32] hover:bg-white/[0.16] hover:text-white"
                                  aria-label={t("episode.workbench.video.seedance2AssetCrop")}
                                  title={t("episode.workbench.video.seedance2AssetAudioTrim")}
                                  onClick={() => {
                                    setSeedance2TrimStart("0");
                                    setSeedance2TrimDuration("4");
                                    setSeedance2TrimAsset(asset);
                                  }}
                                >
                                  <Scissors className="size-3.5" />
                                </Button>
                              )}
                              {asset.can_delete && (
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="ghost"
                                  disabled={deleteSeedance2Asset.isPending}
                                  className="size-5 rounded-[5px] border border-white/[0.08] bg-black/35 text-white/58 hover:bg-destructive/15 hover:text-destructive"
                                  aria-label={t("episode.workbench.video.seedance2AssetDelete")}
                                  onClick={() => void handleDeleteSeedance2Asset(asset)}
                                >
                                  <Trash2 className="size-2.5" />
                                </Button>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="rounded-[8px] border border-dashed border-white/[0.075] bg-white/[0.015] p-2 text-xs text-muted-foreground/78">
                    {t("episode.workbench.video.seedance2ReferenceEmpty")}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="grid gap-3 rounded-[10px] border border-white/[0.055] bg-white/[0.012] p-3 md:grid-cols-[1.2fr_0.8fr_0.8fr_0.8fr]">
            <Seedance2Field
              label={t("episode.workbench.video.mode")}
              htmlFor={`${seedance2Id}-mode`}
            >
              <Select
                value={seedance2Draft.mode}
                onValueChange={(v) =>
                  updateSeedance2Mode(
                    showHappyHorseConfig || showGrokVideoConfig
                      ? normalizeHappyHorseMode(v)
                      : normalizeSeedance2Mode(v),
                  )
                }
              >
                <SelectTrigger
                  id={`${seedance2Id}-mode`}
                  className={cn("!h-9", SEEDANCE2_CONTROL_CLASS)}
                >
                  <span
                    data-slot="select-value"
                    className="flex flex-1 items-center gap-1.5 text-left"
                  >
                    {t(
                      `episode.workbench.video.seedance2ModeLabels.${
                        showHappyHorseConfig
                          ? normalizeHappyHorseMode(seedance2Draft.mode)
                          : showGrokVideoConfig
                          ? normalizeHappyHorseMode(seedance2Draft.mode)
                          : seedance2Draft.mode
                      }`,
                    )}
                  </span>
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  <SelectItem value="first_frame">
                    {t("episode.workbench.video.seedance2ModeLabels.first_frame")}
                  </SelectItem>
                  {!showHappyHorseConfig && !showGrokVideoConfig && (
                    <SelectItem value="first_last_frame">
                      {t("episode.workbench.video.seedance2ModeLabels.first_last_frame")}
                    </SelectItem>
                  )}
                  <SelectItem value="multimodal_reference">
                    {t("episode.workbench.video.seedance2ModeLabels.multimodal_reference")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </Seedance2Field>
            <Seedance2Field
              label={t("episode.workbench.video.duration")}
              htmlFor={`${seedance2Id}-duration`}
            >
              <Input
                id={`${seedance2Id}-duration`}
                aria-label={t("episode.workbench.video.duration")}
                type="number"
                min={seedance2DurationBounds.min}
                max={seedance2DurationBounds.max}
                value={seedance2Draft.duration}
                onChange={(e) =>
                  updateSeedance2Draft(
                    "duration",
                    clampDuration(e.target.value, seedance2DurationBounds),
                  )
                }
                className={cn("!h-9", SEEDANCE2_CONTROL_CLASS)}
              />
            </Seedance2Field>
            <Seedance2Field
              label={t("episode.workbench.video.resolution")}
              htmlFor={`${seedance2Id}-resolution`}
            >
              <Select
                value={seedance2Draft.resolution}
                onValueChange={(v) =>
                  updateSeedance2Draft(
                    "resolution",
                    normalizeSeedance2Resolution(
                      v,
                      showGrokVideoConfig
                        ? grokVideoResolutionOptions[0]
                        : showHappyHorseConfig
                        ? happyHorseResolutionOptions[0]
                        : seedance2ResolutionOptions[0],
                    ),
                  )
                }
              >
                <SelectTrigger
                  id={`${seedance2Id}-resolution`}
                  className={cn("!h-9", SEEDANCE2_CONTROL_CLASS)}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  {(showHappyHorseConfig
                    ? happyHorseResolutionOptions
                    : showGrokVideoConfig
                    ? grokVideoResolutionOptions
                    : seedance2ResolutionOptions
                  ).map((resolution) => (
                    <SelectItem key={resolution} value={resolution}>
                      {resolution}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Seedance2Field>
            <Seedance2Field
              label={t("episode.workbench.video.ratio")}
              htmlFor={`${seedance2Id}-ratio`}
            >
              <Select
                value={seedance2Draft.ratio}
                onValueChange={(v) =>
                  updateSeedance2Draft(
                    "ratio",
                    showGrokVideoConfig
                      ? normalizeGrokVideoRatio(v)
                      : showHappyHorseConfig
                      ? normalizeHappyHorseRatio(v)
                      : normalizeSeedance2Ratio(v),
                  )
                }
              >
                <SelectTrigger
                  id={`${seedance2Id}-ratio`}
                  className={cn("!h-9", SEEDANCE2_CONTROL_CLASS)}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent alignItemWithTrigger={false}>
                  {(showHappyHorseConfig
                    ? happyHorseRatioOptions
                    : showGrokVideoConfig
                    ? grokVideoRatioOptions
                    : (["9:16", "16:9", "1:1", "4:3", "3:4", "21:9"] as const)
                  ).map((ratio) => (
                    <SelectItem key={ratio} value={ratio}>
                      {ratio}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Seedance2Field>
          </div>

          <div className="flex flex-wrap items-center gap-3 px-1 text-xs text-muted-foreground">
            {showSeedance2Config && (
              <Seedance2Checkbox
                id={`${seedance2Id}-return-last-frame`}
                checked={seedance2Draft.return_last_frame}
                label={t("episode.workbench.video.returnLastFrame")}
                onChange={(checked) => updateSeedance2Draft("return_last_frame", checked)}
              />
            )}
            {showSeedance2ValueStyle && (
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground/80">
                  {t("episode.workbench.video.seedance2GuidanceStyle")}
                </span>
                <div
                  role="radiogroup"
                  aria-label={t("episode.workbench.video.seedance2GuidanceStyle")}
                  className="inline-flex items-center gap-1"
                >
                  {(["anime", "realistic"] as const).map((style) => {
                    const active = seedance2Draft.scene_optimize === style;
                    return (
                      <button
                        key={style}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={cn(
                          SEEDANCE2_SEGMENTED_OPTION_CLASS,
                          active
                            ? "border-cyan-400/45 bg-cyan-400/12 text-cyan-100"
                            : "border-white/[0.075] bg-white/[0.018] text-muted-foreground/75 hover:border-white/[0.14] hover:bg-white/[0.045] hover:text-foreground",
                        )}
                        onClick={() =>
                          updateSeedance2Draft("scene_optimize", style)
                        }
                      >
                        {t(
                          `episode.workbench.video.seedance2SceneOptimizeLabels.${style}`,
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
          {showSeedance2Config && seedance2Draft.return_last_frame && (
            <div
              data-seedance2-returned-last-frame
              data-testid="seedance2-returned-last-frame-panel"
              className="inline-flex w-fit max-w-full flex-col rounded-[8px] border border-white/[0.055] bg-white/[0.012] p-1.5"
            >
              <div className="mb-1 flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
                <ImageIcon className="size-3" />
                <span>{t("episode.workbench.video.returnLastFrame")}</span>
                {seedance2ReturnedLastFrameSrc && seedance2ReturnedLastFrameAsset && (
                  <a
                    href={seedance2ReturnedLastFrameSrc}
                    download
                    className="ml-auto inline-flex h-6 items-center gap-1 rounded-[6px] border border-white/[0.095] bg-white/[0.03] px-2 text-[10px] text-foreground/78 hover:border-white/[0.16] hover:bg-white/[0.055] hover:text-foreground"
                  >
                    <Download className="size-3" />
                    {t("common.download")}
                  </a>
                )}
              </div>
              <div
                data-testid="seedance2-returned-last-frame-box"
                className={cn(
                  "relative w-[7.5rem] max-w-full overflow-hidden rounded-[7px] bg-white/[0.02]",
                  seedance2ReturnedLastFrameSrc && seedance2ReturnedLastFrameAsset
                    ? "border border-white/[0.075]"
                    : "border border-dashed border-white/[0.075]",
                )}
                style={{ aspectRatio: seedance2ReturnedLastFrameAspectCss }}
              >
                {seedance2ReturnedLastFrameSrc && seedance2ReturnedLastFrameAsset ? (
                  <img
                    src={seedance2ReturnedLastFrameSrc}
                    alt={seedance2ReturnedLastFrameAsset.label}
                    className="absolute inset-0 h-full w-full object-contain"
                    decoding="async"
                  />
                ) : (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center text-[10px] text-muted-foreground/72">
                    <ImageIcon className="size-5 opacity-60" />
                    <span>{t("episode.workbench.video.returnLastFramePending")}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          <div
            data-testid="seedance2-prompt-panel"
            className="rounded-[10px] border border-white/[0.055] bg-white/[0.012] p-3"
          >
            <div className="grid gap-3">
              <Seedance2Field
                label={t("episode.workbench.video.seedance2PromptGuidance")}
                htmlFor={`${seedance2Id}-prompt-guidance`}
              >
                <MentionTextarea
                  id={`${seedance2Id}-prompt-guidance`}
                  aria-label={t("episode.workbench.video.seedance2PromptGuidance")}
                  value={seedance2Draft.prompt_guidance}
                  onChange={(e) => {
                    updateSeedance2Draft("prompt_guidance", e.target.value);
                    rememberSeedance2PromptSelection(
                      "prompt_guidance",
                      e.currentTarget,
                    );
                  }}
                  onFocus={(e) =>
                    rememberSeedance2PromptSelection(
                      "prompt_guidance",
                      e.currentTarget,
                    )
                  }
                  onKeyDown={(e) => handleMentionKeyDown("prompt_guidance", e)}
                  onKeyUp={(e) =>
                    rememberSeedance2PromptSelection(
                      "prompt_guidance",
                      e.currentTarget,
                    )
                  }
                  onMouseUp={(e) =>
                    rememberSeedance2PromptSelection(
                      "prompt_guidance",
                      e.currentTarget,
                    )
                  }
                  onSelect={(e) =>
                    rememberSeedance2PromptSelection(
                      "prompt_guidance",
                      e.currentTarget,
                    )
                  }
                  onDragOver={handleSeedance2ReferenceDragOver}
                  onDrop={(e) => handleSeedance2ReferenceDrop("prompt_guidance", e)}
                  mentionLabels={seedance2ReferenceLabels}
                  mentionPreviews={seedance2MentionPreviews}
                  rows={2}
                  className={cn("min-h-[72px]", SEEDANCE2_TEXTAREA_CLASS)}
                />
              </Seedance2Field>
              {renderSeedance2ReferenceControls("prompt_guidance")}
              <div className="flex flex-wrap gap-1.5">
                {SEEDANCE2_PROMPT_GUIDANCE_TEMPLATES.map((template) => (
                  <Button
                    key={template.key}
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={updateBeat.isPending}
                    className={SEEDANCE2_PILL_ACTION_CLASS}
                    onClick={() =>
                      appendSeedance2PromptGuidanceTemplate(template.text)
                    }
                  >
                    {t(`episode.workbench.video.${template.labelKey}`)}
                  </Button>
                ))}
              </div>
              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Label
                    htmlFor={`${seedance2Id}-prompt`}
                    className="text-[11px] text-muted-foreground/78"
                  >
                    {showGrokVideoConfig
                      ? "Grok 提示词"
                      : showHappyHorseConfig
                      ? "主体提示词"
                      : t("episode.workbench.video.seedance2Prompt")}
                  </Label>
                </div>
                <MentionTextarea
                  id={`${seedance2Id}-prompt`}
                  aria-label={t("episode.workbench.video.seedance2Prompt")}
                  value={seedance2Draft.final_prompt}
                  onChange={(e) => {
                    updateSeedance2Draft("final_prompt", e.target.value);
                    rememberSeedance2PromptSelection(
                      "final_prompt",
                      e.currentTarget,
                    );
                  }}
                  onFocus={(e) =>
                    rememberSeedance2PromptSelection(
                      "final_prompt",
                      e.currentTarget,
                    )
                  }
                  onKeyDown={(e) => handleMentionKeyDown("final_prompt", e)}
                  onKeyUp={(e) =>
                    rememberSeedance2PromptSelection(
                      "final_prompt",
                      e.currentTarget,
                    )
                  }
                  onMouseUp={(e) =>
                    rememberSeedance2PromptSelection(
                      "final_prompt",
                      e.currentTarget,
                    )
                  }
                  onSelect={(e) =>
                    rememberSeedance2PromptSelection(
                      "final_prompt",
                      e.currentTarget,
                    )
                  }
                  onDragOver={handleSeedance2ReferenceDragOver}
                  onDrop={(e) => handleSeedance2ReferenceDrop("final_prompt", e)}
                  mentionLabels={seedance2ReferenceLabels}
                  mentionPreviews={seedance2MentionPreviews}
                  rows={2}
                  className={cn("min-h-[72px]", SEEDANCE2_TEXTAREA_CLASS)}
                />
                {renderSeedance2ReferenceControls("final_prompt")}
              </div>
              <div className="flex flex-wrap justify-start gap-2 pt-1">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={generateSeedance2Prompt.isPending}
                  onClick={handleGenerateSeedance2Prompt}
                  className={MEDIA_PRIMARY_ACTION_BUTTON_CLASS}
                >
                  {generateSeedance2Prompt.isPending ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <WandSparkles className="size-3" />
                  )}
                  {showGrokVideoConfig
                    ? "生成 Grok 提示词"
                    : showHappyHorseConfig
                    ? "生成主体提示词"
                    : t("episode.workbench.video.seedance2GeneratePrompt")}
                  <CreditCostInline display={seedance2PromptCostDisplay} />
                </Button>
                {regenTask.started ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void regenTask.stop()}
                    disabled={regenTask.stopping}
                    className={MEDIA_PRIMARY_ACTION_BUTTON_CLASS}
                  >
                    {regenTask.stopping ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Square className="size-3" />
                    )}
                    {t("common.stop")}
                  </Button>
                ) : (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={openRegenConfirm}
                    disabled={regenerate.isPending}
                    className={MEDIA_PRIMARY_ACTION_BUTTON_CLASS}
                  >
                    {regenerate.isPending ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : hasGeneratedVideo ? (
                      <RefreshCw className="size-3" />
                    ) : (
                      <Film className="size-3" />
                    )}
                    {videoActionLabel}
                    <CreditCostInline display={videoCost.data?.data.display} />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <Seedance2AssetCropDialog
        intent={seedance2CropIntent}
        targetCropAspect={
          showSeedance2Config || showHappyHorseConfig || showGrokVideoConfig
            ? seedance2Draft.ratio
            : videoInputCropAspectForProjectAspect(spec.renderAspect)
        }
        pending={cropSeedance2Asset.isPending}
        onOpenChange={(open) => {
          if (!open) setSeedance2CropIntent(null);
        }}
        onSave={handleCropSeedance2Asset}
      />
      <Seedance2AudioTrimDialog
        asset={seedance2TrimAsset}
        start={seedance2TrimStart}
        duration={seedance2TrimDuration}
        pending={trimSeedance2Asset.isPending}
        onStartChange={setSeedance2TrimStart}
        onDurationChange={setSeedance2TrimDuration}
        onOpenChange={(open) => {
          if (!open) setSeedance2TrimAsset(null);
        }}
        onSave={handleTrimSeedance2Asset}
      />

      <AlertDialog open={regenConfirm} onOpenChange={setRegenConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {hasGeneratedVideo
                ? t("episode.workbench.video.regenTitle")
                : t("episode.workbench.video.genTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {hasGeneratedVideo
                ? t("episode.workbench.video.regenDesc", { n: beat.beat_number })
                : t("episode.workbench.video.genDesc", { n: beat.beat_number })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!validateVideoPromptReady()) return;
                setRegenConfirm(false);
                handleRegen();
              }}
            >
              {t("common.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Seedance2AssetCropDialog({
  intent,
  targetCropAspect,
  pending,
  onOpenChange,
  onSave,
}: {
  intent: Seedance2CropIntent | null;
  targetCropAspect: Seedance2CropAspect;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (
    asset: Seedance2AssetItem,
    target: VideoInputCropTarget,
    crop: { x: number; y: number; width: number; height: number },
  ) => void;
}) {
  const { t } = useTranslation();
  const asset = intent?.asset ?? null;
  const imageRef = useRef<HTMLImageElement | null>(null);
  const cropBoxRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    crop: { x: number; y: number; width: number; height: number };
  } | null>(null);
  const [imageSize, setImageSize] = useState({ width: 1, height: 1 });
  const [crop, setCrop] = useState({ x: 0, y: 0, width: 1, height: 1 });
  const [cropAspect, setCropAspect] =
    useState<Seedance2CropAspect>(targetCropAspect);
  const imageSrc = resolveMediaUrl(
    asset?.crop_source_url ||
      asset?.crop_source_path ||
      asset?.url ||
      asset?.path,
  );
  const cropAspectRatio = cropAspectRatioValue(cropAspect);

  useEffect(() => {
    if (!asset) return;
    setImageSize({ width: 1, height: 1 });
    setCrop({ x: 0, y: 0, width: 1, height: 1 });
    setCropAspect(targetCropAspect);
  }, [asset, targetCropAspect]);

  useEffect(() => {
    const cropBox = cropBoxRef.current;
    if (!cropBox || !asset) return;

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setCrop((current) =>
        zoomCropBox(
          current,
          imageSize.width,
          imageSize.height,
          event.deltaY < 0 ? 0.9 : 1.1,
        ),
      );
    };

    cropBox.addEventListener("wheel", handleWheel, { passive: false });
    return () => cropBox.removeEventListener("wheel", handleWheel);
  }, [asset, imageSize.height, imageSize.width]);

  const cropBoxStyle = cropBoxPercentStyle(crop, imageSize.width, imageSize.height);

  const moveCropBox = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || !imageRef.current) return;
    const imageRect = imageRef.current.getBoundingClientRect();
    if (imageRect.width <= 0 || imageRect.height <= 0) return;

    const scaleX = imageSize.width / imageRect.width;
    const scaleY = imageSize.height / imageRect.height;
    const drag = dragRef.current;
    setCrop(
      clampCropBox(
        {
          ...drag.crop,
          x: drag.crop.x + (event.clientX - drag.clientX) * scaleX,
          y: drag.crop.y + (event.clientY - drag.clientY) * scaleY,
        },
        imageSize.width,
        imageSize.height,
      ),
    );
  };

  return (
    <Dialog open={asset !== null} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="gap-0 overflow-hidden rounded-none border-0 bg-black p-0 text-white ring-white/10 sm:max-w-[min(96vw,1120px)]"
      >
        <div className="relative flex h-12 items-center border-b border-white/10 px-4">
          <div className="flex items-center gap-2 text-sm font-medium text-white">
            <Scissors className="size-4" />
            {`裁剪 ${cropAspect}`}
          </div>
          <DialogTitle className="absolute left-1/2 max-w-[52vw] -translate-x-1/2 truncate text-center text-sm font-medium text-white">
            {t("episode.workbench.video.seedance2AssetCropTitle")}
          </DialogTitle>
          <button
            type="button"
            aria-label="关闭"
            className="absolute right-4 flex size-7 items-center justify-center text-white/90 hover:text-white"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-5" />
          </button>
        </div>
        {asset && (
          <>
            <div className="relative flex min-h-[360px] items-center justify-center bg-black p-4">
              {imageSrc ? (
                <div className="relative inline-block max-h-[72vh] max-w-full">
                  <img
                    ref={imageRef}
                    src={imageSrc}
                    alt={asset.label}
                    className="block max-h-[72vh] max-w-full object-contain"
                    decoding="async"
                    onLoad={(event) => {
                      const img = event.currentTarget;
                      const width = Math.max(1, img.naturalWidth);
                      const height = Math.max(1, img.naturalHeight);
                      setImageSize({ width, height });
                      setCrop(centerCropBoxForRatio(width, height, cropAspectRatio));
                    }}
                  />
                  <div
                    ref={cropBoxRef}
                    role="button"
                    tabIndex={0}
                    aria-label="移动裁剪区域"
                    className="absolute cursor-move touch-none border-2 border-cyan-400 shadow-[0_0_0_9999px_rgba(0,0,0,0.58)]"
                    style={cropBoxStyle}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.currentTarget.setPointerCapture?.(event.pointerId);
                      dragRef.current = {
                        pointerId: event.pointerId,
                        clientX: event.clientX,
                        clientY: event.clientY,
                        crop,
                      };
                    }}
                    onPointerMove={moveCropBox}
                    onPointerUp={(event) => {
                      event.currentTarget.releasePointerCapture?.(event.pointerId);
                      dragRef.current = null;
                    }}
                    onPointerCancel={(event) => {
                      event.currentTarget.releasePointerCapture?.(event.pointerId);
                      dragRef.current = null;
                    }}
                  >
                    <div className="pointer-events-none absolute inset-y-0 left-1/3 border-l border-white/30" />
                    <div className="pointer-events-none absolute inset-y-0 left-2/3 border-l border-white/30" />
                    <div className="pointer-events-none absolute inset-x-0 top-1/3 border-t border-white/30" />
                    <div className="pointer-events-none absolute inset-x-0 top-2/3 border-t border-white/30" />
                  </div>
                </div>
              ) : (
                <div className="flex h-[240px] items-center justify-center text-sm text-muted-foreground">
                  {t("episode.workbench.video.seedance2ReferenceMissing")}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-white/10 bg-black px-4 py-3">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  if (!intent) return;
                  onSave(intent.asset, intent.target, crop);
                }}
                disabled={pending || !imageSrc}
                className="gap-1"
              >
                {pending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Scissors className="size-3.5" />
                )}
                {t("episode.workbench.video.seedance2AssetCrop")}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Seedance2AudioTrimDialog({
  asset,
  start,
  duration,
  pending,
  onStartChange,
  onDurationChange,
  onOpenChange,
  onSave,
}: {
  asset: Seedance2AssetItem | null;
  start: string;
  duration: string;
  pending: boolean;
  onStartChange: (value: string) => void;
  onDurationChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const audioSrc = resolveMediaUrl(asset?.url || asset?.path);

  return (
    <Dialog open={asset !== null} onOpenChange={onOpenChange}>
      <DialogContent className="gap-4 overflow-hidden rounded-2xl border border-white/8 bg-background/68 p-7 shadow-none backdrop-blur-3xl sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("episode.workbench.video.seedance2AssetAudioTrimTitle")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs leading-5 text-muted-foreground">
            {t("episode.workbench.video.seedance2AssetAudioTrimHint")}
          </p>
          {audioSrc && <audio src={audioSrc} controls className="h-8 w-full" />}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                {t("episode.workbench.video.seedance2AssetAudioTrimStart")}
              </Label>
              <Input
                type="number"
                min="0"
                step="0.1"
                value={start}
                onChange={(event) => onStartChange(event.target.value)}
                className="h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                {t("episode.workbench.video.seedance2AssetAudioTrimDuration")}
              </Label>
              <Input
                type="number"
                min="0.1"
                max="15"
                step="0.1"
                value={duration}
                onChange={(event) => onDurationChange(event.target.value)}
                className="h-9"
              />
            </div>
          </div>
        </div>
        <DialogFooter className="-mx-7 -mb-7 border-t-0 bg-transparent p-7 pt-3 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="h-10 rounded-md border-white/18 bg-white/[0.06] px-4 text-sm font-normal text-foreground/80 hover:border-white/28 hover:bg-white/[0.1] hover:text-foreground"
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={pending}
            onClick={onSave}
            className="h-10 rounded-md bg-primary px-4 text-sm font-normal text-primary-foreground shadow-lg shadow-primary/15 hover:bg-primary/90"
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Scissors className="size-3.5" />
            )}
            {t("episode.workbench.video.seedance2AssetAudioTrimApply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function cropBoxPercentStyle(
  crop: { x: number; y: number; width: number; height: number },
  sourceWidth: number,
  sourceHeight: number,
): CSSProperties {
  const safeWidth = Math.max(1, sourceWidth);
  const safeHeight = Math.max(1, sourceHeight);

  return {
    left: `${(crop.x / safeWidth) * 100}%`,
    top: `${(crop.y / safeHeight) * 100}%`,
    width: `${(crop.width / safeWidth) * 100}%`,
    height: `${(crop.height / safeHeight) * 100}%`,
  };
}

function clampCropBox(
  crop: { x: number; y: number; width: number; height: number },
  sourceWidth: number,
  sourceHeight: number,
) {
  const width = Math.max(1, Math.min(Math.round(crop.width), sourceWidth));
  const height = Math.max(1, Math.min(Math.round(crop.height), sourceHeight));

  return {
    x: Math.min(Math.max(0, Math.round(crop.x)), Math.max(0, sourceWidth - width)),
    y: Math.min(Math.max(0, Math.round(crop.y)), Math.max(0, sourceHeight - height)),
    width,
    height,
  };
}

function BeatVideoPlayer({ src, beatNum }: { src: string; beatNum: number }) {
  return (
    <video
      key={beatNum}
      src={src}
      controls
      playsInline
      preload="metadata"
      disableRemotePlayback
      disablePictureInPicture
      controlsList="nodownload noplaybackrate noremoteplayback"
      className="h-full w-full object-contain"
    />
  );
}

function Seedance2MediaPreview({
  src,
  state,
}: {
  src: string | null;
  state: BeatStageState;
}) {
  const { t } = useTranslation();
  if (!src) {
    return (
      <span className="px-3 text-center text-xs text-muted-foreground">
        {state === "generating"
          ? t("episode.workbench.video.generating")
          : t("episode.workbench.video.previewMissing.video")}
      </span>
    );
  }
  return <BeatVideoPlayer src={src} beatNum={0} />;
}

function isErrorResponse(res: unknown): res is { ok: false; error?: string } {
  return Boolean(res && typeof res === "object" && (res as { ok?: unknown }).ok === false);
}

function Seedance2SummaryPill({
  active,
  label,
}: {
  active: boolean;
  label: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 max-w-full items-center rounded-full border px-2 text-[11px] leading-none",
        active
          ? "border-primary/35 bg-primary/[0.07] text-primary/90"
          : "border-white/[0.075] bg-white/[0.025] text-muted-foreground/78",
      )}
    >
      <span
        className={cn(
          "mr-1.5 size-1.5 shrink-0 rounded-full",
          active ? "bg-primary" : "bg-muted-foreground/35",
        )}
      />
      <span className="truncate">{label}</span>
    </span>
  );
}

function Seedance2Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={htmlFor} className="text-[10px] text-muted-foreground/78">
        {label}
      </Label>
      {children}
    </div>
  );
}

function VideoParamField({
  label,
  htmlFor,
  hiddenLabel = false,
  children,
}: {
  label: string;
  htmlFor?: string;
  hiddenLabel?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {hiddenLabel ? (
        <span aria-hidden className="h-3.5 text-[10px] leading-[14px]">
          &nbsp;
        </span>
      ) : (
        <Label
          htmlFor={htmlFor}
          className="h-3.5 text-[10px] leading-[14px] text-muted-foreground/78"
        >
          {label}
        </Label>
      )}
      {children}
    </div>
  );
}

function Seedance2Checkbox({
  id,
  checked,
  label,
  onChange,
}: {
  id: string;
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
      />
      <label htmlFor={id} className="cursor-pointer">
        {label}
      </label>
    </div>
  );
}

function parseSeedance2Config(
  value: string | null | undefined,
  defaultRatio: Seedance2ConfigDraft["ratio"] = "9:16",
): Seedance2ConfigDraft {
  const text = String(value ?? "").trim();
  if (!text) return defaultSeedance2Config({}, defaultRatio);
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const raw = parsed as Record<string, unknown>;
      return defaultSeedance2Config(raw, defaultRatio);
    }
  } catch {
    return defaultSeedance2Config({ final_prompt: text }, defaultRatio);
  }
  return defaultSeedance2Config({}, defaultRatio);
}

function isSeedanceReferenceCropBackend(value: string | null | undefined): boolean {
  const model = seedance2ModelFromBackend(value);
  return (
    model === "seedance-1.0-pro-fast" ||
    model === "seedance-1.0-pro" ||
    model === "seedance_1.0_pro_fast" ||
    isSeedance15ProBackend(value)
  );
}

function seedance2DefaultRatioForProjectAspect(
  aspect: "2:3" | "16:9",
): Seedance2ConfigDraft["ratio"] {
  return aspect === "16:9" ? "16:9" : "9:16";
}

function seedance2CropTargetForAsset(
  mode: Seedance2ConfigDraft["mode"],
  asset: Seedance2AssetItem,
): VideoInputCropTarget {
  if (mode === "first_frame") return "first_frame";
  if (mode === "first_last_frame") {
    return asset.key === "last_frame" ? "last_frame" : "first_frame";
  }
  return "reference_image";
}

function videoInputCropAspectForProjectAspect(
  aspect: "2:3" | "16:9",
): Seedance2CropAspect {
  return aspect === "16:9" ? "16:9" : "9:16";
}

function cropAspectRatioValue(aspect: Seedance2CropAspect): number {
  const [width, height] = aspect.split(":").map(Number);
  return width > 0 && height > 0 ? width / height : 9 / 16;
}

function defaultSeedance2Config(
  raw: Record<string, unknown>,
  defaultRatio: Seedance2ConfigDraft["ratio"],
): Seedance2ConfigDraft {
  const textOverlay =
    raw.text_overlay && typeof raw.text_overlay === "object" && !Array.isArray(raw.text_overlay)
      ? (raw.text_overlay as Record<string, unknown>)
      : {};
  const modeUserSet = raw.mode_user_set === true;
  const rawMode = normalizeSeedance2Mode(raw.mode);
  return {
    raw,
    mode: !modeUserSet && raw.mode === "first_frame" ? "multimodal_reference" : rawMode,
    mode_user_set: modeUserSet,
    duration: clampDuration(raw.duration),
    resolution: normalizeSeedance2Resolution(raw.resolution),
    ratio: normalizeSeedance2Ratio(raw.ratio, defaultRatio),
    generate_audio_user_set: false,
    generate_audio: true,
    return_last_frame: raw.return_last_frame === true,
    scene_optimize: normalizeSeedance2SceneOptimize(raw.scene_optimize),
    human_review_user_set: raw.human_review_user_set === true,
    human_review:
      raw.human_review === false && raw.human_review_user_set === true
        ? false
        : true,
    prompt_source: String(raw.prompt_source ?? ""),
    prompt_guidance: String(raw.prompt_guidance ?? ""),
    final_prompt: String(raw.final_prompt ?? ""),
    text_overlay: {
      enabled: textOverlay.enabled === true,
      kind: normalizeSeedance2TextOverlayKind(textOverlay.kind),
      content: String(textOverlay.content ?? ""),
      placement: String(textOverlay.placement ?? "画面下方居中"),
      timing: String(textOverlay.timing ?? "全片持续"),
      style: String(textOverlay.style ?? "干净易读"),
      speaker: String(textOverlay.speaker ?? ""),
    },
  };
}

function normalizeSeedance2Mode(value: unknown): Seedance2ConfigDraft["mode"] {
  if (
    value === "first_frame" ||
    value === "first_last_frame" ||
    value === "multimodal_reference"
  ) {
    return value;
  }
  return "multimodal_reference";
}

function isSeedance2ValueBackend(value: string | null | undefined): boolean {
  const text = String(value ?? "").trim().toLowerCase();
  return (
    text === "newapi_seedance-2.0-value" ||
    text === "newapi_seedance-2.0-fast-value" ||
    text === "huimeng_seedance-2.0-value" ||
    text === "huimeng_seedance-2.0-fast-value"
  );
}

function seedance2ModelFromBackend(value: string | null | undefined): string {
  const text = String(value ?? "").trim().toLowerCase();
  for (const prefix of ["newapi_", "huimeng_", "huimengi_"]) {
    if (text.startsWith(prefix)) return text.slice(prefix.length);
  }
  return text;
}

// seedance-1.5-pro（有声）走非 seedance2 生成器路径，但同样需要清晰度/时长控件（精品剧+解说剧）。
function isSeedance15ProBackend(value: string | null | undefined): boolean {
  const model = seedance2ModelFromBackend(value);
  return model === "seedance-1.5-pro" || model === "seedance_pro";
}

function seedance2ResolutionOptionsForBackend(
  value: string | null | undefined,
): readonly Seedance2Resolution[] {
  const model = seedance2ModelFromBackend(value);
  return (
    SEEDANCE2_RESOLUTION_OPTIONS_BY_MODEL[
      model as keyof typeof SEEDANCE2_RESOLUTION_OPTIONS_BY_MODEL
    ] ?? SEEDANCE2_DEFAULT_RESOLUTION_OPTIONS
  );
}

function normalizeSeedance2DraftForBackend(
  draft: Seedance2ConfigDraft,
  resolutionOptions: readonly Seedance2Resolution[],
  backend: string | null | undefined,
  isValueStyle: boolean,
): Seedance2ConfigDraft {
  const fallbackResolution = resolutionOptions.includes("720p")
    ? "720p"
    : resolutionOptions[0] || "720p";
  const resolution = resolutionOptions.includes(draft.resolution)
    ? draft.resolution
    : fallbackResolution;
  const sceneOptimize = isValueStyle
    ? draft.scene_optimize || defaultSeedance2ValueSceneOptimize(backend)
    : "";
  if (draft.resolution === resolution && draft.scene_optimize === sceneOptimize) {
    return draft;
  }
  return {
    ...draft,
    resolution,
    scene_optimize: sceneOptimize,
  };
}

function happyHorseResolutionOptionsForBackend(
  backend: VideoBackendOption | null | undefined,
): readonly Seedance2Resolution[] {
  const options = backend?.resolution_options?.filter(
    (value): value is Seedance2Resolution =>
      value === "720p" || value === "1080p",
  );
  return options?.length ? options : HAPPYHORSE_RESOLUTION_OPTIONS;
}

function happyHorseRatioOptionsForBackend(
  backend: VideoBackendOption | null | undefined,
): readonly HappyHorseRatio[] {
  const options = backend?.ratio_options?.filter(
    (value): value is HappyHorseRatio =>
      value === "16:9" ||
      value === "9:16" ||
      value === "1:1" ||
      value === "4:3" ||
      value === "3:4",
  );
  return options?.length ? options : HAPPYHORSE_RATIO_OPTIONS;
}

function grokVideoResolutionOptionsForBackend(
  backend: VideoBackendOption | null | undefined,
): readonly Seedance2Resolution[] {
  const options = backend?.resolution_options?.filter(
    (value): value is Seedance2Resolution => value === "720p" || value === "480p",
  );
  return options?.length ? options : GROK_VIDEO_RESOLUTION_OPTIONS;
}

function grokVideoRatioOptionsForBackend(
  backend: VideoBackendOption | null | undefined,
): readonly GrokVideoRatio[] {
  const options = backend?.ratio_options?.filter(
    (value): value is GrokVideoRatio =>
      value === "16:9" ||
      value === "9:16" ||
      value === "1:1" ||
      value === "2:3" ||
      value === "3:2",
  );
  return options?.length ? options : GROK_VIDEO_RATIO_OPTIONS;
}

function normalizeHappyHorseMode(value: unknown): Seedance2ConfigDraft["mode"] {
  return value === "first_frame" ? "first_frame" : "multimodal_reference";
}

function normalizeHappyHorseRatio(
  value: unknown,
  fallback: HappyHorseRatio = "16:9",
): HappyHorseRatio {
  return HAPPYHORSE_RATIO_OPTIONS.includes(value as HappyHorseRatio)
    ? (value as HappyHorseRatio)
    : fallback;
}

function normalizeGrokVideoRatio(
  value: unknown,
  fallback: GrokVideoRatio = "16:9",
): GrokVideoRatio {
  return GROK_VIDEO_RATIO_OPTIONS.includes(value as GrokVideoRatio)
    ? (value as GrokVideoRatio)
    : fallback;
}

function normalizeHappyHorseDraftForBackend(
  draft: Seedance2ConfigDraft,
  resolutionOptions: readonly Seedance2Resolution[],
  ratioOptions: readonly HappyHorseRatio[],
): Seedance2ConfigDraft {
  const fallbackResolution = resolutionOptions.includes("1080p")
    ? "1080p"
    : resolutionOptions[0] || "720p";
  const resolution = resolutionOptions.includes(draft.resolution)
    ? draft.resolution
    : fallbackResolution;
  const fallbackRatio = ratioOptions[0] || "16:9";
  const ratio = ratioOptions.includes(draft.ratio as HappyHorseRatio)
    ? draft.ratio
    : fallbackRatio;
  const mode = normalizeHappyHorseMode(draft.mode);
  if (
    draft.mode === mode &&
    draft.resolution === resolution &&
    draft.ratio === ratio &&
    draft.generate_audio === false &&
    draft.return_last_frame === false &&
    draft.scene_optimize === "" &&
    draft.human_review === false
  ) {
    return draft;
  }
  return {
    ...draft,
    mode,
    mode_user_set: true,
    resolution,
    ratio,
    generate_audio: false,
    generate_audio_user_set: false,
    return_last_frame: false,
    scene_optimize: "",
    human_review: false,
    human_review_user_set: false,
  };
}

function normalizeGrokVideoDraftForBackend(
  draft: Seedance2ConfigDraft,
  resolutionOptions: readonly Seedance2Resolution[],
  ratioOptions: readonly GrokVideoRatio[],
): Seedance2ConfigDraft {
  const fallbackResolution = resolutionOptions.includes("720p")
    ? "720p"
    : resolutionOptions[0] || "720p";
  const resolution = resolutionOptions.includes(draft.resolution)
    ? draft.resolution
    : fallbackResolution;
  const fallbackRatio = ratioOptions[0] || "16:9";
  const ratio = ratioOptions.includes(draft.ratio as GrokVideoRatio)
    ? draft.ratio
    : fallbackRatio;
  const mode = normalizeHappyHorseMode(draft.mode);
  if (
    draft.mode === mode &&
    draft.resolution === resolution &&
    draft.ratio === ratio &&
    draft.generate_audio === false &&
    draft.return_last_frame === false &&
    draft.scene_optimize === "" &&
    draft.human_review === false
  ) {
    return draft;
  }
  return {
    ...draft,
    mode,
    mode_user_set: true,
    resolution,
    ratio,
    generate_audio: false,
    generate_audio_user_set: false,
    return_last_frame: false,
    scene_optimize: "",
    human_review: false,
    human_review_user_set: false,
  };
}

function seedance2DurationBoundsForBackend(
  backend: { min_duration?: number | null; max_duration?: number | null } | null | undefined,
): Seedance2DurationBounds {
  const min = Number(backend?.min_duration);
  const max = Number(backend?.max_duration);
  const safeMin = Number.isFinite(min) && min > 0 ? Math.round(min) : 1;
  const safeMax = Number.isFinite(max) && max >= safeMin ? Math.round(max) : 15;
  return { min: safeMin, max: safeMax };
}

function videoBackendDisplayLabel(
  value: string | null | undefined,
  labels: ReadonlyMap<string, string>,
): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const exact = labels.get(text);
  if (exact) return exact;
  const model = seedance2ModelFromBackend(text);
  if (model.startsWith("seedance-2.0")) {
    return `Seedance ${model.slice("seedance-".length)}`;
  }
  return text
    .replace(/^newapi_/, "")
    .replace(/^huimengi?_/, "")
    .replace(/_/g, " ");
}

function defaultSeedance2ValueSceneOptimize(
  value: string | null | undefined,
): Seedance2ConfigDraft["scene_optimize"] {
  const text = String(value ?? "").trim().toLowerCase();
  return text.includes("fast-value") ? "realistic" : "anime";
}

function normalizeSeedance2SceneOptimize(
  value: unknown,
): Seedance2ConfigDraft["scene_optimize"] {
  if (value === "anime" || value === "realistic") return value;
  return "";
}

function normalizeSeedance2Resolution(
  value: unknown,
  fallback: Seedance2Resolution = "720p",
): Seedance2Resolution {
  if (value === "480p" || value === "720p" || value === "1080p") return value;
  return fallback;
}

function normalizeSeedance2TextOverlayKind(value: unknown): string {
  if (
    value === "ad_copy" ||
    value === "subtitle" ||
    value === "speech_bubble"
  ) {
    return value;
  }
  if (value === "caption") return "subtitle";
  return "subtitle";
}

function getSeedance2MentionMatch(text: string): RegExpExecArray | null {
  return /@([^\s@]*)$/u.exec(text.trimEnd());
}

function getSeedance2MentionQuery(text: string): string | null {
  const match = getSeedance2MentionMatch(text);
  return match ? match[1] ?? "" : null;
}


function normalizeSeedance2Ratio(
  value: unknown,
  fallback: Seedance2ConfigDraft["ratio"] = "9:16",
): Seedance2ConfigDraft["ratio"] {
  if (
    value === "9:16" ||
    value === "16:9" ||
    value === "1:1" ||
    value === "4:3" ||
    value === "3:4" ||
    value === "21:9" ||
    value === "2:3" ||
    value === "3:2"
  ) {
    return value;
  }
  return fallback;
}

function clampDuration(
  value: unknown,
  bounds: Seedance2DurationBounds = { min: 1, max: 15 },
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return Math.max(bounds.min, Math.min(bounds.max, 5));
  }
  return Math.max(bounds.min, Math.min(bounds.max, Math.round(parsed)));
}

function sameSeedance2Config(
  left: Seedance2ConfigDraft,
  right: Seedance2ConfigDraft,
): boolean {
  return (
    left.mode === right.mode &&
    left.mode_user_set === right.mode_user_set &&
    left.duration === right.duration &&
    left.resolution === right.resolution &&
    left.ratio === right.ratio &&
    left.generate_audio === right.generate_audio &&
    left.generate_audio_user_set === right.generate_audio_user_set &&
    left.return_last_frame === right.return_last_frame &&
    left.scene_optimize === right.scene_optimize &&
    left.human_review === right.human_review &&
    left.human_review_user_set === right.human_review_user_set &&
    left.prompt_guidance === right.prompt_guidance &&
    left.final_prompt === right.final_prompt &&
    JSON.stringify(left.text_overlay) === JSON.stringify(right.text_overlay)
  );
}

function serializeSeedance2Config(
  draft: Seedance2ConfigDraft,
  previous: Seedance2ConfigDraft,
): Record<string, unknown> {
  // Keep the prompt verbatim (do NOT trim) so a trailing space left by an
  // inserted @mention survives the autosave → re-parse → draft-reset round-trip.
  // Trimming here used to strip the last mention's separator space, which then
  // flowed back into the editor and glued the next reference onto it. The
  // trailing space is harmless to the backend (it substring-matches mentions).
  // A trimmed copy is still used for the manual/auto prompt_source decision.
  const finalPrompt = draft.final_prompt;
  const trimmedFinalPrompt = finalPrompt.trim();
  return {
    ...draft.raw,
    mode: draft.mode,
    mode_user_set: draft.mode_user_set,
    duration: draft.duration,
    resolution: draft.resolution,
    ratio: draft.ratio,
    generate_audio: true,
    generate_audio_user_set: false,
    return_last_frame: draft.return_last_frame,
    scene_optimize: draft.scene_optimize,
    human_review: draft.human_review,
    human_review_user_set: draft.human_review_user_set,
    prompt_guidance: draft.prompt_guidance.trim(),
    final_prompt: finalPrompt,
    text_overlay: {
      ...draft.text_overlay,
      enabled: false,
      content: draft.text_overlay.content.trim(),
      style: draft.text_overlay.style.trim(),
      speaker: draft.text_overlay.speaker.trim(),
    },
    prompt_source:
      trimmedFinalPrompt !== previous.final_prompt.trim()
        ? trimmedFinalPrompt
          ? "manual"
          : ""
        : draft.prompt_source,
  };
}

function serializeHappyHorseConfig(
  draft: Seedance2ConfigDraft,
  previous: Seedance2ConfigDraft,
): Record<string, unknown> {
  const config = serializeSeedance2Config(draft, previous);
  return {
    ...config,
    mode: normalizeHappyHorseMode(draft.mode),
    mode_user_set: true,
    resolution: draft.resolution === "720p" ? "720p" : "1080p",
    ratio: normalizeHappyHorseRatio(draft.ratio),
    generate_audio: false,
    generate_audio_user_set: false,
    return_last_frame: false,
    scene_optimize: "",
    human_review: false,
    human_review_user_set: false,
  };
}

function serializeGrokVideoConfig(
  draft: Seedance2ConfigDraft,
  previous: Seedance2ConfigDraft,
): Record<string, unknown> {
  const config = serializeSeedance2Config(draft, previous);
  return {
    ...config,
    mode: normalizeHappyHorseMode(draft.mode),
    mode_user_set: true,
    resolution: draft.resolution === "480p" ? "480p" : "720p",
    ratio: normalizeGrokVideoRatio(draft.ratio),
    generate_audio: false,
    generate_audio_user_set: false,
    return_last_frame: false,
    scene_optimize: "",
    human_review: false,
    human_review_user_set: false,
  };
}

function getSeedance2ConfigSaveKey(
  beatNumber: number,
  config: Record<string, unknown>,
): string {
  return `${beatNumber}:${JSON.stringify(config)}`;
}
