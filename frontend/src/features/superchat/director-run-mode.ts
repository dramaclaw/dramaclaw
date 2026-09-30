import type { TaskState } from "@/task-center/types";

export type DirectorRunMode = "manual_confirm" | "episode_auto";
export type DirectorVoicePolicy = "system" | "custom";
export type DirectorAutoConfirmationStage =
  | "awaiting_start"
  | "awaiting_confirmation"
  | "awaiting_intervention"
  | "confirmed";

export interface DirectorAutoRunState {
  mode: DirectorRunMode;
  confirmationStage: DirectorAutoConfirmationStage;
  activatedAt: number;
  episode: number | null;
  handledKeys: string[];
  voicePolicy: DirectorVoicePolicy | null;
  voiceChoiceRequired: boolean;
  voicePrerequisiteErrors: string[];
}

export type DirectorAutoTaskDecision =
  | { action: "ignore" }
  | { action: "continue"; episode: number; key: string }
  | { action: "pause"; episode: number; key: string }
  | { action: "complete"; episode: number; key: string };

const STORAGE_PREFIX = "director.episodeRunMode";
const MAX_HANDLED_KEYS = 80;

const MAINLINE_EPISODE_TASK_TYPES = new Set([
  "build_episodes",
  "identity_planner",
  "character_portrait",
  "identity_image",
  "script_writer",
  "build_scenes",
  "scene_reference_asset",
  "prop_reference_asset",
  "sketch_grid_generation",
  "sketch_generation",
  "ai_identity_detection",
  "global_optimize_video",
  "selected_regen",
  "render_plan",
  "system_voice_setup",
  "audio_generation_indextts2",
  "single_video",
  "compose_episode",
]);

export function isDirectorAutoPipelineTask(task: TaskState): boolean {
  return MAINLINE_EPISODE_TASK_TYPES.has(task.task_type);
}

function storageKey(project: string): string {
  return `${STORAGE_PREFIX}:${project.trim() || "home"}`;
}

export function defaultDirectorRunState(): DirectorAutoRunState {
  return {
    mode: "manual_confirm",
    confirmationStage: "awaiting_start",
    activatedAt: 0,
    episode: null,
    handledKeys: [],
    voicePolicy: null,
    voiceChoiceRequired: false,
    voicePrerequisiteErrors: [],
  };
}

export function loadDirectorRunState(project: string): DirectorAutoRunState {
  if (typeof window === "undefined") return defaultDirectorRunState();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(project)) || "null") as
      | Partial<DirectorAutoRunState>
      | null;
    if (!parsed || parsed.mode !== "episode_auto") return defaultDirectorRunState();
    const savedConfirmationStage = parsed.confirmationStage;
    return {
      mode: "episode_auto",
      // Stored auto runs from before the confirmation gate must not bypass
      // the new explicit second-confirmation requirement after an upgrade.
      confirmationStage:
        savedConfirmationStage === "awaiting_start"
        || savedConfirmationStage === "awaiting_confirmation"
        || savedConfirmationStage === "awaiting_intervention"
        || savedConfirmationStage === "confirmed"
          ? savedConfirmationStage
          : "awaiting_start",
      activatedAt: Number.isFinite(parsed.activatedAt) ? Number(parsed.activatedAt) : Date.now(),
      episode: Number.isInteger(parsed.episode) && Number(parsed.episode) > 0
        ? Number(parsed.episode)
        : null,
      handledKeys: Array.isArray(parsed.handledKeys)
        ? parsed.handledKeys.filter((item): item is string => typeof item === "string").slice(-MAX_HANDLED_KEYS)
        : [],
      voicePolicy: parsed.voicePolicy === "system" || parsed.voicePolicy === "custom"
        ? parsed.voicePolicy
        : null,
      voiceChoiceRequired: parsed.voiceChoiceRequired === true,
      voicePrerequisiteErrors: Array.isArray(parsed.voicePrerequisiteErrors)
        ? parsed.voicePrerequisiteErrors.filter((item): item is string => typeof item === "string").slice(0, 8)
        : [],
    };
  } catch {
    return defaultDirectorRunState();
  }
}

export function saveDirectorRunState(project: string, state: DirectorAutoRunState): void {
  if (typeof window === "undefined") return;
  if (state.mode === "manual_confirm") {
    window.localStorage.removeItem(storageKey(project));
    return;
  }
  window.localStorage.setItem(storageKey(project), JSON.stringify({
    ...state,
    handledKeys: state.handledKeys.slice(-MAX_HANDLED_KEYS),
  }));
}

export function activateDirectorEpisodeAuto(): DirectorAutoRunState {
  return {
    mode: "episode_auto",
    confirmationStage: "awaiting_start",
    activatedAt: Date.now(),
    episode: null,
    handledKeys: [],
    voicePolicy: null,
    voiceChoiceRequired: false,
    voicePrerequisiteErrors: [],
  };
}

export function awaitDirectorEpisodeAutoConfirmation(
  state: DirectorAutoRunState,
): DirectorAutoRunState {
  return {
    ...state,
    confirmationStage: "awaiting_confirmation",
  };
}

export function confirmDirectorEpisodeAuto(
  state: DirectorAutoRunState,
): DirectorAutoRunState {
  return {
    ...state,
    confirmationStage: "confirmed",
    activatedAt: Date.now(),
  };
}

export function isDirectorEpisodeAutoConfirmed(state: DirectorAutoRunState): boolean {
  return state.mode === "episode_auto" && state.confirmationStage === "confirmed";
}

export function isDirectorEpisodeAutoSession(state: DirectorAutoRunState): boolean {
  return state.mode === "episode_auto"
    && (state.confirmationStage === "confirmed"
      || state.confirmationStage === "awaiting_intervention");
}

const AUTO_START_INTENT_RE = /(?:开始|启动|执行|推进|继续|确认|同意|可以(?:开始)?|开始吧|继续吧|确认吧)/u;
const AUTO_NEGATED_START_RE = /(?:不要|别|暂不|先不|取消|停止|暂停).{0,4}(?:开始|启动|执行|推进|继续|确认)/u;

export function isDirectorEpisodeAutoStartIntent(text: string): boolean {
  const normalized = text.trim();
  return normalized.length > 0
    && AUTO_START_INTENT_RE.test(normalized)
    && !AUTO_NEGATED_START_RE.test(normalized);
}

export function directorAutoConfirmationTransportText(
  text: string,
  options: { voiceChoiceRequired?: boolean; voiceErrors?: string[] } = {},
): string {
  const voiceInstruction = options.voiceChoiceRequired
    ? " Before starting, the user must choose a voice policy. Explicitly present both Chinese choices: " +
      "‘1）缺失声线由虾导自动匹配系统声线；2）我会到「虾塘」上传或录制自定义声线。’ " +
      `${options.voiceErrors?.length ? `Known missing items: ${options.voiceErrors.join("；")}. ` : ""}` +
      "Ask the user to reply 系统声线 or 自定义声线; do not start yet."
    : " Then ask the user to reply 继续 or 确认 to start.";
  return `${text}\n\n[DRAMACLAW_RUN_MODE_CONFIRMATION]\n`+
    "The user selected 本集自动 but has not completed the required second confirmation. " +
    "Do not call any write, generation, or mutation tool in this turn. Reply briefly in Chinese: " +
    "state that 本集自动 will safely advance the current episode until the final composition is " +
    "complete, and will pause on failure, unmet prerequisites, destructive or ambiguous actions, " +
    `or choices that require the user.${voiceInstruction}\n` +
    "[/DRAMACLAW_RUN_MODE_CONFIRMATION]";
}

export function resolveDirectorVoicePolicy(text: string): DirectorVoicePolicy | null {
  const normalized = text.trim();
  const system = /(?:系统声(?:线|音|一)|系统配音|虾导匹配)/u.test(normalized);
  const custom = /(?:自定义声(?:线|音)|上传(?:或录制)?|录制声线|声音采样|自定义配音)/u.test(normalized);
  if (system === custom) return null;
  return system ? "system" : "custom";
}

export function emphasizeDirectorVoiceChoiceLabels(text: string): string {
  if (
    !text.includes("系统声线")
    || !text.includes("自定义声线")
    || !/(?:请回复|请选择|你选哪种|选一个)/u.test(text)
  ) {
    return text;
  }
  const labels = ["系统声线", "自定义声线"] as const;
  return labels.reduce((current, label, index) => {
    const placeholder = `\uE000director-voice-${index}\uE001`;
    return current
      .split(`**${label}**`).join(placeholder)
      .split(label).join(`**${label}**`)
      .split(placeholder).join(`**${label}**`);
  }, text);
}

export function directorAutoVoiceChoiceTransportText(text: string): string {
  return `${text}\n\n[DRAMACLAW_VOICE_POLICY_REQUIRED]\n`+
    "Do not start episode auto and do not call generation tools. The user's voice policy is still " +
    "unclear. Ask only: ‘请选择：1）缺失声线由虾导自动匹配系统声线；2）我会到「虾塘」上传或录制自定义声线。’ " +
    "Ask them to reply 系统声线 or 自定义声线.\n[/DRAMACLAW_VOICE_POLICY_REQUIRED]";
}

export function markDirectorAutoHandled(
  state: DirectorAutoRunState,
  key: string,
  episode?: number,
): DirectorAutoRunState {
  return {
    ...state,
    episode: state.episode ?? (episode && episode > 0 ? episode : null),
    handledKeys: [...state.handledKeys.filter((item) => item !== key), key].slice(-MAX_HANDLED_KEYS),
  };
}

export function directorAutoRunTransportText(text: string): string {
  return `${text}\n\n[DRAMACLAW_RUN_MODE]\nmode=episode_auto\n`+
    "The user enabled 本集自动 in the outer 虾导 UI. Treat this as approval to select and start " +
    "the next safe mainline step without asking for per-step confirmation. Keep the one-write-per-turn " +
    "limit. Before any write, inspect the current artifact and the latest task for that exact step. " +
    "If the artifact is merely missing and prerequisites are ready, start its generation. Do not let " +
    "an unrelated or superseded historical failed task block a missing safe step. Pause only when the " +
    "latest attempt for the current required step failed or was cancelled. Stop for destructive " +
    "overwrite/delete, missing voice choice, ambiguity, or unmet prerequisites. Never describe one " +
    "task as failed and then silently proceed as though that same attempt succeeded. " +
    "If this user-authored message may change, redo, replace, or reconfigure project output, do not " +
    "perform that mutation yet. First call dramaclaw_control_episode_auto(action='suspend', reason=...) " +
    "and ask the user to confirm the intended change. Questions, explanations, and progress checks do " +
    "not require suspension. If the user explicitly asks to stop automatic production, call " +
    "dramaclaw_control_episode_auto(action='pause'). Never cancel an already queued or running media " +
    "task unless the user separately and explicitly confirms cancellation. This mode never " +
    "applies Agent-credit billing. The durable auto coordinator is already running now: do not merely " +
    "describe what 本集自动 will do in the future. Inspect current state, report the concrete active " +
    "task or start the next safe task, and say clearly that automatic production has started.\n" +
    "[/DRAMACLAW_RUN_MODE]";
}

export function directorAutoUserMessageTransportText(text: string): string {
  return `${text}\n\n[DRAMACLAW_AUTO_USER_MESSAGE]\n`+
    "The durable backend already owns progression of the active outer 虾导 episode auto run. First " +
    "understand the user's actual intent; do not start the next mainline task merely because this " +
    "message arrived. For a question, explanation, result view, or progress/status request, answer or " +
    "read only and leave automatic progression running. If the message may change, redo, replace, or " +
    "reconfigure project output, call dramaclaw_control_episode_auto(action='suspend', reason=...) " +
    "before asking for confirmation, and do not perform the mutation in this turn. If the user " +
    "explicitly asks to stop or switch to manual mode, call " +
    "dramaclaw_control_episode_auto(action='pause'). Never cancel a queued or running generation task " +
    "unless the user explicitly confirms cancellation of that exact task.\n" +
    "[/DRAMACLAW_AUTO_USER_MESSAGE]";
}

export function directorAutoInterventionTransportText(text: string): string {
  return `${text}\n\n[DRAMACLAW_AUTO_INTERVENTION_CONFIRMATION]\n`+
    "The outer 虾导 episode auto run is suspended while waiting for the user's answer about a possible " +
    "modification. Interpret the answer semantically. If the user declines/cancels the modification or " +
    "asks to keep the original result and continue automatically, call " +
    "dramaclaw_control_episode_auto(action='resume') and acknowledge that automatic production resumed. " +
    "If the user confirms the modification, first call " +
    "dramaclaw_control_episode_auto(action='pause') to leave automatic mode, then handle at most one " +
    "confirmed project mutation under normal one-write-per-turn rules. If the answer is ambiguous, ask " +
    "one concise follow-up " +
    "and keep the run suspended. A queued or running generation task must continue by default and must " +
    "not be cancelled unless the user explicitly confirms cancelling that exact task.\n" +
    "[/DRAMACLAW_AUTO_INTERVENTION_CONFIRMATION]";
}

function taskTimestamp(task: TaskState): number {
  const value = Date.parse(task.updated_at || task.completed_at || task.created_at || "");
  return Number.isFinite(value) ? value : 0;
}

export function decideDirectorAutoTask(
  state: DirectorAutoRunState,
  task: TaskState,
  options: {
    key?: string;
    batchTerminal?: boolean;
    batchFailed?: boolean;
  } = {},
): DirectorAutoTaskDecision {
  if (!isDirectorEpisodeAutoConfirmed(state)) return { action: "ignore" };
  if (!isDirectorAutoPipelineTask(task)) return { action: "ignore" };
  // Episode planning is a project-level task (episode=0). Once it finishes,
  // 本集自动 enters the newly planned pipeline at episode 1.
  const episode = task.episode > 0
    ? task.episode
    : state.episode ?? (task.task_type === "build_episodes" ? 1 : null);
  if (!episode) return { action: "ignore" };
  if (task.episode > 0 && state.episode !== null && state.episode !== task.episode) {
    return { action: "ignore" };
  }
  if (taskTimestamp(task) < state.activatedAt) return { action: "ignore" };

  const key = options.key || `${task.status}:${task.task_key || task.task_id}`;
  if (state.handledKeys.includes(key)) return { action: "ignore" };
  if (options.batchTerminal === false) return { action: "ignore" };
  if (options.batchFailed || task.status === "failed" || task.status === "cancelled") {
    return { action: "pause", episode, key };
  }
  if (task.status !== "completed") return { action: "ignore" };
  if (task.task_type === "compose_episode") {
    return { action: "complete", episode, key };
  }
  return { action: "continue", episode, key };
}
