// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

const NON_SPEECH_LABELS = new Set([
  'bgm',
  'sfx',
  '持续时间',
  '负向约束',
  '环境音',
  '节奏',
  '配乐',
  '情绪',
  '时长',
  '时长匹配',
  '说明',
  '音乐',
  '音频类型',
  '音效',
  '语气',
  '语速',
]);

const BRACKETED_LABEL = /^\s*[【\[]\s*([^】\]]+?)\s*[】\]]\s*(.*)$/;
const CONTROL_LINE =
  /^\s*(?:[-*#]\s*)?(?:目标)?(?:时长|持续时间|情绪|节奏|语气|语速|音频类型|负向约束)\s*[:：]\s*.*$/i;
const BARE_DURATION = /^\s*\d+(?:\.\d+)?\s*(?:s|秒|seconds?)\s*$/i;
const TIMELINE_PREFIX =
  /^\s*(?:\[\s*)?(?:(?:\d{1,2}:)?\d{1,2}(?:\.\d+)?)\s*(?:-|–|—|~|至|→)\s*(?:(?:\d{1,2}:)?\d{1,2}(?:\.\d+)?)\s*(?:s|秒)?(?:\s*\])?\s*[:：-]?\s*/i;
const LEADING_STAGE_DIRECTIONS = /^(?:\s*[（(][^()（）\n]{1,80}[）)])+\s*/;
const MUSIC_INTENT =
  /(?:^|[\s_-])bgm(?:$|[\s_-])|background[_\s-]*music|背景音乐|配乐|纯音乐/i;
const SPEECH_GENERATION_INSTRUCTION =
  /(?:根据|基于|使用|提取|将).{0,40}(?:旁白|文案|脚本|广告词).{0,40}(?:生成|制作|转换|合成).{0,12}(?:旁白|配音|语音|音频)|(?:生成|制作).{0,20}(?:旁白配音|语音音频)/i;
const PLACEHOLDER_SPEECH_TEXT =
  /^(?:这是|本段(?:是|为)?|该段(?:是|为)?|this\s+is\s+)?(?:短剧|视频|广告)?(?:的\s*)?(?:第\s*(?:\d+|[一二三四五六七八九十]+)\s*(?:段|条|句)\s*)?(?:(?:the\s+)?(?:first|second|third)\s+)?(?:旁白|配音|解说|narration|voiceover)(?:内容|文本)?[。.!！]?$/i; // i18n-exempt -- parser vocabulary

type AudioKindSource = {
  audioKind?: 'speech' | 'music';
  displayName?: string;
  musicLengthMs?: number;
  title?: string;
  text?: string;
  workflowCatalog?: {
    timelineRole?: string;
    promptBuilder?: {
      userGoal?: string;
      planItem?: {
        id?: string;
        title?: string;
        audio_kind?: string;
        audioKind?: string;
      };
    };
  };
};

/** Recover legacy workflow nodes whose BGM intent was incorrectly stored as speech. */
export function resolveAudioKind(data: AudioKindSource): 'speech' | 'music' {
  if (data.audioKind === 'music') return 'music';
  const planItem = data.workflowCatalog?.promptBuilder?.planItem;
  const explicit = planItem?.audio_kind ?? planItem?.audioKind;
  if (explicit === 'music' || explicit === 'speech') return explicit;
  const searchable = [
    data.displayName,
    data.title,
    data.workflowCatalog?.timelineRole,
    planItem?.id,
    planItem?.title,
  ].filter(Boolean).join(' ');
  return MUSIC_INTENT.test(searchable) ? 'music' : (data.audioKind ?? 'speech');
}

export function isSpeechGenerationInstruction(value: string): boolean {
  return SPEECH_GENERATION_INSTRUCTION.test(String(value || '').trim());
}

function parseDurationMs(value: string): number | null {
  const text = String(value || '').toLowerCase();
  const minutes = text.match(/(\d+(?:\.\d+)?)\s*(?:分钟|分|min(?:ute)?s?)/i);
  if (minutes) return Number(minutes[1]) * 60_000;
  const seconds = text.match(/(\d+(?:\.\d+)?)\s*(?:秒|s(?:ec(?:ond)?s?)?)/i);
  return seconds ? Number(seconds[1]) * 1000 : null;
}

/** Generate one second beyond the requested video duration for trim/fade-out headroom. */
export function resolveMusicLengthMs(data: AudioKindSource): number | undefined {
  if (typeof data.musicLengthMs === 'number' && Number.isFinite(data.musicLengthMs)) {
    return Math.max(3_000, Math.min(Math.round(data.musicLengthMs), 600_000));
  }
  const goal = data.workflowCatalog?.promptBuilder?.userGoal ?? '';
  const targetMs = parseDurationMs(goal) ?? parseDurationMs(data.text ?? '');
  return targetMs == null
    ? undefined
    : Math.max(3_000, Math.min(Math.round(targetMs + 1_000), 600_000));
}

function normalizeLabel(value: string): string {
  return value.trim().replace(/\s+/g, '').toLowerCase();
}

function cleanSpeakableLine(value: string): string {
  return value
    .replace(TIMELINE_PREFIX, '')
    .replace(LEADING_STAGE_DIRECTIONS, '')
    .replace(/^\s*(?:[-*]\s+|#{1,6}\s*)/, '')
    .trim();
}

/**
 * Convert a mixed audio-production brief into text safe to send to TTS.
 * Duration, emotion, music and sound-effect instructions are control data and
 * must never be spoken.
 */
export function extractSpeakableAudioText(value: string): string {
  if (isSpeechGenerationInstruction(value) || PLACEHOLDER_SPEECH_TEXT.test(String(value || '').trim())) return '';
  const lines = String(value || '').split(/\r?\n/);
  let section: 'speech' | 'skip' | null = null;
  const output: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const labelled = line.match(BRACKETED_LABEL);
    if (labelled) {
      const label = normalizeLabel(labelled[1]);
      if (NON_SPEECH_LABELS.has(label)) {
        section = 'skip';
        continue;
      }
      section = 'speech';
      const spoken = cleanSpeakableLine(labelled[2]);
      if (spoken && !CONTROL_LINE.test(spoken) && !BARE_DURATION.test(spoken)) {
        output.push(spoken);
      }
      continue;
    }

    if (section === 'skip' || CONTROL_LINE.test(line) || BARE_DURATION.test(line)) {
      continue;
    }
    const spoken = cleanSpeakableLine(line);
    if (spoken) output.push(spoken);
  }

  return output.join('\n\n');
}
